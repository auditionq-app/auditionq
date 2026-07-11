import "dotenv/config";
import { readFile } from "fs/promises";
import { randomUUID } from "crypto";
import { saveFile } from "../src/lib/storage";
import { db } from "../src/lib/db";
import { videoProcessingQueue } from "../src/lib/queue";

const LOCAL_FILE_PATH = "/home/vonnue/Desktop/sampleVid/Sample.webm";
const TEST_USER_ID = "test-user-worker";

async function main(): Promise<void> {
  console.log("Reading local file...");
  const buffer = await readFile(LOCAL_FILE_PATH);

  const rawKey = `raw/${TEST_USER_ID}/${randomUUID()}.webm`;

  console.log("Uploading raw file to R2...");
  await saveFile(rawKey, buffer);
  console.log("Uploaded to:", rawKey);

  console.log("Ensuring User row exists...");
  await db.user.upsert({
    where: { id: TEST_USER_ID },
    create: { id: TEST_USER_ID },
    update: {},
  });

  console.log("Creating Video row...");
  const video = await db.video.upsert({
    where: { userId: TEST_USER_ID },
    create: {
      userId: TEST_USER_ID,
      status: "processing",
      rawKey,
    },
    update: {
      status: "processing",
      rawKey,
      videoKey: null,
      thumbnailKey: null,
      errorMessage: null,
    },
  });
  console.log("Video row id:", video.id);

  console.log("Enqueueing job...");
  const job = await videoProcessingQueue.add("process-video", {
    videoId: video.id,
    userId: TEST_USER_ID,
    rawKey,
  });
  console.log("Job enqueued:", job.id);

  process.exit(0);
}

main().catch((err) => {
  console.error("Test setup failed:", err);
  process.exit(1);
});