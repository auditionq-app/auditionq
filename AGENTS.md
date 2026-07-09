# AGENT.md — Video Profile Upload Prototype

## Project Goal
Build a prototype feature where a user uploads a video (max 60 seconds) that gets
attached to their profile. Duration is validated client-side and server-side —
videos over the limit are **rejected outright** (the user re-uploads a corrected
file; nothing is trimmed automatically). The raw file is uploaded to Cloudflare R2,
processed asynchronously by a native FFmpeg worker, and metadata is stored in
Postgres.

This is a **prototype** meant to be merged into a main project that already has its
own authentication system. This prototype must not build any auth of its own —
`userId` is always an explicit input, ready for the main project's auth system to
supply it later.

Keep it simple, but structure the code so storage and processing stay swappable.

---

## Tech Stack
- Next.js (App Router) + TypeScript + Tailwind CSS
- Prisma + Postgres (metadata only — video files are NOT stored in the DB)
- Cloudflare R2 (S3-compatible object storage) — one bucket, two key prefixes:
  `raw/{userId}/...` (pending processing) and `videos/{userId}/...` (final output)
- Native FFmpeg + `fluent-ffmpeg`, run only inside a separate worker process — no
  ffmpeg.wasm, no client-side processing of any kind
- BullMQ + Redis (local, via Docker) for async job queuing
- No authentication of any kind — no cookies, no sessions, no fake identity layer

---

## Architecture Principles (follow these throughout)

1. **Adapter pattern for storage.** All R2 reads/writes go through `lib/storage.ts`.
   No API route, component, or worker should call the AWS SDK directly. Functions:
   `saveFile`, `getFileUrl` (returns a signed URL), `deleteFile`.
2. **No auth adapter. No cookies. No sessions.** There is no `lib/auth.ts` and no
   `getCurrentUserId()`. Every route, function, and job payload takes `userId` as an
   explicit parameter — a route param, a request body field, or a job field. When
   this prototype is merged into the main project, its real auth system supplies
   `userId` at the boundary; nothing inside this prototype should need to change.
3. **No trimming, ever.** The app never shortens a video automatically, on the
   client or the server. If a video exceeds 60 seconds, it is rejected with a clear
   message asking the user to upload a version of the correct length.
4. **Duration and type validation happen before a job is ever queued.** A quick
   client-side check (via the browser's `<video>` element metadata) gives instant
   feedback. The authoritative check is server-side, via `ffprobe`, right after the
   raw file lands in R2 — before any database row or queue job is created.
5. **All FFmpeg invocations happen inside the worker process only.** The worker
   (`src/worker/processVideo.ts`) is the only place that shells out to
   FFmpeg/ffprobe. It runs as its own process, started manually, never inside an
   API route handler.
6. **Playback is always via signed URL.** The playback route never streams video
   bytes itself — it asks R2 for a temporary signed URL and returns/redirects to
   it. R2 handles range requests on signed URLs natively, so seeking works.
7. **Server does validation too.** Never trust the client. Even though the browser
   does a quick duration check, the API route must re-check file type, size, and
   duration (via `ffprobe`) before anything is queued or written permanently.
8. **Small, typed functions.** Every helper function has an explicit TypeScript
   return type. No `any`.
9. **One responsibility per file.** Storage, DB access, queue definition, worker
   logic, and route handlers stay in separate files.
10. **Fail loudly, fail early.** Validate inputs at the top of each function; throw
    descriptive errors; never swallow exceptions silently.
11. **No secrets in client code.** Nothing server-only (DB connection strings, R2
    credentials, Redis connection string) is imported into a `"use client"`
    component.
12. **Keep the UI simple.** Functional Tailwind utility classes only — no design
    system, no animation polish, no component library. Time and effort go toward
    the processing pipeline being correct, not toward visual craft.

---

## Task List (execute in order)

### Task 1 — Project scaffold
- [ ] `npx create-next-app@latest video-profile-prototype --typescript --tailwind --app`
- [ ] `npm install prisma @prisma/client`
- [ ] `npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner`
- [ ] `npm install bullmq ioredis`
- [ ] `npm install fluent-ffmpeg` (and confirm native `ffmpeg`/`ffprobe` are installed on the machine)
- [ ] Add `.env` with `DATABASE_URL`, R2 credentials (account id, access key, secret, bucket name), and `REDIS_URL`
- [ ] No local disk video storage — nothing to gitignore for video data

### Task 2 — Database schema
- [ ] `npx prisma init`
- [ ] Define schema in `prisma/schema.prisma`:
  - `User { id, createdAt, video? }` — identifier only, no auth-related fields
  - `Video { id, userId (unique), status (processing | ready | failed), rawKey?, videoKey?, thumbnailKey?, duration?, fileSizeBytes?, errorMessage?, createdAt, updatedAt }`
- [ ] `npx prisma migrate dev --name init`
- [ ] Create `lib/db.ts` exporting a single shared `PrismaClient` instance
      (standard Next.js Prisma singleton pattern for dev/hot-reload)

### Task 3 — Storage adapter (R2)
- [ ] Create `lib/storage.ts` with three functions:
  - `saveFile(key: string, buffer: Buffer): Promise<void>`
  - `getFileUrl(key: string): Promise<string>` → returns a signed, time-limited URL
  - `deleteFile(key: string): Promise<void>`
- [ ] Use one R2 bucket with two key prefixes:
  - `raw/{userId}/{uuid}.{ext}` — original upload, deleted after processing
  - `videos/{userId}/video.mp4` and `videos/{userId}/thumb.jpg` — final output
- [ ] No `fs` calls anywhere in this file — R2 only

### Task 4 — Queue setup (BullMQ + Redis)
- [ ] Run Redis locally via Docker: `docker run -p 6379:6379 redis`
- [ ] Create `lib/queue.ts` defining a BullMQ `Queue` named `video-processing`,
      connected via `REDIS_URL`
- [ ] Checkpoint: enqueue a dummy job from a scratch script and confirm it appears
      in the queue before moving on

### Task 5 — Upload UI (client component, keep minimal)
- [ ] `app/upload/[userId]/page.tsx` — file input (`accept="video/*"`), plain
      Tailwind utility classes only, no design polish
- [ ] Show file preview once selected
- [ ] Show clear states: idle → uploading → processing → success/error (plain text
      is fine for `processing` — no need for anything elaborate)
- [ ] Disable the upload button while uploading/processing (prevent double-submit)
- [ ] On file selection, read duration via a hidden `<video>` element's
      `loadedmetadata` event; if over 60s, show an error immediately and block
      submission — no trimming, just rejection with a message to re-upload

### Task 6 — FFmpeg worker process
- [ ] Create `src/worker/processVideo.ts` as its own process (started via
      `npm run worker`, separate from `npm run dev`)
- [ ] Confirm native `ffmpeg -version` / `ffprobe -version` work on the machine
- [ ] Worker steps per job:
  1. Download the raw file from R2 (via `lib/storage.ts`) to a temp path
  2. Run `ffprobe` to confirm duration is within 60s (safety net — primary check
     already happened in the upload route)
  3. Transcode to a consistent H.264 mp4
  4. Extract a thumbnail frame at ~1s as JPEG
  5. Upload both outputs to R2 under `videos/{userId}/...`
  6. Update the `Video` row: `status: ready`, set `videoKey`/`thumbnailKey`,
     clear `rawKey`, delete the raw file from R2
- [ ] On failure: let BullMQ auto-retry a couple of times; if retries are
      exhausted, set `status: failed` with `errorMessage`, clean up temp files
- [ ] Wrap all ffmpeg calls in try/catch with meaningful error messages

### Task 7 — Upload API route
- [ ] `app/api/upload/route.ts` — `POST`, accepts `multipart/form-data`, `userId`
      passed explicitly (route param or form field — not from a cookie)
- [ ] Steps inside the route, in order:
  1. Validate file type is video/mp4 and size is under a max limit (e.g. 50MB)
  2. Save the raw file to R2 under `raw/{userId}/{uuid}.{ext}`
  3. Run `ffprobe` on the raw file to check duration
     - If over 60s: delete the raw file from R2 immediately, return `400` with a
       message like "Video exceeds 60 seconds — please upload a version trimmed
       to the correct length." Do not create a DB row, do not enqueue a job.
     - If valid: continue
  4. Create/upsert the `Video` row with `status: processing` and `rawKey` set
     (delete any previous processed files first if replacing an existing video)
  5. Enqueue a job on the `video-processing` queue with `{ videoId, userId, rawKey }`
  6. Return `202 Accepted` with `{ videoId }`
- [ ] Return proper HTTP status codes (400 for bad input, 500 for server errors)
      with a consistent `{ error: string }` shape

### Task 8 — Serve video back
- [ ] `app/api/videos/[userId]/route.ts` — `GET`
- [ ] Look up `Video` row by `userId` in Postgres, 404 if not found
- [ ] If `status` is not `ready`, return a clear not-ready response the client can
      poll against (e.g. `{ status: "processing" }`)
- [ ] If `ready`, generate a signed R2 URL via `getFileUrl()` and redirect the
      client to it (R2 handles range requests on signed URLs natively — no manual
      streaming/range logic needed in this route)

### Task 9 — Profile page
- [ ] `app/profile/[userId]/page.tsx` (server component)
- [ ] Fetch video metadata from Postgres directly (reuse `lib/db.ts`)
- [ ] Render thumbnail image + `<video controls src={signedUrl} />` when `ready`
- [ ] Handle `processing`, `failed`, and empty ("no video uploaded yet") states
      with plain text — no need for elaborate UI

### Task 10 — Polish
- [ ] **Upload progress bar**: use `XMLHttpRequest` or `fetch` with a
      `ReadableStream` to report upload progress; simple Tailwind progress bar
- [ ] **Early file validation**: check file type/extension and rough size
      *before* the duration check, so obviously-invalid files are rejected instantly
- [ ] **Status polling**: after the `202` response, poll the video status endpoint
      every few seconds until `ready` or `failed`, then update the UI
- [ ] **Worker failure handling**: if the worker fails after retries, the profile
      page should show a clear `failed` message
- [ ] **R2 write failure handling**: if `saveFile()` throws in the upload route,
      return a 500 with a clear message, don't leave a partial DB row
- [ ] **Basic rate limiting**: prevent the same `userId` from hitting
      `/api/upload` more than once every few seconds (simple in-memory check)
- [ ] **Cleanup on replace**: when a user uploads a new video, delete the old
      processed files from R2 after the new ones are confirmed and the DB row is
      updated (new confirmed → DB updated → old deleted, in that order)

---

## Migration Notes (for future work when merged into the main project)
- `userId` is currently supplied via route params/form fields with no
  verification. When merged into the main project, its real auth system should
  supply `userId` at the same points — no other code in this prototype needs to
  change.
- Everything else (R2 storage, BullMQ worker, native FFmpeg, signed-URL playback)
  is already production-shaped and does not need a swap-out step.

---

## Code Standards Checklist (apply to every file)
- [ ] TypeScript strict mode, no `any`
- [ ] Explicit return types on exported functions
- [ ] No direct AWS SDK / R2 calls outside `lib/storage.ts`
- [ ] No cookie or session logic anywhere in the codebase
- [ ] No FFmpeg/ffprobe calls outside `src/worker/processVideo.ts`
- [ ] Consistent error response shape across all API routes: `{ error: string }`
- [ ] Tailwind classes only — no inline `style={}` unless dynamic (e.g. progress %)
- [ ] Every async function that can fail is wrapped in try/catch with a meaningful
      error message
- [ ] Don't use emojis in this