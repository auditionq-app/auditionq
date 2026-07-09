import { Queue } from "bullmq";

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
  throw new Error("REDIS_URL is not set.");
}

export interface VideoProcessingJobData {
  videoId: string;
  userId: string;
  rawKey: string;
}

export const videoProcessingQueue: Queue<VideoProcessingJobData> = new Queue(
  "video-processing",
  {
    connection: {
      url: redisUrl,
    },
  }
);