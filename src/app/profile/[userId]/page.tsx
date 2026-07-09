import { db } from "@/lib/db";

type ProfilePageProps = {
  params: Promise<{ userId: string }>;
};

export default async function ProfilePage({ params }: ProfilePageProps): Promise<React.JSX.Element> {
  const { userId } = await params;

  const video = await db.video.findUnique({
    where: { userId },
    select: {
      duration: true,
      fileSizeBytes: true,
      createdAt: true,
    },
  });

  if (!video) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="text-2xl font-semibold">Profile video</h1>
        <p className="mt-4 text-sm text-zinc-600">No video uploaded yet.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-2xl font-semibold">Profile video</h1>

      <div className="mt-6">
        <p className="mb-2 text-sm text-zinc-600">Video</p>
        <video controls src={`/api/videos/${userId}`} className="w-full rounded border border-zinc-200" />
      </div>

      <div className="mt-4 text-sm text-zinc-600">
        <p>Duration: {video.duration}s</p>
        <p>Size: {Math.round(video.fileSizeBytes / 1024 / 1024)}MB</p>
        <p>Uploaded: {video.createdAt.toLocaleString()}</p>
      </div>
    </main>
  );
}