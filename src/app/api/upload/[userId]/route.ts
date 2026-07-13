import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import path from "path";
import Busboy from "busboy";
import { Readable, PassThrough } from "stream";
import { db } from "@/lib/db";
import { saveFileStream, deleteFile } from "@/lib/storage";
import { videoProcessingQueue } from "@/lib/queue";

const MAX_FILE_SIZE_BYTES = 400 * 1024 * 1024; // 400MB
const RATE_LIMIT_WINDOW_MS = 5000;

const lastUploadAttempt = new Map<string, number>();

function isRateLimited(userId: string): boolean {
  const now = Date.now();
  const last = lastUploadAttempt.get(userId);

  if (last !== undefined && now - last < RATE_LIMIT_WINDOW_MS) {
    return true;
  }

  lastUploadAttempt.set(userId, now);
  return false;
}

function errorResponse(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

interface ParsedUpload {
  stream: PassThrough;
  filename: string;
  mimeType: string;
  sizeExceeded: () => boolean;
}

function parseMultipartStream(
  request: NextRequest
): Promise<ParsedUpload> {
  return new Promise((resolve, reject) => {
    const contentType = request.headers.get("content-type");

    if (!contentType) {
      reject(new Error("Missing content-type header."));
      return;
    }

    const busboy = Busboy({
      headers: { "content-type": contentType },
      limits: { fileSize: MAX_FILE_SIZE_BYTES },
    });

    let resolved = false;
    let exceeded = false;

    busboy.on("file", (fieldname, fileStream, info) => {
      if (fieldname !== "video") {
        fileStream.resume(); // discard unrelated fields
        return;
      }

      const passThrough = new PassThrough();
      fileStream.pipe(passThrough);

      fileStream.on("limit", () => {
        exceeded = true;
      });

      if (!resolved) {
        resolved = true;
        resolve({
          stream: passThrough,
          filename: info.filename,
          mimeType: info.mimeType,
          sizeExceeded: () => exceeded,
        });
      }
    });

    busboy.on("error", (err) => {
      reject(err instanceof Error ? err : new Error("Busboy parsing error."));
    });

    if (!request.body) {
      reject(new Error("Request has no body."));
      return;
    }

    const nodeStream = Readable.fromWeb(
      request.body as unknown as import("stream/web").ReadableStream
    );
    nodeStream.pipe(busboy);
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
): Promise<NextResponse> {
  const { userId } = await params;

  if (!userId || !userId.trim()) {
    return errorResponse("A userId is required.", 400);
  }

  if (isRateLimited(userId)) {
    return errorResponse("Too many upload attempts. Please wait a few seconds.", 429);
  }

  let parsed: ParsedUpload;
  try {
    parsed = await parseMultipartStream(request);
  } catch (error) {
    return errorResponse(
      `Invalid upload request: ${(error as Error).message}`,
      400
    );
  }

  if (!parsed.mimeType.startsWith("video/")) {
    parsed.stream.resume(); // drain the stream so the connection can close cleanly
    return errorResponse("File must be a video.", 400);
  }

  const extension = path.extname(parsed.filename) || ".mp4";
  const rawKey = `raw/${userId}/${randomUUID()}${extension}`;

  try {
    await saveFileStream(rawKey, parsed.stream, parsed.mimeType);
  } catch (error) {
    return errorResponse(
      `Failed to save file: ${(error as Error).message}`,
      500
    );
  }

  if (parsed.sizeExceeded()) {
    await deleteFile(rawKey).catch(() => {
      // Best-effort cleanup.
    });
    return errorResponse(
      `File is too large. Maximum size is ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB.`,
      400
    );
  }

  let video;
  try {
    await db.user.upsert({
      where: { id: userId },
      create: { id: userId },
      update: {},
    });

    video = await db.video.upsert({
      where: { userId },
      create: {
        userId,
        status: "processing",
        rawKey,
      },
      update: {
        status: "processing",
        rawKey,
        errorMessage: null,
      },
    });
  } catch (error) {
    await deleteFile(rawKey).catch(() => {
      // Best-effort cleanup; the DB error is the primary failure.
    });
    return errorResponse(
      `Failed to create database record: ${(error as Error).message}`,
      500
    );
  }

  try {
    await videoProcessingQueue.add(
      "process-video",
      { videoId: video.id, userId, rawKey },
      {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 2000,
        },
      }
    );
  } catch (error) {
    await deleteFile(rawKey).catch(() => {
      // Best-effort cleanup.
    });

    await db.video
      .update({
        where: { id: video.id },
        data: {
          status: "failed",
          errorMessage: "Failed to queue processing job. Please try uploading again.",
          rawKey: null,
        },
      })
      .catch(() => {
        // If even this fails, the row stays in "processing" — a real edge case.
      });

    return errorResponse(
      `Failed to queue processing job: ${(error as Error).message}`,
      500
    );
  }

  return NextResponse.json({ videoId: video.id }, { status: 202 });
}