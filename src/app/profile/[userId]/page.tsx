import { db } from "@/lib/db";
import { getFileUrl } from "@/lib/storage";

interface ProfilePageProps {
  params: Promise<{ userId: string }>;
}

export default async function ProfilePage({
  params,
}: ProfilePageProps): Promise<React.JSX.Element> {
  const { userId } = await params;

  const video = await db.video.findUnique({ where: { userId } });

  if (!video) {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-10">
        <h1 className="text-2xl font-semibold">Profile</h1>
        <p className="mt-4 text-sm text-zinc-600">No video uploaded yet.</p>
      </main>
    );
  }

  if (video.status === "processing") {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-10">
        <h1 className="text-2xl font-semibold">Profile</h1>
        <p className="mt-4 text-sm text-zinc-600">
          Your video is still processing. Check back in a moment.
        </p>
      </main>
    );
  }

  if (video.status === "failed") {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-10">
        <h1 className="text-2xl font-semibold">Profile</h1>
        <p className="mt-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          Video processing failed{video.errorMessage ? `: ${video.errorMessage}` : "."}
        </p>
      </main>
    );
  }

  if (video.status !== "ready" || !video.videoKey) {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-10">
        <h1 className="text-2xl font-semibold">Profile</h1>
        <p className="mt-4 text-sm text-zinc-600">Video is not available.</p>
      </main>
    );
  }

  const videoUrl = await getFileUrl(video.videoKey);
  const thumbnailUrl = video.thumbnailKey
    ? await getFileUrl(video.thumbnailKey)
    : null;

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-10">
      <h1 className="text-2xl font-semibold">Profile</h1>

      {thumbnailUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={thumbnailUrl}
          alt="Video thumbnail"
          className="mt-4 aspect-video w-full rounded border border-zinc-200 object-cover"
        />
      ) : null}

      <video
        controls
        src={videoUrl}
        className="mt-4 aspect-video w-full rounded border border-zinc-200 bg-black"
      />
    </main>
  );
}