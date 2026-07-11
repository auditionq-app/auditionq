import "dotenv/config";
import { S3Client, HeadObjectCommand } from "@aws-sdk/client-s3";

const s3Client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID as string,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY as string,
  },
});

async function main() {
  const result = await s3Client.send(
    new HeadObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: "videos/contenttype-test-1/video.mp4", // adjust to your actual key
    })
  );
  console.log("ContentType:", result.ContentType);
}

main();