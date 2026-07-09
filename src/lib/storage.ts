import { mkdir, unlink, writeFile } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";

const DATA_ROOT = path.join(process.cwd(), "data");
const VIDEO_ROOT = path.join(DATA_ROOT, "videos");

function normalizeExtension(ext: string): string {
  const trimmedExt = ext.trim().replace(/^\./, "");

  if (!trimmedExt) {
    throw new Error("File extension is required.");
  }

  return trimmedExt;
}

function getRelativeKey(userId: string, fileName: string): string {
  return path.posix.join("videos", userId, fileName);
}

function getUserPrefix(userId: string): string {
  return path.posix.join("videos", userId) + "/";
}

export async function saveFile(userId: string, buffer: Buffer, ext: string): Promise<string> {
  if (!userId.trim()) {
    throw new Error("User ID is required to save a file.");
  }

  if (buffer.length === 0) {
    throw new Error("Cannot save an empty file.");
  }

  const normalizedExt = normalizeExtension(ext);
  const fileName = `${randomUUID()}.${normalizedExt}`;
  const directoryPath = path.join(VIDEO_ROOT, userId);
  const filePath = path.join(directoryPath, fileName);

  await mkdir(directoryPath, { recursive: true });
  await writeFile(filePath, buffer);

  return getRelativeKey(userId, fileName);
}

export function getFilePath(userId: string, key: string): string {
  if (!key.trim()) {
    throw new Error("File key is required.");
  }

  const expectedPrefix = getUserPrefix(userId);
  if (!key.startsWith(expectedPrefix)) {
    throw new Error("File key does not belong to this user.");
  }

  return path.join(DATA_ROOT, key);
}

export async function deleteFile(userId: string, key: string): Promise<void> {
  const filePath = getFilePath(userId, key);

  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }

    throw new Error(`Failed to delete file at ${key}.`);
  }
}