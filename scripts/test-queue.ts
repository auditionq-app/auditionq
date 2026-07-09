import { videoProcessingQueue } from "../src/lib/queue";

async function main() {
  const job = await videoProcessingQueue.add("process-video", {
    videoId: "test-video-id",
    userId: "test-user-id",
    rawKey: "raw/test-user-id/test.mp4",
  });
  console.log("Job added:", job.id);
  process.exit(0);
}

main();