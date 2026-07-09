export default function ProfileLoading(): React.JSX.Element {
  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <div className="h-8 w-44 animate-pulse rounded bg-zinc-200" />

      <div className="mt-6 space-y-3">
        <div className="h-4 w-24 animate-pulse rounded bg-zinc-200" />
        <div className="aspect-video w-full animate-pulse rounded border border-zinc-200 bg-zinc-100" />
      </div>

      <div className="mt-6 space-y-3">
        <div className="h-4 w-16 animate-pulse rounded bg-zinc-200" />
        <div className="aspect-video w-full animate-pulse rounded border border-zinc-200 bg-zinc-100" />
      </div>

      <div className="mt-6 space-y-2">
        <div className="h-4 w-32 animate-pulse rounded bg-zinc-200" />
        <div className="h-4 w-28 animate-pulse rounded bg-zinc-200" />
        <div className="h-4 w-40 animate-pulse rounded bg-zinc-200" />
      </div>
    </main>
  );
}
