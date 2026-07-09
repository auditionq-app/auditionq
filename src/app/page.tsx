import Link from "next/link";

export default function Home(): React.JSX.Element {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-10">
      <h1 className="text-2xl font-semibold">Video Profile Prototype</h1>
      <p className="mt-2 text-sm text-zinc-600">Phase I minimal UI flow.</p>

      <div className="mt-6 flex flex-wrap gap-2">
        <Link href="/upload" className="rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white">
          Go to upload
        </Link>
      </div>
    </main>
  );
}
