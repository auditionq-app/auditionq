import { Worker, Job } from "bullmq";
import { mkdir, rm } from "fs/promises";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
import ffmpeg from "fluent-ffmpeg";
import { db } from "../lib/db";
import { getFile, saveFile, deleteFile } from "../lib/storage";
import type { VideoProcessingJobData } from "../lib/queue";

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
  throw new Error("REDIS_URL is not set.");
}

const MAX_DURATION_SECONDS = 60;

function getVideoDurationSeconds(filePath: string): Promise<number> {
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

function transcodeToMp4(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .videoCodec("libx264")
      .audioCodec("aac")
      .audioBitrate("96k")
      .outputOptions([
        "-crf 27",
        "-preset medium",
        "-vf scale='min(1280,iw)':-2",
        "-movflags faststart",
      ])
      .on("end", () => resolve())
      .on("error", (err) => reject(new Error(`Transcoding failed: ${err.message}`)))
      .save(outputPath);
  });
}

function extractThumbnail(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .screenshots({
        timestamps: [1],
        filename: path.basename(outputPath),
        folder: path.dirname(outputPath),
      })
      .on("end", () => resolve())
      .on("error", (err) => reject(new Error(`Thumbnail extraction failed: ${err.message}`)));
  });
}

async function processJob(job: Job<VideoProcessingJobData>): Promise<void> {
  const { videoId, userId, rawKey } = job.data;

  const tempDir = path.join(os.tmpdir(), `video-${randomUUID()}`);
  await mkdir(tempDir, { recursive: true });

  const rawExtension = path.extname(rawKey) || ".mp4";
  const rawLocalPath = path.join(tempDir, `raw${rawExtension}`);
  const outputVideoPath = path.join(tempDir, "video.mp4");
  const outputThumbnailPath = path.join(tempDir, "thumb.jpg");

  try {
    const rawBuffer = await getFile(rawKey);
    const { writeFile } = await import("fs/promises");
    await writeFile(rawLocalPath, rawBuffer);

    const duration = await getVideoDurationSeconds(rawLocalPath);
    if (duration > MAX_DURATION_SECONDS) {
      throw new Error(
        `Video exceeds ${MAX_DURATION_SECONDS} seconds (safety check in worker).`
      );
    }

    await transcodeToMp4(rawLocalPath, outputVideoPath);
    await extractThumbnail(rawLocalPath, outputThumbnailPath);

    const { readFile } = await import("fs/promises");
    const videoBuffer = await readFile(outputVideoPath);
    const thumbnailBuffer = await readFile(outputThumbnailPath);

    const videoKey = `videos/${userId}/video.mp4`;
    const thumbnailKey = `videos/${userId}/thumb.jpg`;

    await saveFile(videoKey, videoBuffer, "video/mp4");
    await saveFile(thumbnailKey, thumbnailBuffer, "image/jpeg");

    await db.video.update({
      where: { id: videoId },
      data: {
        status: "ready",
        videoKey,
        thumbnailKey,
        duration: Math.round(duration),
        rawKey: null,
        errorMessage: null,
      },
    });

    await deleteFile(rawKey);
} catch (error) {
    const message = error instanceof Error ? error.message : "Unknown processing error.";

    const maxAttempts = job.opts.attempts ?? 1;
    const isFinalAttempt = job.attemptsMade + 1 >= maxAttempts;

    if (isFinalAttempt) {
      await db.video.update({
        where: { id: videoId },
        data: {
          status: "failed",
          errorMessage: message,
        },
      });
    }

    throw error;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {
      // Best-effort cleanup; ignore errors here.
    });
  }
}

const worker = new Worker<VideoProcessingJobData>(
  "video-processing",
  processJob,
  {
    connection: { url: redisUrl },
    concurrency: 1,
  }
);

worker.on("completed", (job) => {
  console.log(`Job ${job.id} completed for video ${job.data.videoId}.`);
});

worker.on("failed", (job, err) => {
  console.error(`Job ${job?.id} failed for video ${job?.data.videoId}:`, err.message);
});

console.log("Video processing worker started. Waiting for jobs...");