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
  done: Promise<void>;
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

    let settled = false;
    let exceeded = false;
    let videoFieldSeen = false;
    let activeStream: PassThrough | null = null;
    let requestEnded = false;

    let finalizeDoneResolve: (() => void) | null = null;
    let finalizeDoneReject: ((err: Error) => void) | null = null;
    const done = new Promise<void>((doneResolve, doneReject) => {
      finalizeDoneResolve = doneResolve;
      finalizeDoneReject = doneReject;
    });

    function settleResolve(value: ParsedUpload): void {
      if (settled) return;
      settled = true;
      resolve(value);
    }

    function settleReject(err: Error): void {
      if (!settled) {
        settled = true;
        if (finalizeDoneReject) {
          finalizeDoneReject(err);
          finalizeDoneReject = null;
          finalizeDoneResolve = null;
        }
        reject(err);
        return;
      }

      // Already resolved and handed a stream to the caller — the only way
      // to surface a late error now is to fail that stream directly, so
      // whatever is consuming it (e.g. the R2 upload) gets a real error
      // instead of hanging or silently succeeding on a corrupt/partial file.
      if (activeStream && !activeStream.destroyed) {
        activeStream.destroy(err);
      }

      if (finalizeDoneReject) {
        finalizeDoneReject(err);
        finalizeDoneReject = null;
        finalizeDoneResolve = null;
      }
    }

    busboy.on("file", (fieldname, fileStream, info) => {
      if (fieldname !== "video") {
        fileStream.resume(); // discard unrelated fields
        return;
      }

      if (videoFieldSeen) {
        fileStream.resume();
        settleReject(new Error("Multiple video fields received; only one is allowed."));
        return;
      }

      videoFieldSeen = true;

      const passThrough = new PassThrough();
      activeStream = passThrough;

      fileStream.on("error", (err) => {
        settleReject(err instanceof Error ? err : new Error("File stream error."));
      });

      fileStream.pipe(passThrough);

      fileStream.on("limit", () => {
        exceeded = true;
      });

      settleResolve({
        stream: passThrough,
        filename: info.filename,
        mimeType: info.mimeType,
        sizeExceeded: () => exceeded,
        done,
      });
    });

    busboy.on("error", (err) => {
      settleReject(err instanceof Error ? err : new Error("Busboy parsing error."));
    });

    busboy.on("finish", () => {
      if (!videoFieldSeen) {
        settleReject(new Error("No video field found in the upload."));
        return;
      }

      if (finalizeDoneResolve) {
        finalizeDoneResolve();
        finalizeDoneResolve = null;
        finalizeDoneReject = null;
      }
    });

    if (!request.body) {
      reject(new Error("Request has no body."));
      return;
    }

    const nodeStream = Readable.fromWeb(
      request.body as unknown as import("stream/web").ReadableStream
    );

    nodeStream.on("end", () => {
      requestEnded = true;
    });

    nodeStream.on("error", (err) => {
      settleReject(err instanceof Error ? err : new Error("Request stream error."));
    });

    nodeStream.on("close", () => {
      if (!requestEnded) {
        settleReject(new Error("Upload request closed before completion."));
      }
    });

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
    await parsed.done;
  } catch (error) {
    return errorResponse(
      `Failed to save file: ${(error as Error).message}`,
      500
    );
  }

  if (parsed.sizeExceeded()) {
    await deleteFile(rawKey).catch((err) => {
      console.error(`Failed to clean up oversized upload at ${rawKey}:`, err);
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