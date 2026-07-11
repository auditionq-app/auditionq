"use client";
import React from "react";
import Link from "next/link";
import { ChangeEvent, FormEvent, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";

type UploadStatus = "idle" | "processing" | "uploading" | "success" | "error";

const MAX_FILE_SIZE_MB = 400;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

function validateFileEarly(file: File): { valid: boolean; error?: string } {
  if (!file.type.startsWith("video/")) {
    return { valid: false, error: "File must be a video. Please select a valid video file." };
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    return {
      valid: false,
      error: `File is too large. Maximum size is ${MAX_FILE_SIZE_MB}MB.`,
    };
  }

  return { valid: true };
}

export default function UploadPage(): React.JSX.Element {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string>("");
  const [status, setStatus] = useState<UploadStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [profileUserId, setProfileUserId] = useState<string | null>(null);
  const currentPreviewUrl = useRef<string>("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const params = useParams();
  const userId = params.userId as string;

  useEffect(() => {
    return () => {
      if (currentPreviewUrl.current) {
        URL.revokeObjectURL(currentPreviewUrl.current);
      }
    };
  }, []);

  function updatePreview(file: File | null): void {
    if (currentPreviewUrl.current) {
      URL.revokeObjectURL(currentPreviewUrl.current);
      currentPreviewUrl.current = "";
    }

    if (!file) {
      setPreviewUrl("");
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    currentPreviewUrl.current = objectUrl;
    setPreviewUrl(objectUrl);
  }

  const isBusy = status === "processing" || status === "uploading";

  function handleFileChange(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0] ?? null;

    setSelectedFile(file);
    updatePreview(file);
    setStatus("idle");
    setErrorMessage("");
    setVideoDuration(null);
    setUploadProgress(0);
    setProfileUserId(null);

    if (!file) {
      return;
    }

    const validation = validateFileEarly(file);
    if (!validation.valid) {
      setStatus("error");
      setErrorMessage(validation.error || "Invalid file.");
      return;
    }

    checkDuration(file).catch((err) => {
        setStatus("error");
        setErrorMessage(err instanceof Error ? err.message : "Invalid video.");
    });
  }

  async function checkDuration(file: File): Promise<void> {
    const video = document.createElement("video");
    video.preload = "metadata";

    const duration = await new Promise<number>((resolve, reject) => {
        video.onloadedmetadata = () => {
        URL.revokeObjectURL(video.src);
        resolve(video.duration);
        };
        video.onerror = () => reject(new Error("Could not read video metadata."));
        video.src = URL.createObjectURL(file);
    });

    if (duration > 60) {
        throw new Error(
        `Video is ${Math.round(duration)}s long. Please upload a version 60 seconds or shorter.`
        );
    }

    setVideoDuration(duration);
}

  async function uploadWithProgress(formData: FormData): Promise<Response> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();

      xhr.open("POST", `/api/upload/${userId}`);
      xhr.responseType = "text";

      xhr.upload.onprogress = (event: ProgressEvent<EventTarget>): void => {
        if (event.lengthComputable) {
          const percent = Math.round((event.loaded / event.total) * 100);
          setUploadProgress(percent);
        }
      };

      xhr.onerror = (): void => {
        reject(new Error("Network error while uploading."));
      };

      xhr.onload = (): void => {
        const response = new Response(xhr.responseText, {
          status: xhr.status,
          statusText: xhr.statusText,
          headers: {
            "Content-Type": xhr.getResponseHeader("Content-Type") ?? "application/json",
          },
        });
        resolve(response);
      };

      xhr.send(formData);
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    if (!selectedFile) {
      setStatus("error");
      setErrorMessage("Choose a video file before continuing.");
      return;
    }

    if (videoDuration === null) {
      setStatus("error");
      setErrorMessage("Video processing is still in progress or failed. Please wait or select another file.");
      return;
    }

    setStatus("uploading");
    setErrorMessage("");
    setUploadProgress(0);
    setProfileUserId(null);

    try {
      const formData = new FormData();
      formData.append("video", selectedFile);

      const response = await uploadWithProgress(formData);

      const data: unknown = await response.json();

      if (!response.ok) {
        const errorData = data as { error?: string };
        throw new Error(errorData.error || "Upload failed.");
      }

      setProfileUserId(userId);
      setStatus("success");
      setErrorMessage("");
      setUploadProgress(100);
    } catch (err) {
      setStatus("error");
      setErrorMessage(err instanceof Error ? err.message : "Upload failed. Please try again.");
      setUploadProgress(0);
    }
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-10">
      <h1 className="text-2xl font-semibold">Upload profile video</h1>
      <p className="mt-2 text-sm text-zinc-600">
        Select a video up to {MAX_FILE_SIZE_MB}MB, 60 seconds or shorter.
      </p>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4 rounded border border-zinc-200 p-4">
        <div>
          <label htmlFor="video-file" className="mb-2 block text-sm font-medium">
            Video file
          </label>
          <input
            ref={fileInputRef}
            id="video-file"
            name="video-file"
            type="file"
            accept="video/*"
            onClick={(event) => {
              event.currentTarget.value = "";
            }}
            onChange={handleFileChange}
            className="block w-full rounded border border-zinc-300 px-3 py-2 text-sm"
          />
        </div>

        <p className="text-sm text-zinc-700">State: <span className="capitalize">{status}</span></p>
        <p className="truncate text-sm text-zinc-700">File: {selectedFile ? selectedFile.name : "No file selected"}</p>
        <p className="text-sm text-zinc-700">
          Status: {status === "success" ? "Ready" : isBusy ? "Working..." : "Waiting"}
        </p>

        {errorMessage ? <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{errorMessage}</p> : null}

        {status === "uploading" ? (
          <div className="space-y-2">
            <div className="h-2 w-full overflow-hidden rounded bg-zinc-200">
              <div className="h-full bg-zinc-800 transition-[width] duration-200" style={{ width: `${uploadProgress}%` }} />
            </div>
            <p className="text-sm text-zinc-700">Uploading: {uploadProgress}%</p>
          </div>
        ) : null}

        <div className="flex gap-2">
          <button
            type="submit"
            disabled={isBusy}
            className="rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {status === "processing" ? "Processing..." : status === "uploading" ? "Uploading..." : "Upload"}
          </button>
          <button
            type="button"
            onClick={() => {
              if (fileInputRef.current) {
                fileInputRef.current.value = "";
              }
              setSelectedFile(null);
              updatePreview(null);
              setStatus("idle");
              setErrorMessage("");
              setVideoDuration(null);
              setUploadProgress(0);
              setProfileUserId(null);
            }}
            className="rounded border border-zinc-300 px-4 py-2 text-sm font-medium"
          >
            Clear
          </button>
        </div>

        {status === "success" && profileUserId ? (
          <p className="text-sm text-zinc-700">
            <Link href={`/profile/${profileUserId}`} className="underline">
              Open my profile
            </Link>
          </p>
        ) : null}
      </form>

      <section className="mt-6 rounded border border-zinc-200 p-4">
        <h2 className="text-lg font-semibold">Preview</h2>
        <div className="mt-3">
          {previewUrl ? (
            <video key={previewUrl} src={previewUrl} controls className="aspect-video w-full rounded border border-zinc-200 bg-black" />
          ) : (
            <p className="text-sm text-zinc-600">Pick a video file to preview it.</p>
          )}
        </div>
      </section>
    </main>
  );
}