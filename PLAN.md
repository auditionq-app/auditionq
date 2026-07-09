## Plan: Video Profile Prototype Execution

This plan assumes Phases A–C were already built once (data foundation, core adapters, upload UI shell) under
an earlier version of this prototype that included cookie-based auth and client-side trimming. Those two
things are being removed. **Phase 0 below must be completed before continuing to Phase D**, since it changes
already-written code that later phases depend on.

**UI note:** keep all UI work minimal — functional Tailwind only, no design polish. Don't spend extra time or
tokens making the upload/profile pages look refined; they just need to work.

---

### Phase 0 — Cleanup of already-built code (do this first)

**Goal:** remove cookie auth and any trimming assumptions from what's already built, so every later phase
starts from a clean, correct base.

1. Delete `src/lib/auth.ts` entirely (the cookie-based auth adapter).
2. Search the codebase for any call to `getCurrentUserId()` and replace each with an explicit `userId`
   passed in — from a route param, request body, or prop, depending on where it's called.
3. Move the upload page from `src/app/upload/page.tsx` to `src/app/upload/[userId]/page.tsx` so the user is
   identified by the URL, not by a cookie.
4. Update `src/app/profile/[userId]/page.tsx` (if any placeholder exists) to make sure it never reads a
   cookie for identity — it should already take `userId` from the route param.
5. Remove any references to client-side trimming or ffmpeg.wasm if they were scaffolded — none of that is
   being built. There should be no ffmpeg-related package in client-side code.
6. Confirm `src/lib/storage.ts` doesn't assume a single implicit user; all its functions should take
   `userId` and a file reference explicitly.
7. Checkpoint: run the app, confirm there are zero references to cookies or sessions anywhere in the
   codebase (`grep -ri "cookie" src/` should return nothing relevant), and confirm the upload/profile routes
   both require an explicit `userId` in the URL.

---

### Phase A — Data Foundation (already done, minor check)
1. Confirm the `User` model has no auth-related fields (no password, no session token). It should be a
   minimal identifier-only model.
2. Confirm `Video` has: `userId`, `status` (`processing` | `ready` | `failed`), `rawKey` (nullable),
   `videoKey`, `thumbnailKey`, `errorMessage` (nullable), timestamps.
3. If the schema needs adjusting to drop auth-related fields, run a new migration.

### Phase B — Core Server Adapters (revised)
1. No auth adapter exists anymore (removed in Phase 0).
2. Rewrite `src/lib/storage.ts` to talk to R2 instead of local disk:
   - `saveFile(key, buffer)` → `PutObjectCommand`
   - `getFileUrl(key)` → signed GET URL (supports range requests)
   - `deleteFile(key)` → `DeleteObjectCommand`
3. Adopt the two-prefix convention in one bucket: `raw/{userId}/{uuid}.<ext>` for uploads pending
   processing, `videos/{userId}/video.mp4` and `videos/{userId}/thumb.jpg` for final output.

### Phase C — Upload Pipeline MVP (revised)
1. Simple upload page at `src/app/upload/[userId]/page.tsx`. Minimal styling — plain form, file input,
   basic status text. No need for anything beyond function.
2. States: idle, uploading, processing (server-side now, see Phase H for polling), success, error.
3. Quick client-side duration check on file selection using the browser's `<video>` element metadata; if
   over 60 seconds, show an error immediately and don't allow submission — no trimming, just rejection.

---

### Phase D — Infrastructure Setup
1. Create an R2 bucket in the Cloudflare dashboard and generate an S3-compatible API token.
2. Install `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`.
3. Install Redis locally via Docker (`docker run -p 6379:6379 redis`) and install `bullmq`.
4. Create `src/lib/queue.ts` defining a BullMQ `Queue` named `video-processing`, connected to local Redis.
5. Checkpoint: enqueue a dummy job and confirm it appears in the queue before moving on.

### Phase E — FFmpeg Worker (no trimming)
1. Confirm native FFmpeg is installed (`ffmpeg -version`, `ffprobe -version`) and install `fluent-ffmpeg`.
2. Create `src/worker/processVideo.ts` as its own process, separate from the Next.js server.
3. Worker steps per job:
   - Download the raw file from R2 to a temp path.
   - Run `ffprobe` to confirm duration is within the 60-second limit. (This should already have been checked
     server-side before the job was created — treat this as a safety net, not the primary check.)
   - Transcode to mp4/h264.
   - Extract a ~1 second jpeg thumbnail.
   - Upload both outputs to R2 under the `videos/{userId}/...` keys.
   - Update the `Video` row: status `ready`, set `videoKey`/`thumbnailKey`, clear `rawKey` and delete the raw
     file from R2.
4. On failure: allow BullMQ to auto-retry a couple of times; if retries are exhausted, mark the row
   `failed` with an error message and clean up temp files.
5. Add an npm script (`npm run worker`) to start this process in a second terminal alongside `npm run dev`.
6. Checkpoint: enqueue a job against a real uploaded file and confirm the processed output appears
   correctly in R2, and that the raw file is deleted afterward.

### Phase F — Upload API Route
1. `POST /api/upload/[userId]` (or `/api/upload` with `userId` in the body) accepts the raw file, validates
   file type server-side.
2. Save the raw file to R2 under `raw/{userId}/{uuid}.<ext>`.
3. Run `ffprobe` on the raw file to check duration.
   - If duration exceeds 60 seconds: delete the raw file from R2 immediately, return a 400 error with a
     message like "Video exceeds 60 seconds — please upload a version trimmed to the correct length."
     Do not create a database row and do not enqueue a job.
   - If valid: continue to the next step.
4. Create a `Video` row with status `processing` and the `rawKey` set.
5. Enqueue a job on the `video-processing` queue with `{ videoId, userId, rawKey }`.
6. Return `202 Accepted` with the video's id.
7. Checkpoint: upload a valid file and an over-length file; confirm the over-length one is rejected with no
   DB row and no job, and the valid one produces a `processing` row and a queued job.

### Phase G — Playback API with Seeking
1. `GET /api/videos/[userId]` reads the `Video` row from the database.
2. If status is not `ready`, return a clear not-ready response the client can poll against.
3. If ready, generate a signed R2 URL for the mp4 and redirect the client to it (or proxy if you specifically
   need to hide the R2 URL — not required for this prototype).
4. Checkpoint: confirm browser seeking works against the signed URL (206 Partial Content on range requests).

### Phase H — Profile Page and Minimal Polish
1. Simple profile page at `src/app/profile/[userId]/page.tsx` — thumbnail, video player, and plain text for
   `processing` / `ready` / `failed` states. No loading skeleton needed unless trivial to add.
2. Add polling on the upload page: after the 202 response, poll a lightweight status endpoint every few
   seconds until `ready` or `failed`, then update the UI with plain text/status change.
3. Correct cleanup ordering when a video is replaced: new file uploaded and confirmed → DB updated → old R2
   files deleted.

### Phase I — Standards Pass and Final Validation
1. Explicit return types everywhere; no `any`.
2. Confirm no `fs` access outside the worker's temp-file handling, no direct AWS SDK calls outside the
   storage adapter, and — critically — grep the whole codebase for "cookie" and confirm zero matches.
3. Confirm consistent error response shape across all API routes.
4. Full smoke test: upload a valid video → status processing → worker completes → status ready → open
   profile page → playback and seeking work → refresh persists. Separately, upload an over-length video and
   confirm it's rejected immediately with no DB row created.

---

**Relevant files**
- [AGENTS.md](AGENTS.md) — architecture rules and constraints for this prototype.
- `src/lib/db.ts` — Prisma singleton.
- `src/lib/storage.ts` — R2 storage adapter.
- `src/lib/queue.ts` — BullMQ queue definition.
- `src/worker/processVideo.ts` — FFmpeg worker process.
- `src/app/upload/[userId]/page.tsx` — upload UI.
- `src/app/api/upload/route.ts` — upload + duration validation + enqueue.
- `src/app/api/videos/[userId]/route.ts` — signed playback URL.
- `src/app/profile/[userId]/page.tsx` — profile/player page.

**Dependencies to add**
- `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`
- `bullmq`
- `fluent-ffmpeg`
- Redis running locally (Docker recommended)

**Decisions**
- No authentication of any kind in this prototype — `userId` is always an explicit input, ready to be
  supplied by the main project's real auth system later.
- No video trimming — over-length uploads are rejected outright and the user re-uploads a corrected file.
- Raw upload stages in R2 (not a local temp folder) before the worker processes it.
- Failed processing jobs auto-retry a couple of times via BullMQ before being marked permanently failed.
- UI stays intentionally minimal — correctness of the pipeline matters more than visual polish for this
  prototype.