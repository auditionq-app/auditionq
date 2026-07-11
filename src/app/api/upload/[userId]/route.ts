import { NextRequest, NextResponse } from "next/server";
import { writeFile, unlink, mkdir } from "fs/promises";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
import ffmpeg from "fluent-ffmpeg";
import { db } from "@/lib/db";
import { saveFile, deleteFile } from "@/lib/storage";
import { videoProcessingQueue } from "@/lib/queue";

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB
const MAX_DURATION_SECONDS = 60;
const RATE_LIMIT_WINDOW_MS = 5000;

// Simple in-memory rate limiting: track last upload attempt per user
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

function getDurationSeconds(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(new Error(`ffprobe failed: ${err.message}`));
        return;
      }

      const duration = metadata.format.duration;
      if (typeof duration !== "number") {
        reject(new Error("Could not determine video duration."));
        return;
      }

      resolve(duration);
    });
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

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return errorResponse("Invalid form data.", 400);
  }

  const file = formData.get("video");

  if (!(file instanceof File)) {
    return errorResponse("A video file is required.", 400);
  }

  if (!file.type.startsWith("video/")) {
    return errorResponse("File must be a video.", 400);
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    return errorResponse(
      `File is too large. Maximum size is ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB.`,
      400
    );
  }

  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const extension = path.extname(file.name) || ".mp4";
  const rawKey = `raw/${userId}/${randomUUID()}${extension}`;

  const tempDir = path.join(os.tmpdir(), `upload-check-${randomUUID()}`);
  const tempFilePath = path.join(tempDir, `raw${extension}`);

  try {
    await mkdir(tempDir, { recursive: true });
    await writeFile(tempFilePath, buffer);

    let duration: number;
    try {
      duration = await getDurationSeconds(tempFilePath);
    } catch (error) {
      return errorResponse(
        `Could not read video metadata: ${(error as Error).message}`,
        400
      );
    }

    if (duration > MAX_DURATION_SECONDS) {
      return errorResponse(
        "Video exceeds 60 seconds — please upload a version trimmed to the correct length.",
        400
      );
    }

    try {
      await saveFile(rawKey, buffer);
    } catch (error) {
      return errorResponse(
        `Failed to save file: ${(error as Error).message}`,
        500
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

      await db.video.update({
        where: { id: video.id },
        data: {
          status: "failed",
          errorMessage: "Failed to queue processing job. Please try uploading again.",
          rawKey: null,
        },
      }).catch(() => {
        // If even this fails, the row stays in "processing" — a real edge case,
        // but not one we can recover from cleanly here.
      });

      return errorResponse(
        `Failed to queue processing job: ${(error as Error).message}`,
        500
      );
    }

    return NextResponse.json({ videoId: video.id }, { status: 202 });
  } finally {
    await unlink(tempFilePath).catch(() => {
      // Best-effort cleanup.
    });
  }
}