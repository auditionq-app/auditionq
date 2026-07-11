import "dotenv/config";
import { getFile } from "../src/lib/storage";

const VIDEO_KEY = "videos/test-user-worker/video.mp4";

async function main(): Promise<void> {
  const videoBuffer = await getFile(VIDEO_KEY);
  const sizeMB = videoBuffer.length / (1024 * 1024);
  console.log(`Processed video size: ${sizeMB.toFixed(2)} MB`);
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});