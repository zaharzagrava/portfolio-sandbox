# Feature Specification: S30 — Product Video and VOD: Resumable Upload, Transcoding DAG, HLS Ladder, Signed Delivery (domain `media`)

**Feature Branch**: `S30-video` (spec directory `specs/domains/S30-video`)

**Created**: 2026-10-05

**Status**: Draft

**Input**: Capability S30 of `scripts/sdd/capabilities.tsv`. Sources: `docs/showcase/sections/SD-26-product-video.md`, `10-System-Design/08-media-and-files.md` (design 26 video streaming, design 27 large-file upload). Pattern-map rows covered: **P0203** (`child_process.spawn` with streams, timeouts, kill on abort) and **P1107** (topological sort, DAG scheduling).

## Scope

A **video** is a clip a shop puts on the marketplace: a product demo, a launch recording, a how-to. This capability owns the whole life of that clip: how a very large file gets into the system without the API ever touching its bytes and without starting over after a dropped connection, how it is turned into a ladder of qualities that play smoothly on weak networks, who is allowed to watch it, and how it is taken down.

In scope:

- Starting a resumable upload (a shop member), resuming it after a break, finishing it, and the limits, quotas and rate limits around it.
- The processing pipeline as a task graph: inspect the file, make the quality ladder (240p up to 1080p, never enlarged), a poster picture and a scrub-preview sprite in parallel, package everything as HLS, publish. Parallel tasks, retries with backoff, timeouts, killing stuck child processes, exactly-once effects under duplicate and concurrent deliveries, crash recovery.
- Delivery: public videos on a stable unsigned address, unlisted videos behind a share token and a time-limited signed credential, immutable cacheable output, the original never served.
- Seller management: status and progress, list, rename, link to a product, retry a failed video, delete.
- A public list of a product's videos for the product page.
- Domain events, reactions to product, shop deletion and shop suspension, scheduled cleanup, observability, configuration checks.

Out of scope (owner named):

- Photos, image variants, galleries, `ProductMedia` → **S29** (also `media`; separate statuses, tables and events).
- Product data and the product page → **S05** (`catalog`). Shop membership, roles, shop status → **S03** (`tenancy`). Authentication → **S01** (`identity`).
- Live ingest, real-time transcoding and live chat → **S23** (`launch-events`) carries chat only. Turning a finished live stream into a video is not offered in this release (Assumptions).
- View counts. They come from player beacons into analytics ingestion (**S39**), never from a database write per view. This capability counts nothing per view in its tables.
- Paid or DRM-protected video, captions, chapters, thumbnails chosen by the seller, DASH, HEVC or AV1, audio-only media.
- Realtime fan-out of "video is ready" (**S51**), email or push about it (**S28** may consume `video.ready`), job scheduler engine (**S49**), rate-limit engine (**S50**), outbox and consumer framework (**S53**), error filter, config validation, metrics (**S54**).
- The CDN's own configuration (its behaviors, headers and lifecycle rules are proven by an operations artifact, AS-60), and the web screens (**W04** seller upload screen, **W02** product page player), which consume the contracts below.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — A seller uploads a large video and can resume it (Priority: P1)

A seller asks to upload a video, sends the file straight to storage in parts, loses the connection halfway, comes back, sends only the missing parts and finishes. Nobody else can see, finish, resume or delete the seller's upload, and the platform never receives the file's bytes.

**Why this priority**: no upload, no video. Every other story depends on it, and a 20 GiB file that restarts from zero is unusable on a phone connection.

**Independent Test**: with two shops and users of each role, start an upload, put real parts into storage with the issued permissions, drop some, resume, finish; replay and cross-shop attempts at every step.

**Acceptance Scenarios**:

1. **AS-01** (start) — **Given** a `STAFF` member of an `ACTIVE` shop `S`, a frozen clock `T`, and a body `{title:"Launch demo", sizeBytes:200000000, contentType:"video/mp4", visibility:"public"}`, **When** `POST /shops/S/videos`, **Then** `201 {videoId, partSize:67108864, partCount:3, expiresAt: T+24h, visibility, shareToken: null, parts:[{partNumber, url, contentLength}]}` parsed by `videoStartResponseSchema`; one `Video` row `status:"UPLOADING"`, `version:1`, `shopId:S`, `uploaderId` = caller, a **server-generated** private source location that is not in the request and **not in the response**, and the storage upload identifier **not in the response**; one `VideoStatusHistory` row (`null → UPLOADING`, actor, time); `parts` has exactly `partCount` entries, the first two with `contentLength:67108864` and the last with `65782272` (200,000,000 − 2×67,108,864); each part URL is valid for 1 hour and is bound to that exact part and length; the request body was ≤ 4 KiB. For `visibility:"unlisted"` the response carries a random `shareToken` of ≥ 128 bits; for `public` it is `null`.
2. **AS-02** (start, validation) — **Given** the start route, **When** the body has any of: empty or whitespace-only `title`, `title` over 200 characters, `sizeBytes` that is 0, negative, fractional, under 1,024 or over 21,474,836,480 (20 GiB), a `visibility` other than `public`/`unlisted`, a `contentType` outside `video/mp4`, `video/quicktime`, `video/webm`, a non-UUID `productId`, or any unknown field (`status`, `shopId`, `key`, `uploadId`, `partSize`), **Then** `400 validation_failed` (RFC 9457, `errors[]` naming the field) and nothing is persisted and no storage call is made. Exactly 1,024 and exactly 21,474,836,480 bytes are accepted.
3. **AS-03** (start, authorization and shop gate) — **Given** the start route, **When** called without credentials, **Then** `401`; by a `VIEWER` member, **Then** `403 permission_denied`; by a non-member of `S` or for an unknown `S`, **Then** the same `404` body for both; for a `SUSPENDED` shop, **Then** `403 shop_suspended`; for a `DELETING` shop, **Then** `409 shop_offboarding` (S03 gate). Nothing is persisted in any case.
4. **AS-04** (start, product link) — **Given** a body with `productId:P`, **When** `P` is an `ACTIVE` product of `S`, **Then** `201` and the row stores `productId:P`; **When** `P` is unknown or belongs to another shop, **Then** the same `404 product_not_found` and nothing is persisted; **When** `P` is `ARCHIVED`, **Then** `409 product_archived`. The product check is one batch read through catalog's exported service (IX.7 R1) with the shop predicate; no `Product` table is read by `media`.
5. **AS-05** (pending-upload quota, concurrent) — **Given** a shop holding 9 videos in `UPLOADING`, **When** 5 start requests arrive at the same moment (`Promise.all`), **Then** exactly one answers `201` and four answer `409 pending_uploads_limit {limit:10, current:10}`; the shop never holds more than 10 `UPLOADING` rows; **Given** one of the 10 is completed, expired or deleted, **When** the shop starts another, **Then** `201`.
6. **AS-06** (start, rate limit and fail mode) — **Given** the policy `video.start.shop` (20 per hour per shop, fail closed), **When** a shop sends a 21st start request in the hour, **Then** `429` with `Retry-After`, no row; **Given** the limiter's store is down, **Then** `503` problem+json with a generic detail and nothing persisted. `complete`, resume, edit, retry and delete are limited by `video.write.shop` (120 per minute per shop, fail closed): the 121st within a minute is `429`.
7. **AS-07** (storage failure at start) — **Given** the storage service refuses or hangs when the multipart upload is created (fault proxy), **When** the seller starts an upload, **Then** within 5 seconds the answer is `503 storage_unavailable` (generic detail), the quota count is unchanged (no usable `UPLOADING` row remains; the half-created row is `EXPIRED` with a history row), and a retry after storage recovers answers `201`.
8. **AS-08** (storage enforces each part's permission) — **Given** the part URLs of AS-01 and a real object store, **When** the browser step is replayed with (a) the correct body, **Then** the part is stored; (b) a body one byte longer or shorter, (c) the URL of part 1 used for another part's bytes, (d) the URL after its hour, (e) a URL of another video, **Then** the store refuses each and no part appears; the platform's API was not called in any of these steps.
9. **AS-09** (resume) — **Given** an `UPLOADING` video of 12 parts of which parts 1–7 are in storage, **When** the seller calls `GET /shops/S/videos/:id/upload`, **Then** `200 {status:"UPLOADING", partSize, partCount:12, uploadedParts:[{partNumber:1..7, size}], missingParts:[8..12], parts:[{partNumber, url, contentLength}] for the missing ones only, expiresAt}` parsed by `videoUploadStateSchema`; the permissions are fresh (new 1-hour life); the session `expiresAt` is unchanged (resume never extends the 24-hour life). **Given** the video is `UPLOADED`, `PROCESSING`, `READY` or `FAILED`, **Then** `409 upload_closed {status}`; `EXPIRED`, `DELETED`, unknown or another shop's, **Then** the hidden `404 video_not_found`.
10. **AS-10** (complete) — **Given** an `UPLOADING` video whose parts are all in storage, **When** the seller calls `POST /shops/S/videos/:id/complete {parts:[{partNumber, etag}]}`, **Then** `202 {status:"PROCESSING"}` parsed by `videoCompleteResponseSchema`; the server compared the listed parts with the **storage's own list of parts** (not the client's word); the assembled source has exactly `sizeBytes` bytes; the row moved `UPLOADING → UPLOADED → PROCESSING` with a history row each; one `probe` task exists; exactly one queue message `{videoId, task:"probe"}` was sent **after the commit** (never inside the transaction); no storage call ran inside a transaction.
11. **AS-11** (complete before all parts, mismatched parts) — **Given** an `UPLOADING` video with parts 1–7 of 12 present, **When** the seller completes, **Then** `409 upload_incomplete {missingParts:[8..12]}` and the status is unchanged; **Given** all parts are present but the body names a wrong `etag`, a part number the video does not have, a duplicate number or an unsorted list, **Then** `422 parts_mismatch` (wrong etag, unknown number) or `400 validation_failed` (duplicate, unsorted, empty list); in every case no message is sent and the status stays `UPLOADING`.
12. **AS-12** (complete, replay and concurrency) — **Given** a completable video, **When** two `complete` requests arrive at the same moment, **Then** both answer `202 {status:"PROCESSING"}`, exactly one `UPLOADING → UPLOADED` transition, one multipart completion, one `probe` task and one queue message exist. **Given** `PROCESSING`, **When** `complete` is replayed, **Then** `202` with the current status and no new message. **Given** `READY`, **Then** `200 {status:"READY"}`; `FAILED`, **Then** `200 {status:"FAILED", failureCode}`; neither sends a message.
13. **AS-13** (complete, illegal states and hidden access) — **Given** an `EXPIRED` video, **When** `complete` is called, **Then** `409 upload_expired`; **Given** `DELETED`, an unknown ID, or a video of another shop under `S`'s route, **Then** the same `404 video_not_found` body; a non-UUID ID, **Then** `400`; without credentials, **Then** `401`; a `VIEWER`, **Then** `403`.
14. **AS-14** (complete, storage fails or source size differs) — **Given** the storage refuses to assemble the parts (fault proxy), **When** the seller completes, **Then** `503 storage_unavailable`, the status is `UPLOADED` (never lost), and a retry of `complete` after recovery answers `202 PROCESSING` with one message; **Given** the assembled source size differs from the declared `sizeBytes`, **Then** `200 {status:"FAILED", failureCode:"source_size_mismatch"}`, the source is deleted, no task exists, and one `video.failed` outbox row exists.

---

### User Story 2 — Every video becomes a smooth adaptive stream, once, even when workers crash (Priority: P1)

A finished upload is untrusted bytes and a long job. The platform checks what it really is, makes a ladder of qualities that never enlarges the picture, aligns every quality so players can switch seamlessly, and only then publishes. Parallel steps run on different workers; a step that fails is retried; a step that hangs is killed; the same step never runs twice at once; a crash resumes from the last finished step.

**Why this priority**: the video is worthless until it plays, and a pipeline that double-publishes, hangs a worker, or silently stalls costs money and trust.

**Independent Test**: real encoder and real storage; run the graph wave by wave as several workers would; inject crashes, hangs, duplicate and concurrent deliveries; read the produced files back.

**Acceptance Scenarios**:

1. **AS-15** (happy path) — **Given** a completed upload of a 6-second 720p clip with audio, **When** the workers run every queued task (each wave concurrently), **Then** the waves are exactly `probe`, then `poster + thumbnails + transcode:240p + transcode:480p + transcode:720p`, then `package`, then `publish`; the video is `READY` with `durationSec`, `width`, `height`; the master playlist lists 3 renditions; each rendition playlist is a complete VOD playlist; the poster and the sprite exist; one `video.ready` outbox row exists; every state change has a history row; the task rows are all `DONE`.
2. **AS-16** (graph model, pure) — **Given** any set of tasks with dependencies, **Then** a topological order exists exactly when there is no cycle; a cycle, an unknown dependency, a duplicate task name or a self-dependency is rejected with an error naming the offending tasks, before anything is stored; `probe` is first and `publish` last; `package` follows every rendition; a task is ready only when it is `PENDING` and every dependency is `DONE` or `SKIPPED`; a dependency that is `FAILED` or `CANCELLED` never satisfies its dependents.
3. **AS-17** (ladder, pure) — **Given** a source height `h` and width `w`, **Then** the rungs are those of 240/480/720/1080 whose height ≤ `h`, never enlarged; table: 2160 → 4 rungs (the top is 1080), 1080 → 4, 1000 → 3, 720 → 3, 479 → 2, 240 → 1, 239 → 1 rung at the source's own height (even-aligned), 144 → 1 rung at 144; every output width is even and keeps the source aspect ratio within one pixel; the lowest rung's peak bitrate is ≤ 600 kbps in total.
4. **AS-18** (every rendition lines up) — **Given** real sources at 24, 25, 30, 50 and 60 frames per second, **When** transcoded, **Then** all renditions of one video have the same number of segments, each segment starts on a keyframe, and the duration of segment *n* is the same in every rendition within one frame; segments are at most 4.5 seconds; every variant playlist is `VOD` and ends with the end-of-list tag; the target duration is 4.
5. **AS-19** (master playlist is accurate) — **Given** the finished renditions, **Then** the master playlist has one entry per rendition in ascending bandwidth; each `BANDWIDTH` is at least the highest measured segment bitrate of that rendition and each `AVERAGE-BANDWIDTH` equals its measured average within 5%; `RESOLUTION` is the real output size; `FRAME-RATE` is the real output rate; `CODECS` names the real video profile and level of that rendition and names an audio codec only when the video has audio. **Given** a source with no audio track, **Then** the renditions have no audio and the playlist's codec list has no audio entry.
6. **AS-20** (source validation, pure) — **Given** the probe result of a source, **Then** it is rejected with exactly these codes: no video stream → `no_video_stream`; unreadable or non-media data → `not_a_video`; duration over 7,200 s → `duration_exceeded`; duration under 1 s → `duration_too_short`; width over 3,840 or height over 2,160, or either under 16 → `resolution_exceeded`; a codec the platform cannot decode → `not_a_video`; table-driven over all boundaries (7,200 s and 3,840×2,160 pass).
7. **AS-21** (source rejection end to end, no retry) — **Given** a text file uploaded as `video/mp4`, an audio-only file, and a truncated MP4, **When** the `probe` task runs, **Then** each ends with the video `FAILED` and the right `failureCode` (`not_a_video`, `no_video_stream`, `not_a_video`), after exactly one attempt (a permanent failure is never retried); every other task is `CANCELLED`; the source is kept for the retention window; no output object exists; one `video.failed` outbox row; `GET` shows the code and never the decoder's text.
8. **AS-22** (fan-in exactly once) — **Given** the four tasks that follow `probe` finish at the same moment on four workers, **Then** `package` is claimed and queued exactly once (one row transition, one message); **Given** a duplicate message for any finished task, **Then** it is a no-op that answers "stale", changes no row and sends no message.
9. **AS-23** (one runner per task) — **Given** two workers receive the same task message at once, **Then** exactly one executes it and the other returns "busy" without running anything and without consuming an attempt; **Given** the running worker stops heartbeating for longer than the 5-minute lease, **When** another worker receives the message, **Then** it takes over (the lease expired), the attempt is counted, and the first worker's late completion is refused (AS-26).
10. **AS-24** (retry with backoff) — **Given** a rendition task whose first two attempts fail with a transient error (storage unreachable, encoder crash), **Then** after each failure the task returns to `QUEUED` with `attempts` 1 then 2 and is re-sent with a delay of 30 s then 120 s (frozen clock); the third attempt succeeds and the video completes; **Given** all three attempts fail, **Then** the task is `FAILED`, the video is `FAILED` with `failureCode:"transcode_failed"` (`storage_unavailable` when storage was the cause), the remaining tasks are `CANCELLED`, one `video.failed` outbox row exists, and a fourth message for that task is a no-op.
11. **AS-25** (timeout and kill, P0203) — **Given** an encoder process that never ends, **When** the task's time limit passes (`max(600 s, 3 × duration)`, at most 3 h; table-driven in unit), **Then** the process is killed (SIGKILL) and is gone from the process table, the task counts a failed attempt with cause `task_timeout`, the worker slot is free, and after three such attempts the video is `FAILED` `task_timeout`. **Given** a child process that writes 10 MB to standard error and 10 MB to standard output, **Then** only the last 4 KB of standard error and at most 1 MB of standard output are kept in memory, and the stored internal error text is at most 500 characters. Child processes are started with an argument list and never through a shell.
12. **AS-26** (fenced completion, idempotent outputs) — **Given** two attempts of one task ran (the first lost its lease), **Then** their outputs never overwrite each other (each attempt writes to its own location), only the attempt whose completion was recorded can mark the task `DONE` (the other is refused and its objects are removed), and the finished master references exactly one attempt's output per rendition.
13. **AS-27** (publish guard, concurrent delete) — **Given** a video whose last task is about to publish, **When** the seller deletes it at the same moment (`Promise.all`), **Then** the final state is `DELETED` or (publish first) `READY` then `DELETED`, never `READY` after `DELETED`; if delete won, no `video.ready` event exists and no playback answers; `READY` is set only from `PROCESSING` when every required task is `DONE`.
14. **AS-28** (optional preview sprite) — **Given** the `thumbnails` task fails all three attempts, **Then** it becomes `SKIPPED` (not `FAILED`), `publish` runs, the video is `READY` with no sprite (`spriteUrl: null`); **Given** it succeeds, **Then** the sprite is one image of tiles 160×90 in rows of 10 at one tile per 10 s (the interval widens so there are at most 100 tiles) plus a text-track file mapping times to tiles. A failed `poster` or rendition is never skipped.
15. **AS-29** (progress) — **Given** a `PROCESSING` video, **When** the seller reads it, **Then** `progress:{stage, tasksDone, tasksTotal}` is returned; before `probe` finishes `tasksTotal` is 1; after, it is the full graph size; `tasksDone` never decreases; a `READY` video reports `tasksDone == tasksTotal`.
16. **AS-30** (package verifies what it packages) — **Given** a rendition whose playlist or last segment is missing or empty in storage when `package` runs (storage is the truth, not the task's report), **Then** `package` fails retryably, writes no master playlist, and the video is not published.

---

### User Story 3 — Viewers watch public videos, and unlisted videos only with the link (Priority: P1)

A shopper opens a product page and plays its video from a fast edge cache. A public video needs nothing. An unlisted video plays only for someone who holds its share link, through a short-lived credential that covers exactly that video. The original file is never reachable by anyone.

**Why this priority**: delivery is the point of the capability, and a leak of unlisted or original files is a security failure.

**Independent Test**: for videos in every status and both visibilities, call playback with and without the token, decode the credential, request the objects.

**Acceptance Scenarios**:

1. **AS-31** (public playback) — **Given** a `READY` public video, **When** anyone calls `GET /videos/:id/playback` without credentials, **Then** `200 {videoId, title, masterUrl, posterUrl, spriteUrl, durationSec, width, height, renditions:[{name,width,height}], expiresAt:null}` parsed by `videoPlaybackSchema`; `masterUrl` and `posterUrl` are on the video delivery host (`stream.marketplace.dev` in production) under the public path of that video; there is no `Set-Cookie`; `Cache-Control: public, max-age=60`; no key of the source and no storage address appears anywhere.
2. **AS-32** (unlisted playback) — **Given** a `READY` unlisted video and its `shareToken`, **When** `GET /videos/:id/playback?token=<shareToken>`, **Then** `200` as AS-31 with `expiresAt = T + 4 h`, `masterUrl` under the unlisted path, and signed-credential cookies set: `Secure`, `HttpOnly`, `SameSite=None`, `Path` = that video's unlisted path, `Domain` = the configured parent domain that contains both the API host and the delivery host, `Expires = T + 4 h`; `Cache-Control: private, no-store`. The credential's policy decodes to exactly one resource pattern (that video's unlisted path) and one expiry, and its signature verifies with the configured public key; it grants nothing under any other video.
3. **AS-33** (unlisted without the token) — **Given** a `READY` unlisted video, **When** playback is called with no token, a wrong token, a token of another video, or an empty token, **Then** `404 video_not_found` with a body identical to the one for an unknown ID, no cookie, no URL; the token is compared in constant time; the token is accepted only for its own video.
4. **AS-34** (only ready, only visible) — **Given** videos in `UPLOADING`, `UPLOADED`, `PROCESSING`, `FAILED`, `EXPIRED`, `DELETED`, **When** playback is called (with the right token for unlisted ones), **Then** each answers the same `404 video_not_found`; **Given** a video whose shop is suspended (S03 `tenancy.shop_status_changed` to `SUSPENDED`, AS-55), **Then** playback is `404` until the shop is active again; deletion makes playback `404` at once (no cache lag in the API).
5. **AS-35** (signing misconfigured never degrades to unsigned) — **Given** an unlisted video and no signing key configured, **When** playback is called with the right token, **Then** `503` problem+json with a generic detail, never an unsigned URL and never a cookie; **Given** a production configuration with no signing key pair, no delivery host, a delivery host equal to the API's or the web app's site, or a cookie domain that does not contain the delivery host, **When** the app starts, **Then** startup fails naming the setting (AS-58).
6. **AS-36** (originals are never served) — **Given** videos in every status, **When** any route of this capability answers (seller or public), **Then** no body, header, URL or cookie contains the source's location, a storage address, an upload identifier or a presigned download of the source, for any caller including the uploader; the source's location is outside every path the delivery host serves (public and unlisted paths are disjoint from the private source path; proven by the key builders and by requesting the source's address through the delivery path rules).
7. **AS-37** (delivery objects) — **Given** a `READY` video, **Then** every stored output carries the right content type (`application/vnd.apple.mpegurl` for playlists, `video/mp2t` for segments, `image/jpeg` for poster and sprite, `text/vtt` for the preview track) and `Cache-Control: public, max-age=31536000, immutable`; no output key contains a client-supplied string.
8. **AS-38** (product page list, R2 target) — **Given** a product `P` with `READY` public videos, an unlisted one, one `PROCESSING`, one `DELETED`, **When** anyone calls `GET /products/P/videos`, **Then** `200 {items:[{videoId, title, posterUrl, durationSec}]}` parsed by `productVideosSchema`, only `READY` public videos, newest first, at most 10; for an `ARCHIVED`, sandbox or unknown product, or a product of a suspended shop, **Then** `404 product_not_found`; the product's visibility is one batch read through catalog's exported service (R1); the answer carries `Cache-Control: public, max-age=15`.
9. **AS-39** (read rate limit, fail open) — **Given** the policy `video.playback.ip` (600 per minute per address, fail open), **When** an address sends the 601st playback or product-list request within a minute, **Then** `429` with `Retry-After`; **Given** the limiter's store is down, **Then** the request is served (fail open).
10. **AS-40** (no write per view) — **Given** 1,000 playback requests for one video, **Then** zero rows of `Video`, `VideoTask`, `VideoStatusHistory` and the outbox change (`updatedAt`, `version` and row counts identical before and after), and the counter `video_playback_total{visibility,result}` shows 1,000.
11. **AS-41** (secrets stay out of logs) — **Given** playback of an unlisted video with its token, **Then** no log line, error body or metric label contains the share token, a signed cookie value, the private signing key or a presigned part URL; access logs show the query parameter `token` as `[redacted]`.

---

### User Story 4 — A seller manages videos (Priority: P2)

The seller sees every video of the shop with its state and progress, renames it, attaches it to a product, retries one that failed for a temporary reason, and deletes ones they no longer want.

**Why this priority**: sellers need to know why a video is not playing and to remove one quickly.

**Independent Test**: two shops, videos in every state, members of each role; every route with the other shop's IDs.

**Acceptance Scenarios**:

1. **AS-42** (read one) — **Given** a member with `products.read`, **When** `GET /shops/S/videos/:id`, **Then** `200` parsed by `videoOwnerSchema`: `{id, title, visibility, status, failureCode, retryable, productId, durationSec, width, height, renditions, progress, posterUrl, spriteUrl, shareToken (unlisted only), version, createdAt, updatedAt}`; it never contains a storage location, an upload identifier, encoder output or an internal error text; a video of another shop, an unknown one, or a non-member caller → the same `404 video_not_found`.
2. **AS-43** (list, keyset) — **Given** 45 videos of shop `S` and some of another shop, **When** `GET /shops/S/videos?limit=20&status=READY`, **Then** `200 {items, nextCursor}` ordered `createdAt desc, id desc` with an opaque cursor; following `nextCursor` returns every video exactly once, even when new videos are inserted between pages; default limit 20, maximum 50 (51 → `400`); a malformed cursor, or a cursor issued for another shop or another filter, → `400 invalid_cursor`; `DELETED` videos never appear; only `S`'s rows are ever returned.
3. **AS-44** (edit, optimistic) — **Given** a video at `version:3`, **When** `PATCH /shops/S/videos/:id {title, expectedVersion:3}`, **Then** `200` with `version:4` (a field change, no status-history row); **When** `expectedVersion:2`, **Then** `409 version_conflict {currentVersion:4}` and no change; **When** two edits with `expectedVersion:4` arrive at the same moment, **Then** exactly one `200` and one `409`; a body with `visibility` or any unknown field → `400` (visibility is fixed at creation, Assumptions); `DELETED` or `EXPIRED` → `404` / `409 upload_expired`.
4. **AS-45** (link to a product) — **Given** `PATCH {productId:P, expectedVersion}`, **Then** the rules of AS-04 apply (R1 batch read with the shop predicate: other shop or unknown → `404 product_not_found`; archived → `409 product_archived`); `productId:null` unlinks; **Given** a product with 10 linked non-deleted videos, **When** an 11th is linked, **Then** `409 product_video_limit`, and with two links arriving at the same moment on a product holding 9, exactly one succeeds (the store enforces it).
5. **AS-46** (retry a failed video) — **Given** a `FAILED` video with `failureCode` in `transcode_failed`, `task_timeout`, `storage_unavailable`, **When** `POST /shops/S/videos/:id/retry`, **Then** `202 {status:"PROCESSING"}`; the failed and cancelled tasks go back to `PENDING` with 0 attempts, `DONE` tasks are kept (the video resumes from the last finished step), exactly one message per ready task is sent after the commit; `failureCode` is cleared; a video may be retried at most 3 times (`409 retry_limit`); **Given** a non-retryable code (`not_a_video`, `no_video_stream`, `duration_exceeded`, `duration_too_short`, `resolution_exceeded`, `source_size_mismatch`), **Then** `409 not_retryable`; **Given** any other status, **Then** `409 invalid_state {status}`; two retries at the same moment → one `202` and one `409 invalid_state`; after the retention window purged the source → `409 source_purged`.
6. **AS-47** (delete) — **Given** a video in any status except `DELETED`, **When** a member with `products.write` calls `DELETE /shops/S/videos/:id`, **Then** `204`; the row is `DELETED` (history row, `version` +1); one `video.deleted` outbox row; open tasks become `CANCELLED`; playback, list and product list stop showing it at once; an `UPLOADING` video's multipart upload is aborted after the commit; objects are removed by the purge (AS-52), not by the request; a second `DELETE` → the hidden `404`; another shop's video → `404`; a `VIEWER` → `403`; no credentials → `401`.
7. **AS-48** (cross-tenant matrix) — **Given** shop `A`'s member and a video of shop `B`, **When** every seller route (`GET`, list, resume, complete, `PATCH`, retry, `DELETE`) is called under `A`'s path with `B`'s video, and under `B`'s path as a non-member, **Then** every response is the same `404` (byte-identical apart from the request ID) and no row, object or message changes.

---

### User Story 5 — Nothing is left stuck, leaked or orphaned (Priority: P2)

Uploads nobody finishes expire. A task whose worker died, or whose queue message was lost, is picked up again. A video that cannot finish fails clearly instead of hanging. Deleted and failed videos' files are removed.

**Why this priority**: orphaned multipart parts cost money and stuck videos cost trust; both happen only in the failure paths that tests must force.

**Independent Test**: advance a frozen clock and run each job against rows in every state, twice, and from two schedulers at once.

**Acceptance Scenarios**:

1. **AS-49** (expire unfinished uploads) — **Given** `UPLOADING` videos created more than 24 hours ago, **When** `media.video-expire-uploads` runs, **Then** each becomes `EXPIRED` (history row), its multipart upload is aborted (storage call outside any transaction), and `complete` answers `409 upload_expired`; younger ones are untouched; a second run, or two runs at the same moment, change nothing more (exactly one run's effect; the advisory lock or lease is proven).
2. **AS-50** (recover stuck work) — **Given** (a) a `RUNNING` task whose lease expired, (b) a `QUEUED` task untouched for 5 minutes (its message was lost between commit and send), (c) an `UPLOADED` video older than 5 minutes (a crash after the claim), (d) a `PROCESSING` video whose tasks are all `DONE`, **When** `media.video-requeue-stuck` runs, **Then** (a) the task is re-queued with one message, (b) one new message is sent for the task, (c) the completion is driven again to `PROCESSING`, (d) `publish` is queued; each effect happens once per sweep, a repeated or concurrent sweep adds no second message for a task already re-sent within the last minute, and every duplicate delivery that follows is a no-op (AS-22).
3. **AS-51** (processing time limit) — **Given** a video in `PROCESSING` for more than 6 hours, **When** the sweep runs, **Then** it becomes `FAILED` with `failureCode:"processing_timeout"` (retryable), open tasks `CANCELLED`, one `video.failed` outbox row.
4. **AS-52** (purge) — **Given** `DELETED` videos, `EXPIRED` videos, and `FAILED` videos older than 7 days, **When** `media.video-purge` runs, **Then** for `DELETED` the delivery objects and the source are removed within one run (at most 5 minutes after the delete), and a request to remove them from the edge cache is made for the video's path; for `EXPIRED` the source and stray parts are removed; for `FAILED` older than 7 days the source and partial outputs are removed and the row records `objectsPurgedAt` (retry then answers `409 source_purged`); a missing object is not an error; the objects of a video that is not `DELETED`, `EXPIRED` or purge-due `FAILED` are never touched (a `READY` video's outputs survive every run); a failed edge-cache request does not stop deletion and is repeated on the next run; the job is idempotent and bounded (at most 200 videos per run).
5. **AS-53** (consumer: product deleted, duplicate and invalid) — **Given** `catalog.product_deleted {productId:P, shopId:S, productVersion}` is delivered, **Then** every video of `S` linked to `P` has `productId` cleared and `version` +1 (the videos stay in the shop); delivered again, **Then** no further change; a payload that fails validation is dead-lettered with no effect; a `shopId` that does not match the video's shop changes nothing.
6. **AS-54** (consumer: shop deleted, duplicate, invalid, bulk) — **Given** `tenancy.shop_deleted {shopId:S}` for a shop with 450 videos in assorted states, **Then** all become `DELETED` in batches (each batch one transaction, one `video.deleted` outbox row per video, open tasks `CANCELLED`, uploads aborted after commit), a replay changes nothing, an invalid payload is dead-lettered, and the purge removes the objects.
7. **AS-55** (consumer: shop status, out of order) — **Given** `tenancy.shop_status_changed {shopId, from, to, shopVersion}` events, **When** `v5 (SUSPENDED)` arrives and then the older `v4 (ACTIVE)`, **Then** the copy of the shop's state stays `SUSPENDED` at version 5; delivering either twice changes nothing; an event for a shop with no videos creates the copy anyway (no video needed); an invalid payload is dead-lettered; while `SUSPENDED`, playback and the product list hide the shop's videos (AS-34, AS-38) and resume when an event with a higher version says `ACTIVE`.

---

### User Story 6 — Events, operations and boundaries are trustworthy (Priority: P2)

Other parts of the platform learn about video outcomes through events; operators can see pipeline health; the domain keeps to its own data.

**Why this priority**: lets notifications, search and feeds react without polling, and keeps the platform honest about isolation.

**Independent Test**: read the outbox, the metrics registry, the logs and the static checks after a scripted run.

**Acceptance Scenarios**:

1. **AS-56** (events) — **Given** `video.ready`, `video.failed` and `video.deleted`, **Then** each is written with `outbox.append` inside the transaction that changed the state (a rolled-back transition, forced by a trigger on the outbox insert, leaves neither a state change nor an event; a committed one always has the event), has the envelope `{eventId, type, version:1, occurredAt, aggregateId}` with `aggregateId = videoId`, and a payload that parses with its schema in `videoEventSchemas`; `videoVersion` is the row's version; no event contains a storage location, URL, share token or credential.
2. **AS-57** (observability) — **Given** a finished video, a failed one, a retried task and a timed-out task, **Then** the metrics registry shows `video_task_total{task,result}` (`done`, `retry`, `failed`, `stale`, `busy`, `skipped`, `timeout`), `video_task_seconds{task}`, `video_upload_to_ready_seconds`, `video_status_transitions_total{from,to}`, `video_stuck_recovered_total{kind}`, `video_playback_total{visibility,result}`, `video_queue_age_seconds` with matching increments; every log line of a task run is structured JSON carrying `videoId`, `task`, `attempt`, `result`, `requestId` or `traceId` (propagated from the queue message), and none contains a secret (AS-41).
3. **AS-58** (configuration) — **Given** a production configuration missing the media bucket, the video delivery host, the cookie domain, the signing key pair or the private key, or a delivery host not contained in the cookie domain, **When** the API or the worker starts, **Then** startup fails naming the missing or invalid setting and exits; a non-production configuration may leave signing unset and then unlisted playback answers `503` (AS-35).
4. **AS-59** (boundary and ownership, static) — **Given** the repository, **When** `pnpm check:table-ownership --strict` and `pnpm check:boundaries` run, **Then** the video code has 0 findings: no SQL, model or join on `Product`, `Shop` or `User`; `Video`, `VideoTask`, `VideoStatusHistory` and `VideoShopState` are registered to `domain:media`; the video tables have no foreign key to another owner's table (the existing keys to `Shop` and `User` are dropped by expand/contract); the barrel exports only what Provides lists; a test module that imports only `@app/domains/media` can boot `VideoModule`.
5. **AS-60** (delivery and storage operations) — **Given** the deployed bucket and CDN, **Then** the source's path is private (the CDN origin cannot read it); the unlisted path requires a valid credential for every object and the public path does not; the delivery host answers outputs with the immutable cache header, `X-Content-Type-Options: nosniff`, a CORS policy for the web app's origins with credentials only for the unlisted path, and sets no cookies; incomplete multipart uploads are aborted by a lifecycle rule after 2 days; sources move to infrequent-access storage after 30 days. Proven by the infrastructure code and a post-deploy check, not by an API test.
6. **AS-61** (UI journey, happy path) — **Given** a signed-in seller with a product, **When** they pick a video file in the seller screen, the upload runs (with a part interrupted and resumed), they wait on the "processing" state and open the product page, **Then** the video plays; an unlisted share link opens the player for an anonymous visitor.
7. **AS-62** (startup safety) — **Given** the worker process with three running tasks, **When** it receives its shutdown signal, **Then** it stops taking new messages, kills the three encoders, sets the three tasks back to `QUEUED` **without** counting an attempt (another worker finishes them), closes its pools last, and exits within 30 seconds (VIII.4).

---

### Edge Cases

- A start request replayed after a lost response creates a second slot; the first expires unused (no `Idempotency-Key`: the action is not one of V.6's, and a duplicate slot is harmless).
- A client completes with the right parts but the object was written by a second upload to the same part after the list was taken: the assembled size check (AS-14) and the probe (AS-21) decide.
- A source with an odd width or a rotation tag: output widths stay even (AS-17); rotation is applied before scaling.
- A very long video with few cuts: the task limit scales with duration (AS-25).
- A product deleted while a seller links a video to it: the R1 read answers `404 product_not_found` (or a later `product_deleted` clears the link, AS-53); the two orders end in the same state.
- A shop deleted while a video is `PROCESSING`: the consumer (AS-54) cancels the tasks; the publish guard (AS-27) stops a late publish.
- The same share link used from many browsers: each gets its own credential; none lengthens another's life.
- A seller who deletes a public video: playback is `404` at once; the edge cache still holds objects until the purge's removal request (≤ 5 minutes plus edge propagation), which is the documented takedown window; an unlisted video's outstanding credentials lapse within 4 hours.
- A worker's clock differs from the database's: all lease and expiry arithmetic uses the database's time; the pure domain functions take `now` as a parameter.

## Requirements *(mandatory)*

### Functional Requirements

**Upload**

- **FR-001**: The system MUST let a member with `products.write` start a resumable multipart upload with `title`, `sizeBytes`, `contentType`, `visibility` and an optional `productId`; the request carries no bytes (AS-01, AS-02).
- **FR-002**: Limits: `sizeBytes` 1,024 to 21,474,836,480; `contentType` one of three; `title` 1 to 200 characters after trimming; any other field is refused; violations are `400 validation_failed` and persist nothing (AS-02).
- **FR-003**: The source location, the storage upload identifier and every part location MUST be chosen by the server and MUST NOT appear in any response; no client input becomes part of a key (AS-01, AS-36).
- **FR-004**: Parts MUST be 64 MiB except the last; each part permission MUST be bound to its part number, key and exact length and live 1 hour; the session MUST live 24 hours from creation and MUST NOT be extendable (AS-01, AS-08, AS-09).
- **FR-005**: A shop MUST hold at most 10 videos in `UPLOADING`; the limit is enforced by the store under concurrency (AS-05).
- **FR-006**: `POST /shops/:shopId/videos` MUST be limited by `video.start.shop`, and every other seller mutation by `video.write.shop`, both fail closed (AS-06).
- **FR-007**: A storage failure when creating the upload MUST yield `503 storage_unavailable` within 5 seconds and leave no usable slot (AS-07).
- **FR-008**: The system MUST let the seller list which parts are stored and get fresh permissions for the missing ones, without extending the session (AS-09).
- **FR-009**: Completion MUST verify the parts against the storage's own list, assemble the source, verify its size equals `sizeBytes`, and move the video `UPLOADING → UPLOADED → PROCESSING` through conditional updates with a history row each; the storage calls MUST run outside any transaction; the first task message MUST be sent after the commit (AS-10, AS-11, AS-14).
- **FR-010**: Completion MUST be idempotent and race-safe: concurrent and replayed calls produce one transition, one assembly and one message; the answer for each status is fixed (`202` while uploading or processing, `200` for `READY` and `FAILED`, `409 upload_expired`, hidden `404`) (AS-12, AS-13).
- **FR-011**: A video that cannot be assembled MUST stay recoverable in `UPLOADED` and be driven forward by a retry or the stuck-work sweep (AS-14, AS-50).

**Pipeline (P1107, P0203)**

- **FR-020**: The pipeline MUST be a task graph: `probe`, then `poster`, `thumbnails` and one `transcode:<rung>` per rung in parallel, then `package` after every rendition, then `publish` after `package`, `poster` and `thumbnails` (or its skip); the rung set is known after `probe`, so the remaining tasks are stored in one transaction after `probe` succeeds (AS-15).
- **FR-021**: The graph MUST be validated by a topological sort before it is stored; cycles, unknown or self dependencies and duplicate names are errors naming the tasks; readiness is `PENDING` with every dependency `DONE` or `SKIPPED` (AS-16).
- **FR-022**: Task states are `PENDING`, `QUEUED`, `RUNNING`, `DONE`, `FAILED`, `SKIPPED` (optional task gave up) and `CANCELLED` (video failed or deleted); transitions are conditional updates asserting one affected row; the status types are closed unions and every switch ends in `assertNever` (AS-16, AS-22).
- **FR-023**: Ready tasks MUST be claimed under a row lock on the video and sent as one message each after the commit, so siblings run on different workers and `package` is queued exactly once (AS-22).
- **FR-024**: A task MUST be claimable only from `QUEUED`, or from `RUNNING` with an expired 5-minute lease (renewed by heartbeat); a second concurrent claimant gets "busy" and consumes no attempt (AS-23).
- **FR-025**: Task completion MUST be fenced by the claim's attempt number: only the claimant of the recorded attempt can mark `DONE`; each attempt writes to its own output location; losing attempts' objects are removed (AS-26).
- **FR-026**: A task MUST be attempted at most 3 times; a transient failure re-queues it with a delay of 30 s then 120 s; permanent failures (invalid source) fail the video after one attempt; after the last failure the task is `FAILED`, the video `FAILED` with a closed-vocabulary `failureCode`, and unfinished tasks `CANCELLED` (AS-21, AS-24).
- **FR-027**: Optional tasks (`thumbnails`) MUST end `SKIPPED` after their attempts; required tasks never do (AS-28).
- **FR-028**: Child processes (encoder, inspector) MUST be started with an argument list and no shell, with a time limit of `max(600 s, 3 × duration)` capped at 3 h (inspect: 60 s, poster and sprite: 120 s, package: 60 s), killed on timeout, on abort and on shutdown, with bounded captured output; a shutdown abort re-queues without counting an attempt (AS-25, AS-62).
- **FR-029**: A source MUST be accepted only if inspection finds a video stream with duration 1 s to 7,200 s and size within 16×16 to 3,840×2,160 whose codec the platform decodes; the container is decided from the bytes, not from the declared type; the reason for any refusal is one of a closed set of codes (AS-20, AS-21).
- **FR-030**: Rungs are 240, 480, 720, 1080 (H.264 main profile, AAC stereo; 400, 1,400, 2,800, 5,000 kbps video plus 64, 96, 128, 128 kbps audio), never enlarged; the lowest rung is made at the source's own height when the source is smaller; output sizes are even and keep the aspect ratio (AS-17).
- **FR-031**: Renditions MUST be aligned: a constant output frame rate, keyframes at fixed 2-second times independent of the source frame rate, segments of 4 seconds, identical segment boundaries across rungs, independent segments (AS-18).
- **FR-032**: Variant playlists are complete VOD playlists; the master playlist is built from measured values of the actual outputs (bandwidth peak and average, size, frame rate, codecs, audio presence), ascending by bandwidth (AS-18, AS-19).
- **FR-033**: `poster` MUST produce one picture at 10% of the duration, 1280 pixels wide; `thumbnails` MUST produce the sprite and its time map (AS-15, AS-28).
- **FR-034**: `package` MUST verify in storage that every rendition's playlist and segments exist and are non-empty before writing the master (AS-30).
- **FR-035**: `publish` MUST be a conditional update from `PROCESSING` to `READY` requiring every required task `DONE`, in one transaction with its history row and the `video.ready` outbox row; it MUST fail if the video is no longer `PROCESSING` (AS-27).
- **FR-036**: A scheduled sweep MUST recover expired leases, lost messages, stuck `UPLOADED` videos and fully-done unpublished videos, and MUST fail videos in `PROCESSING` over 6 hours with `processing_timeout`; each action is idempotent and single-run (AS-50, AS-51).
- **FR-037**: Progress MUST be readable and monotonic (AS-29).
- **FR-038**: Delivery outputs MUST be stored with the content types and the immutable cache header of AS-37.

**Delivery**

- **FR-040**: Public playback MUST be anonymous and unsigned, on the video delivery host (the host S27 allows for marketplace videos), under a public path; unlisted playback MUST require the video's share token and return a signed credential covering only that video's unlisted path, valid for 4 hours (AS-31, AS-32).
- **FR-041**: A missing, wrong or foreign token, an unknown ID and every non-`READY` or hidden state MUST produce the same `404` (AS-33, AS-34).
- **FR-042**: The credential's cookie domain MUST be the configured parent domain containing both the API host and the delivery host (a cookie scoped to the delivery host alone is rejected by browsers when set from the API host) (AS-32, AS-58).
- **FR-043**: Missing signing configuration MUST never degrade to an unsigned URL (AS-35).
- **FR-044**: The source MUST never be served, signed for download or named in any response, and MUST live outside every delivery path (AS-36).
- **FR-045**: Playback MUST write nothing to the database; it counts only in metrics (AS-40).
- **FR-046**: Playback and product-list reads MUST be limited by `video.playback.ip`, fail open (AS-39).
- **FR-047**: The public product-video list MUST include only `READY` public videos of an `ACTIVE`, non-sandbox product of an active shop, at most 10, newest first (AS-38).
- **FR-048**: Secrets (share tokens, signed cookie values, private key, presigned URLs) MUST never be logged, put in metrics or echoed in errors; the `token` query parameter is redacted in access logs (AS-41).

**Management**

- **FR-050**: Seller reads (`products.read`) and writes (`products.write`) go through the shop-scoped permission gate; every lookup puts the shop in the predicate (`id` and `shopId`); another shop's, unknown and non-member access all answer the same `404` (AS-42, AS-48).
- **FR-051**: The owner view MUST show status, `failureCode`, `retryable`, progress, renditions, product link, share token for unlisted videos and the version, and MUST NOT show any storage location, upload identifier, encoder output or internal error text (AS-42).
- **FR-052**: The list MUST use keyset pagination on `(createdAt desc, id desc)` with an opaque cursor bound to shop and filter; limit default 20, maximum 50 (AS-43).
- **FR-053**: Title and product link MUST be editable with optimistic `expectedVersion`; `visibility` is fixed at creation; at most 10 non-deleted videos per product, enforced by the store; the product check is one R1 batch read with the shop predicate (AS-44, AS-45).
- **FR-054**: A `FAILED` video with a retryable cause MUST be retryable at most 3 times, resuming from its last finished task (AS-46).
- **FR-055**: Delete MUST be soft, immediate for readers, cancel open tasks, abort an open upload after commit, and emit `video.deleted`; objects are removed by the purge (AS-47, AS-52).
- **FR-056**: Video statuses are `UPLOADING`, `UPLOADED`, `PROCESSING`, `READY`, `FAILED`, `EXPIRED`, `DELETED`; every transition is a conditional update plus a `VideoStatusHistory` row in the same transaction; the type is a closed union with `assertNever`; the legal transitions are `UPLOADING→UPLOADED`, `UPLOADING→EXPIRED`, `UPLOADED→PROCESSING`, `UPLOADED→FAILED`, `PROCESSING→READY`, `PROCESSING→FAILED`, `FAILED→PROCESSING` (retry), and any status except `DELETED` → `DELETED` (AS-10, AS-27, AS-46, AS-47, AS-49).

**Cleanup and reactions**

- **FR-060**: The system MUST expire `UPLOADING` videos after 24 hours, abort their storage upload, and keep that job single-run and idempotent (AS-49).
- **FR-061**: The purge MUST remove delivery objects and source of `DELETED` videos within one run, the source and stray parts of `EXPIRED` ones, and the source and partial outputs of `FAILED` ones after 7 days; ask the edge cache to drop the path of a deleted video; never touch a video's objects unless it is in a purge state; be idempotent and bounded (AS-52).
- **FR-062**: The system MUST clear `productId` on videos of a deleted product, `DELETE` all videos of a deleted shop in batches, and keep a version-guarded copy of each shop's status; every consumer is idempotent, validates its payload, and dead-letters poison messages (AS-53, AS-54, AS-55).

**Events and operations**

- **FR-070**: `video.ready`, `video.failed`, `video.deleted` are published through the outbox in the state change's transaction, carry the envelope and `videoVersion`, and contain no secret or location (AS-56).
- **FR-071**: The metrics, log fields and trace propagation of AS-57 MUST exist.
- **FR-072**: The API and worker MUST validate their configuration at startup (AS-58) and shut down gracefully (AS-62).
- **FR-073**: Every error is `application/problem+json` with `code` from the vocabulary used in this spec (`validation_failed`, `permission_denied`, `shop_suspended`, `shop_offboarding`, `video_not_found`, `product_not_found`, `product_archived`, `pending_uploads_limit`, `upload_incomplete`, `upload_closed`, `upload_expired`, `parts_mismatch`, `storage_unavailable`, `version_conflict`, `invalid_cursor`, `product_video_limit`, `not_retryable`, `retry_limit`, `source_purged`, `invalid_state`), generic detail on 5xx, never a stack, SQL or upstream text.
- **FR-074**: Every endpoint of this capability has request and response schemas in `packages/contracts`, parsed by every e2e test (VII.6).

**Data ownership**

- **FR-100**: `media` owns `Video`, `VideoTask`, `VideoStatusHistory` and `VideoShopState` (and S29's tables); the video code reads no table it does not own, has no foreign key to another owner's table, and reaches other domains only by R1 (S05 `getProductsByIds`), R2 (the product page's composition calls the two public routes) and R3 (the three consumers) (AS-59).

### Key Entities

- **Video**: id, shop (plain ID), uploader (plain ID), title, visibility (`public` or `unlisted`, fixed), status, the private source's location, the storage upload identifier, declared size, content type, part size, session expiry, share token (unlisted only), optional product (plain ID), duration, width, height, failure code, internal error text (never returned), retry count, `objectsPurgedAt`, a version, timestamps.
- **Video task**: video, name, dependencies, status, attempts, lease expiry, claimed attempt, output (renditions: name, size, measured bitrates, codecs), internal error, timestamps.
- **Status history**: video, from, to, actor (user, system, worker), time, failure code.
- **Shop video state**: shop, suspended flag, the shop's version (a copy kept from `tenancy.shop_status_changed`, IX.8).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 95% of 5-minute 1080p sources are watchable (`READY`) within 10 minutes of completing the upload when the worker fleet is idle.
- **SC-002**: A 20 GiB upload interrupted at 50% resumes and sends 0 bytes of the parts already stored, in 100% of the resume tests.
- **SC-003**: In a corpus of sources at 24, 25, 30, 50 and 60 frames per second, 100% of videos have identical segment boundaries across all renditions.
- **SC-004**: Delivering any task message twice, or to two workers at once, or completing an upload from two tabs, produces exactly one run per task, one finished video and one `video.ready` event, in 100% of the replay and race tests.
- **SC-005**: 0 unlisted videos play without the share token and 0 original files are reachable by anyone, across the cross-tenant matrix (AS-48) and the status matrix (AS-34, AS-36).
- **SC-006**: 95% of playback requests answer in under 150 ms at 1,000 requests per second, and each causes 0 database writes.
- **SC-007**: The lowest rung's peak bitrate is at most 600 kbps, so a viewer on a 1 Mbps link is never offered only rungs they cannot sustain.
- **SC-008**: A deleted public video stops playing in the API immediately and its objects are gone within 10 minutes; unlisted credentials lapse within 4 hours.
- **SC-009**: In 100% of injected faults (worker crash, hung encoder, lost message, storage outage), the video ends `READY` or `FAILED` within 6 hours and never remains stuck.
- **SC-010**: No unfinished upload lives longer than 24 hours and 5 minutes, and no deleted or failed video's file lives longer than 8 days.

## Cross-capability contracts

Earlier specs searched (`grep -rl` over `specs/domains` for `S30` and `media`; `specs/web` and `specs/journeys` do not exist yet): **S29** (same domain) requires that S30 keep `VideoModule` exported and never reuse the photo statuses or tables — honoured (separate tables, statuses, event names); **S27** allows the host `stream.marketplace.dev` for videos in story blocks — honoured: the public delivery host is the one configured for video delivery and is `stream.marketplace.dev` in production (FR-040); **S05** lists S30 as the owner of video next to photos and does not read or write videos — honoured; **S23** points video to S30 and asks nothing. No other spec names a requirement from S30.

**Provides** (exact names; exported from `@app/domains/media` unless it is an HTTP endpoint):

- HTTP under `/api`, problem+json with `code`, schemas in `packages/contracts`: `videoStartRequestSchema` (`{title, sizeBytes, contentType, visibility, productId?}`), `videoStartResponseSchema` (`{videoId, partSize, partCount, expiresAt, visibility, shareToken: string | null, parts: {partNumber, url, contentLength}[]}`), `videoUploadStateSchema` (`{status, partSize, partCount, uploadedParts: {partNumber, size}[], missingParts: number[], parts, expiresAt}`), `videoCompleteRequestSchema` (`{parts: {partNumber, etag}[]}`), `videoCompleteResponseSchema` (`{status, failureCode?}`), `videoOwnerSchema`, `videoListSchema` (`{items: videoOwner[], nextCursor: string | null}`), `videoPatchRequestSchema` (`{title?, productId?: string | null, expectedVersion}`), `videoPlaybackSchema` (`{videoId, title, masterUrl, posterUrl, spriteUrl: string | null, durationSec, width, height, renditions: {name, width, height}[], expiresAt: string | null}`), `productVideosSchema` (`{items: {videoId, title, posterUrl, durationSec}[]}`), `videoEventSchemas`.
  - `POST /shops/:shopId/videos` (`products.write`) → `201`; `GET /shops/:shopId/videos/:id/upload` (`products.write`) → `200`; `POST /shops/:shopId/videos/:id/complete` (`products.write`) → `202` or `200`; `GET /shops/:shopId/videos` and `GET /shops/:shopId/videos/:id` (`products.read`); `PATCH /shops/:shopId/videos/:id` (`products.write`) → `200`; `POST /shops/:shopId/videos/:id/retry` (`products.write`) → `202`; `DELETE /shops/:shopId/videos/:id` (`products.write`) → `204`.
  - `GET /videos/:id/playback?token=` (anonymous) → `videoPlaybackSchema` plus signed-credential cookies for unlisted videos; `GET /products/:productId/videos` (anonymous) → `productVideosSchema`. **Both are R2 targets for the S48 product-page aggregate** (call in parallel, per-call timeout, the video part optional).
- Events (outbox → topic `media.events`, key `aggregateId` = `videoId`; envelope `{eventId, type, version: 1, occurredAt, aggregateId}`):
  - `video.ready` `{videoId, videoVersion, shopId, uploaderId, productId: string | null, visibility, durationSec, width, height, renditions: {name, width, height}[], hasSprite: boolean}`. Consumers: S28 (may tell the uploader), S32 (product has video flag, optional).
  - `video.failed` `{videoId, videoVersion, shopId, uploaderId, failureCode}`. Consumers: S28.
  - `video.deleted` `{videoId, videoVersion, shopId, productId: string | null}`. Consumers drop references.
  - No event carries a URL, key, token or credential; consumers fetch playback through the HTTP routes.
- Delivery contract for **S27** and **W02**: public master playlists are at `<video delivery origin>/p/<videoId>/master.m3u8` on the host named by the `video_cdn_url` setting (`stream.marketplace.dev`); unlisted at `/u/<videoId>/…` behind the credential.
- Queue: `video-transcode` carries `{videoId, task}` with a trace attribute. Nothing else is read by other capabilities.
- Modules for the apps: `VideoModule` (core: HTTP), `VideoWorkerModule` (worker: transcode consumer, the three jobs), `VideoProjectorModule` (projector: the three consumers). `VideoService` is no longer exported (no consumer outside the domain uses it; today only the barrel does). The barrel stops exporting `MediaProcessor` and `Sql` in S29's change; this capability exports no model, repository or storage type.
- Rate-limit policies (S50 registry): `video.start.shop` 20/hour per shop (fail closed), `video.write.shop` 120/min per shop (fail closed), `video.playback.ip` 600/min per address (fail open).
- Scheduled jobs (registered with S49): `media.video-expire-uploads` (every 5 min), `media.video-requeue-stuck` (every minute), `media.video-purge` (every 5 min).
- Ownership registry: `Video`, `VideoTask` (already `domain:media`), plus new `VideoStatusHistory`, `VideoShopState` → `domain:media`.

**Requires**:

- **S03** (`tenancy`): `ShopScoped(permission)` with `products.read` and `products.write` and the status gate (`403 shop_suspended`, `409 shop_offboarding`, hidden shop existence); events `tenancy.shop_deleted` v1 `{shopId}` and `tenancy.shop_status_changed` v1 `{shopId, from, to, reason?, shopVersion}`. No R1 call to tenancy is made on the playback path (R3 copy instead).
- **S05** (`catalog`): `ProductQueryService.getProductsByIds(ids: ProductId[], options?: { shopId?: ShopId }): Promise<Map<ProductId, ProductDto>>` with `status: 'ACTIVE' | 'ARCHIVED'`, `isSandbox`, `shopId`; event `catalog.product_deleted` v1 `{productId, shopId, productVersion}`.
- **S01** (`identity`): the authentication guard (`Firewall`) with the signed-in user's ID and the `anonymous` option for playback.
- **S53**: `outbox.append(event)` in the domain's transaction; the consumer framework (envelope check, zod validation, DLQ, version guard or inbox); the queue port with delivery count, `enqueue` with a delay and message attributes (trace).
- **S49**: single-run scheduled jobs with leases. **S50**: the three policies. **S54**: problem+json filter with `code`, request context, metrics registry, startup config validation, structured logging with redaction, graceful shutdown.
- **Infrastructure ports (no S-capability owns them; the implementation extends them, `questions.md`)**: object storage — list stored parts of a multipart upload, presign one part with an exact length, `head` returning size, content type and cache-control, `put` with a cache-control argument and a timeout, delete by prefix in batches, abort multipart; a **delivery-edge port** — sign a credential for a path pattern and expiry, request removal of a path from the edge cache; the task queue port's delayed `enqueue`. The encoder and inspector runner stays in the domain's `infra/` (only media uses it, X.7).
- **Web (W04 / W02)**: the seller screen uploads parts directly, retries a failed part, resumes through `GET …/upload`, polls `GET …/videos/:id` until `READY`, reads `code` values (FR-073) and never builds delivery URLs; the product page player calls `GET /videos/:id/playback` (with `?token=` for unlisted), sends credentials on segment requests for unlisted videos, and re-requests playback before `expiresAt`.
- **S39** (analytics ingestion): player beacons are sent there; this capability exposes no view-count route.
- **S48** (BFF): composes `GET /products/:productId/videos` for the product page.

## Assumptions

- Output is H.264 (main) plus AAC stereo in HLS with 4-second segments; HEVC, AV1, DASH and DRM are not offered. Input containers are MP4, QuickTime and WebM; the declared type is advisory and the real format is decided from the bytes.
- The 20 GiB source limit, 64 MiB parts, 1-hour part permissions, 24-hour session, 10 pending uploads per shop, 10 videos per product, 2-hour and 3,840×2,160 limits, 5-minute lease, 3 attempts, 30 s and 120 s backoff, 6-hour processing limit, 7-day failed retention, 4-hour credential and the sprite grid are defaults taken from the notes and the existing code; they are configuration, not contract.
- Parallelism is per rendition (the existing design), not per time chunk of one rendition: the notes' chunk split pays off only for very long sources, and the 2-hour limit keeps a single rendition within the 3-hour task limit. A managed transcoder (AWS Elemental MediaConvert) is the documented production alternative (ADR in `SD-26`): the task graph and state model stay the same and the encoder tasks become service jobs.
- No malware scan is made of videos: the source is private and never served, and every served byte is re-encoded by the pipeline from the decoded streams, so an infected container cannot reach a viewer. This departs from the general "scan before making available" lesson of design 27 only because nothing of the upload is made available.
- Visibility is fixed at creation because public and unlisted outputs live under different delivery paths (the CDN can require a signature for one path and not the other); changing it would require moving objects and invalidating caches.
- Unlisted means "anyone with the share link": the link carries a random token; the video ID alone is not enough. There is no paid or per-viewer access in this release.
- Credentials already issued for an unlisted video stay valid until they expire (at most 4 hours) after a delete; this is the documented takedown window for unlisted video.
- Turning a finished live stream into a video (`SD-26` "live → VOD") is not offered: S23 asks nothing of this capability. When it does, it will upload the recording through the same start/complete flow.
- Views are counted by analytics from player beacons, never by this capability's tables.
- The worker runs as a long-lived process on CPU-heavy instances (not a serverless function); concurrency is 2 tasks per instance.
- Operational artifacts (CDN behaviors and headers, lifecycle rules) are outside the API test suite (AS-60).
- The decisions behind every default are listed in `questions.md`; the ones that change behaviour that exists today are tagged `[BREAKING]` there.
