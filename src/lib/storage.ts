import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Upload } from "@aws-sdk/lib-storage";
import type { Readable } from "stream";


const requiredEnvVars = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_NAME",
] as const;

for (const key of requiredEnvVars) {
  if (!process.env[key]) {
    throw new Error(`${key} is not set.`);
  }
}

const accountId = process.env.R2_ACCOUNT_ID as string;
const bucketName = process.env.R2_BUCKET_NAME as string;

const s3Client = new S3Client({
  region: "auto",
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID as string,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY as string,
  },
});

export async function saveFile(
  key: string,
  buffer: Buffer,
  contentType?: string
): Promise<void> {
  if (!key.trim()) {
    throw new Error("A storage key is required to save a file.");
  }

  if (buffer.length === 0) {
    throw new Error("Cannot save an empty file.");
  }

  try {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      })
    );
  } catch (error) {
    throw new Error(`Failed to save file at key "${key}": ${(error as Error).message}`);
  }
}

export async function saveFileStream(
  key: string,
  stream: Readable,
  contentType?: string
): Promise<void> {
  if (!key.trim()) {
    throw new Error("A storage key is required to save a file.");
  }

  try {
    const upload = new Upload({
      client: s3Client,
      params: {
        Bucket: bucketName,
        Key: key,
        Body: stream,
        ContentType: contentType,
      },
    });

    await upload.done();
  } catch (error) {
    throw new Error(
      `Failed to stream file to key "${key}": ${(error as Error).message}`
    );
  }
}

export async function getFileUrl(key: string): Promise<string> {
  if (!key.trim()) {
    throw new Error("A storage key is required to get a file URL.");
  }

  try {
    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: key,
    });

    return await getSignedUrl(s3Client, command, { expiresIn: 3600 });
  } catch (error) {
    throw new Error(`Failed to generate signed URL for key "${key}": ${(error as Error).message}`);
  }
}

export async function getFile(key: string): Promise<Buffer> {
  if (!key.trim()) {
    throw new Error("A storage key is required to get a file.");
  }

  try {
    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: key,
    });

    const response = await s3Client.send(command);
    const body = response.Body;

    if (!body) {
      throw new Error("No file body returned from R2.");
    }

    const chunks: Uint8Array[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }

    return Buffer.concat(chunks);
  } catch (error) {
    throw new Error(`Failed to get file at key "${key}": ${(error as Error).message}`);
  }
}

export async function deleteFile(key: string): Promise<void> {
  if (!key.trim()) {
    throw new Error("A storage key is required to delete a file.");
  }

  try {
    await s3Client.send(
      new DeleteObjectCommand({
        Bucket: bucketName,
        Key: key,
      })
    );
  } catch (error) {
    throw new Error(`Failed to delete file at key "${key}": ${(error as Error).message}`);
  }
}