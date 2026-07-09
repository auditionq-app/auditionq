import { NextRequest, NextResponse } from "next/server";
import { saveFile, deleteFile } from "@/lib/storage";
import { db } from "@/lib/db";

const MAX_FILE_SIZE_MB = 50;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

// Simple in-memory rate limiting: track upload attempts per user
const uploadAttempts = new Map<string, number[]>();

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

function isRateLimited(userId: string): boolean {
  const now = Date.now();
  const attempts = uploadAttempts.get(userId) ?? [];
  const recentAttempts = attempts.filter((time) => now - time < 10000);

  if (
    recentAttempts.length > 0 &&
    now - recentAttempts[recentAttempts.length - 1] < 5000
  ) {
    return true;
  }

  recentAttempts.push(now);
  uploadAttempts.set(userId, recentAttempts);
  return false;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
): Promise<NextResponse> {
  try {
    const { userId } = await params;

    if (!userId) {
      return jsonError("userId is required.", 400);
    }

    const userExists = await db.user.findUnique({ where: { id: userId } });
    if (!userExists) {
      return jsonError("User not found.", 404);
    }

    if (isRateLimited(userId)) {
      return jsonError("Too many upload attempts. Please wait a few seconds.", 429);
    }

    const formData = await request.formData();
    const videoFile = formData.get("video") as File | null;

    if (!videoFile) {
      return jsonError("Video file is required.", 400);
    }

    if (videoFile.size > MAX_FILE_SIZE_BYTES) {
      return jsonError(
        `Video file is too large. Maximum size is ${MAX_FILE_SIZE_MB}MB.`,
        400
      );
    }

    if (videoFile.type !== "video/mp4") {
      return jsonError("Video must be in MP4 format.", 400);
    }

    const videoBuffer = Buffer.from(await videoFile.arrayBuffer());

    let videoKey: string | null = null;

    try {
      videoKey = await saveFile(userId, videoBuffer, "mp4");
    } catch (saveError) {
      console.error("Disk write failure during upload:", saveError);
      return jsonError("Failed to save uploaded file.", 500);
    }

    const oldVideo = await db.video.findUnique({ where: { userId } });

    let video: Awaited<ReturnType<typeof db.video.upsert>>;
    try {
      video = await db.video.upsert({
        where: { userId },
        update: {
          filePath: videoKey,
          thumbPath: null,
          duration: null,
          fileSizeBytes: videoFile.size,
        },
        create: {
          userId,
          filePath: videoKey,
          thumbPath: null,
          duration: null,
          fileSizeBytes: videoFile.size,
        },
      });
    } catch (dbError) {
      await deleteFile(userId, videoKey).catch(() => {
        /* ignore deletion errors */
      });
      throw dbError;
    }

    if (oldVideo) {
      if (oldVideo.filePath !== videoKey) {
        await deleteFile(userId, oldVideo.filePath).catch(() => {
          /* ignore deletion errors */
        });
      }
      if (oldVideo.thumbPath) {
        await deleteFile(userId, oldVideo.thumbPath).catch(() => {
          /* ignore deletion errors */
        });
      }
    }

    return NextResponse.json(
      { videoId: video.id, filePath: video.filePath, userId },
      { status: 200 }
    );
  } catch (err) {
    console.error("Upload error:", err);
    return jsonError("Upload failed. Please try again.", 500);
  }
}