import "dotenv/config";
import { saveFile, getFileUrl, deleteFile } from "../src/lib/storage";

async function main(): Promise<void> {
  const testKey = "raw/test-user/test-file.txt";
  const testContent = Buffer.from("Hello from the storage adapter test.");

  console.log("Saving file...");
  await saveFile(testKey, testContent);
  console.log("Saved.");

  console.log("Getting signed URL...");
  const url = await getFileUrl(testKey);
  console.log("Signed URL:", url);

  console.log("Deleting file...");
  await deleteFile(testKey);
  console.log("Deleted.");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});