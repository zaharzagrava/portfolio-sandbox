# Research: S30 — Product video and VOD (domain `media`)

No `NEEDS CLARIFICATION` remains: `questions.md` defaults are accepted and the spec fixes the behaviour. This file records the design decisions the spec leaves open, with the facts read from the repository on 2026-10-13. Each: **Decision / Rationale / Alternatives**.

## Facts read (starting point)

- `video.service.ts` (418 lines) is the whole video application: raw SQL through `@InjectConnection`, four direct `sequelize.transaction` sites (lines 104, 155, 234, 376), ffmpeg and the CloudFront signer called directly. `video.module.ts` re-provides `VideoService` in the worker. `domain/dag.ts`, `domain/hls.ts`, `infra/ffmpeg.ts` are small and replaced or rewritten. `index.ts` exports `VideoModule`, `VideoWorkerModule` (S29 left them).
- S29 built the pattern to copy: `MediaStore` (abstract class with `media`, `gallery`, `tx`), `SequelizeMediaStore` over a `SqlRunner` and `TransactionRunner`, `MEDIA_PROBLEMS` + `ProblemCatalogModule.forFeature`, `definePolicies`/`@RateLimit`, `MediaMaintenanceJobs` (`declareJobType`, `upsertSchedule`, `@JobHandler`), projectors with `idempotency: 'natural'`, `MediaProjectorModule` that imports the database and clock only, `testing/media-app.ts` (MinIO `localhost:9210`, Redis `6400`, fault proxy, recording metrics/logger), `config/media-config.ts` (`ConfigRules`, `siteOf`).
- `ObjectStorage` already has `put(…, {cacheControl, timeoutMs})`, `head` (size, contentType), `list(prefix)`, `getStream(…, {timeoutMs})`, `createMultipartUpload` (returns one **unbound** URL per part), `completeMultipartUpload`, `abortMultipartUpload`. Missing for S30: `listParts`, per-part presign with exact length, `head` cache-control, `deletePrefix`, multipart create without presigning.
- `TaskQueue.enqueue(queue, body, {delaySeconds, attributes})` exists (0–900 s, FIFO options rejected on a standard queue); `consume(queue, handler, {concurrency, visibilityTimeoutSec, bodySchema})` extends visibility by heartbeat.
- `elasticmq.conf` already defines `video-transcode` (900 s, DLQ after 3 receives) and `video-transcode-dlq`.
- Tenancy exports `ShopScoped`, `ShopStatusChanged`, `ShopDeleted`; catalog exports `ProductQueryService`, `ProductDeleted`.
- `packages/contracts/src/media/video.ts` has only `videoPlaybackSchema` (W02 B-7, tested by `video-contracts.spec.ts`); the BFF has a loose `productVideosSchema` in `bff/upstream.ts`.
- `ffmpeg -version` fails in this workspace; `infra/docker/node/Dockerfile:50` installs ffmpeg for `APP=worker` only.

## R-1 Start: two transactions around one storage call
- **Decision**: (1) `TransactionRunner.run`: `pg_advisory_xact_lock(hashtextextended('video-pending:'||shopId,0))`, count `UPLOADING` rows of the shop, refuse with `409 pending_uploads_limit {limit:10,current}` at 10, insert the `Video` row (`UPLOADING`, server-generated id and source key, `sessionExpiresAt = now+24h`, `uploadId = NULL`) and the history row `null → UPLOADING`; commit. (2) Outside any transaction: product check (R1) **before** step 1; then `createMultipart` with a 5 s timeout. (3) One conditional update sets `uploadId` where `status='UPLOADING'`. On storage failure/timeout: transaction `UPLOADING → EXPIRED` (history row) and `503 storage_unavailable`. Part URLs are signed locally after step 3.
- **Rationale**: AS-05 needs the store to hold the invariant under `Promise.all`; III.3 forbids the storage call inside the transaction; AS-07 wants no usable slot after failure. A row with `uploadId NULL` is invisible to resume/complete (hidden `404`) and is expired by the job if the process dies between steps.
- **Alternatives**: one transaction around the storage call (holds a connection up to the timeout); a counter row per shop (extra table, repair job); `SERIALIZABLE` (retry storms).

## R-2 Keys and delivery layout
- **Decision**: one bucket, three disjoint prefixes built only in `domain/delivery-paths.ts` from ids and constants: source `vsrc/<videoId>/source` (private, never behind the CDN origin path rules), public outputs `p/<videoId>/…`, unlisted outputs `u/<videoId>/…`. Visibility decides the output prefix at creation (fixed). Output keys never contain client text. Per-attempt work lives under the output prefix: `…/<task>/a<attempt>/…` (e.g. `p/<id>/r/720/a2/index.m3u8`, `…/seg_00001.ts`); the master is `…/master.m3u8` (written by `package` from the recorded DONE outputs, so two package attempts write identical bytes); poster `…/poster/a<n>/poster.jpg`, sprite `…/sprite/a<n>/sprite.jpg` + `sprite.vtt`. Publish stores `Video.outputs` (JSON: master, poster, sprite|null, renditions[name,width,height,bandwidth]) so playback builds URLs from facts, not from a task row.
- **Rationale**: FR-044/AS-36 (source outside every delivery path), AS-26 (attempts never overwrite), AS-37 (immutable cache is safe because a key is never rewritten with different bytes).
- **Alternatives**: `videos/<id>/…` shared prefix (today, C-5); content-addressed output (libx264 is not bit-exact, so hashing needs a pass for no benefit).

## R-3 Part permissions bound to part number and exact length
- **Decision**: new port method `presignUploadPart(key, uploadId, partNumber, contentLength, expiresInSec)` using `UploadPartCommand` with `ContentLength` and the SDK presigner's `signableHeaders` containing `content-length` (so the length is in the signature). `createMultipart(key, contentType)` returns only the `uploadId`. 64 MiB parts, last part = remainder, ≤ 320 parts.
- **Risk / spike (WP-0)**: AS-08 (b) requires the store to refuse a ±1-byte body. S3 enforces a signed `Content-Length`; MinIO's behaviour must be proven against the real container before anything is built on it. **If MinIO does not enforce it**: stop after 5 attempts per the rule, write the blocker into `questions.md`; the application-level fallback is already in the design (complete compares the *storage's* part sizes with the expected lengths and answers `422 parts_mismatch`), but the AS-08 (b) test then cannot pass honestly and must be reported *blocked*, not weakened.
- **Alternatives**: presigned POST (no multipart); `x-amz-checksum` per part (client must hash 64 MiB parts first).

## R-4 Resume
- **Decision**: `GET /shops/:id/videos/:vid/upload` reads the row (shop predicate), then `listParts` (storage, no transaction), returns `uploadedParts` (number+size from storage), `missingParts`, fresh permissions for missing parts only, and the **unchanged** `expiresAt = sessionExpiresAt`. Closed states answer `409 upload_closed {status}`; `EXPIRED`, `DELETED`, unknown or foreign → hidden `404`. A part present with the wrong size counts as missing (its new permission overwrites it).
- **Rationale**: FR-008/AS-09; the session lifetime is never extended (FR-004).

## R-5 Complete: claim, assemble once, drive forward
- **Decision**: after the status matrix and the shop predicate: (a) `listParts` (storage); body etags/numbers vs storage → `409 upload_incomplete {missingParts}` or `422 parts_mismatch`; duplicate/unsorted/empty are schema errors (`400`). (b) conditional `UPLOADING → UPLOADED` (+ history) — the winner. (c) winner: `completeMultipart`, `head(source).size == sizeBytes` else transaction `UPLOADED → FAILED source_size_mismatch` + `video.failed`, source deleted after commit. (d) transaction `UPLOADED → PROCESSING` + `probe` task row `QUEUED` + history; commit; **then** `enqueue({videoId, task:'probe'}, {attributes:{traceId}})`. (e) A concurrent loser, seeing `UPLOADED`, polls the row (250 ms steps, ≤ 10 s) and answers with the then-current status; if still `UPLOADED` it drives (c)–(d) itself with an idempotent finalize: `head(source)` first (assembled with the right size → skip assembly; `NoSuchUpload` on completion → re-head), and (d) is a conditional update so at most one probe task and one message exist. The stuck sweep (c) uses the same finalize. Storage failure in (c) → `503 storage_unavailable`, status stays `UPLOADED`.
- **Rationale**: AS-10–AS-14, FR-009–FR-011; no storage call in a transaction; "one assembly" holds because only the winner assembles unless it died.
- **Alternatives**: a Redis lock (new failure mode); returning `202 {status:"UPLOADED"}` to the loser (contradicts AS-12).

## R-6 Task graph: pure, stored after `probe`
- **Decision**: `domain/dag.ts` validates and sorts (cycle, unknown dependency, duplicate name, self dependency → `GraphError` naming the tasks) and answers `ready(tasks)`; `buildGraph(rungs)` returns `poster`, `thumbnails`, `transcode:<rung>…`, `package` (after every rendition), `publish` (after `package`, `poster`, `thumbnails`). After `probe` succeeds, one transaction validates `probe` output with `probe-rules`, inserts the remaining tasks `PENDING`, claims every ready one (`PENDING → QUEUED` under `FOR UPDATE` on the video row) and commits; messages go out after commit. Task status is a closed union with `assertNever`.
- **Rationale**: FR-020–FR-023; `FOR UPDATE` on the video row serialises fan-in so `package` is claimed once (AS-22).

## R-7 Claim, lease, heartbeat
- **Decision**: claim = one conditional update: `status='QUEUED'` **or** (`status='RUNNING'` and `leaseExpiresAt < now`) → `RUNNING`, `attempts = attempts+1`, `claimedAttempt = attempts+1`, `leaseExpiresAt = now+5 min`, returning the row; zero rows → read the row and answer `busy` (RUNNING with live lease; no attempt consumed), `stale` (`DONE/FAILED/SKIPPED/CANCELLED`, or the video is no longer `PROCESSING`). Attempt cap: the claim refuses `attempts >= 3` and fails the task. Heartbeat every 60 s: `UPDATE … SET leaseExpiresAt WHERE id AND claimedAttempt = $n AND status='RUNNING'`; 0 rows → abort the child (lost the lease).
- **Rationale**: FR-024, AS-23; a running task holds no connection (statements are short).

## R-8 Fenced completion, per-attempt outputs, clock
- **Decision**: completion is `UPDATE VideoTask SET status='DONE', output=$o WHERE id AND status='RUNNING' AND claimedAttempt=$n`; 0 rows → the attempt lost: delete its objects (`deletePrefix(<task>/a<n>/)`), metric `stale`. The `now` value in claim/heartbeat/sweep SQL is the injected `Clock` value passed as a parameter (as S29), so the frozen clock drives lease tests; every comparer in the fleet uses the same kind of value and the lease (5 min) is far larger than clock skew. This honours the spec edge case ("one clock for write and compare") without a second time source.
- **Alternatives**: SQL `now()` (cannot be frozen; the 30 s/120 s and 24 h boundaries become untestable).

## R-9 Retry, backoff, failure vocabulary
- **Decision**: `domain/task-limits.ts`: `timeoutMs(task, durationSec)` (`max(600 s, 3×duration)` ≤ 3 h; inspect 60 s; poster/sprite 120 s; package 60 s), `backoffSec(attempt)` = 30 then 120, `classify(error)` → `permanent | transient | storage | timeout | shutdown`. On failure: permanent (probe rules, not a video) → task `FAILED`, video `FAILED` with the code, no retry; transient with attempts left → task `QUEUED`, `enqueue(..., {delaySeconds})` after commit; last attempt → `FAILED`, others `CANCELLED`, video `FAILED` (`transcode_failed` | `storage_unavailable` | `task_timeout`), `video.failed`. Optional `thumbnails` → `SKIPPED` after its last attempt. Shutdown abort → conditional back to `QUEUED`, `attempts - 1`, lease cleared, no delay. `failureCode` is a closed union; the internal error text (≤ 500 chars) is stored on the task/video and never returned.
- **Rationale**: FR-026–FR-028, IV.6 (transient only), AS-21/24/62.

## R-10 Child processes
- **Decision**: `infra/child-process.ts` `runBounded({command,args,timeoutMs,signal,maxStdout:1 MiB,maxStderrTail:4 KiB})` using `spawn(cmd, args, {shell:false, stdio})`, a ring buffer for stderr, stdout truncated at the cap (streaming to a file path for large outputs), `SIGKILL` on timeout/abort then wait for `close`, rejecting with typed errors (`TaskTimeout`, `Aborted`, `ExitNonZero{code}`). `ffmpeg-transcoder.ts` builds argument lists from `domain/hls.ts` (never string-concatenated commands) and implements `TranscoderPort` (`probe`, `transcode`, `poster`, `sprite`). The stub encoder used by tests is a script placed first on `PATH` (the adapter resolves binaries by name).
- **Rationale**: P0203; AS-25 (process gone, bounded memory, no shell).

## R-11 HLS accuracy
- **Decision**: output frame rate is fixed per video (`fps = clamp(round(sourceFps), 24..60)` normalised through `-r`/`fps` filter), `-force_key_frames "expr:gte(t,n_forced*2)"`, `-sc_threshold 0`, `-hls_time 4`, `-hls_playlist_type vod`, `-hls_flags independent_segments`, `-g/-keyint_min` set from the fixed fps, rotation applied before scale, even output sizes by `scale=-2:h`, `-an` for silent sources. `ladderFor(w,h)` per AS-17 (rungs ≤ source height, never enlarged; below 240 one rung at the source's even height). Rendition output records measured peak/average bitrate from the segment sizes/durations, the real size/fps, and codecs derived from the actual profile/level (`avc1.4d40xx`) and audio presence. `buildMaster(renditions)` is pure, ascending by bandwidth.
- **Rationale**: FR-030–FR-032, AS-17–AS-19, SC-003/SC-007. Segment boundaries match across renditions because keyframes are at fixed times independent of the source fps.

## R-12 Package, publish, optional sprite, progress
- **Decision**: `package` lists each rendition's playlist and last segment in storage (non-empty) before writing the master; missing → retryable failure, no master. `publish` runs one transaction: `UPDATE Video SET status='READY', outputs=…, version=version+1 WHERE id AND status='PROCESSING' AND NOT EXISTS (task required AND status <> 'DONE')`, history row, `outbox.append(video.ready)`; 0 rows → no event (a concurrent delete wins). `thumbnails` produces a 160×90 tile sheet with 10 columns and a WebVTT, interval = max(10 s, ceil(duration/100)). `progress = {stage: name of the running task or 'queued', tasksDone, tasksTotal}` computed from task rows (`tasksTotal` is 1 before the graph exists); `tasksDone` counts `DONE` and `SKIPPED`, so it never decreases.
- **Rationale**: FR-033–FR-037, AS-27–AS-30.

## R-13 Playback and the signed credential
- **Decision**: `GET /videos/:id/playback` (anonymous `Firewall`, `@RateLimit('video.playback.ip')`): one read of `Video` + `VideoShopState` by id; `READY`, shop not suspended, and for `unlisted` a constant-time (`timingSafeEqual` over equal-length buffers) token match, else the identical `404 video_not_found`. Public: `Cache-Control: public, max-age=60`, no cookie. Unlisted: `DeliveryEdge.signCredential({resourcePattern: <delivery origin>/u/<id>/*, expiresAt: now+4h})` returns the three CloudFront cookies; set `Secure; HttpOnly; SameSite=None; Path=/u/<id>/; Domain=<video_cookie_domain>; Expires`, `Cache-Control: private, no-store`. No signing key → `503` with a generic detail, never a URL or cookie. All time from `Clock`. Metric `video_playback_total{visibility,result}`; nothing is written.
- **Rationale**: FR-040–FR-045, AS-31–AS-35, AS-40. The signer is behind the `DeliveryEdge` port; the test adapter uses the real signer with a throwaway RSA pair so the test verifies the signature.

## R-14 Originals never served
- **Decision**: the controllers' response builders never read `sourceKey`/`uploadId`; the owner view and start/resume responses are built by explicit mappers in `application/video-view.ts` from a whitelist; an e2e scan (AS-36) greps every response, header and cookie for the source key, the bucket host and the upload id. `delivery-paths.spec.ts` proves the three prefixes pairwise disjoint (no prefix of another) and that a client string never reaches a key. Error responses use the S29-style catalog (generic 5xx).
- **Rationale**: FR-003, FR-044, FR-073.

## R-15 Product page list
- **Decision**: `GET /products/:productId/videos` (anonymous, `video.playback.ip`): R1 `getProductsByIds([id])` once (`ACTIVE`, `!isSandbox`) + `VideoShopState` for the product's shop; then one indexed query (`productId`, `status='READY'`, `visibility='public'`, newest first, limit 10). `Cache-Control: public, max-age=15`. The response is parsed by the contract `productVideosSchema` (the BFF's name).
- **Rationale**: FR-047, AS-38; keeps R1 and R3 only.

## R-16 Management
- **Decision**: seller routes use `@ShopScoped('products.read'|'products.write')`; every repository method takes `shopId` and puts `id AND shopId` in the predicate; a missing row, another shop's row and a hidden status answer one `404 video_not_found` via one helper (byte-identical apart from the request id). List: keyset on `(createdAt DESC, id DESC)`, cursor = base64url JSON `{c,i,s,f}` (created, id, shop, filter hash) rejected with `400 invalid_cursor` when malformed or issued for another shop/filter; default 20, max 50. Edit: `UPDATE … WHERE id AND shopId AND version=$e` (+1); 0 rows → `409 version_conflict {currentVersion}`. Product link: R1 `getProductsByIds([p],{shopId})` outside any transaction, then a transaction taking `pg_advisory_xact_lock('video-product:'||p)`, counting non-deleted videos of `p` (≤ 10 else `409 product_video_limit`) and updating. Retry: conditional `FAILED → PROCESSING` + `retryCount < 3` (`409 retry_limit`), `failureCode ∈ retryable` (`409 not_retryable`), `objectsPurgedAt IS NULL` (`409 source_purged`); failed and cancelled tasks → `PENDING`, attempts 0; ready ones claimed in the same transaction and messaged after commit. Delete: conditional `status <> 'DELETED' → DELETED`, open tasks `CANCELLED`, `video.deleted` outbox row in the same transaction; abort of an `UPLOADING` multipart after commit.
- **Rationale**: FR-050–FR-056, AS-42–AS-48.

## R-17 Jobs
- **Decision**: `video-maintenance.jobs.ts` mirrors S29: `declareJobType` ×3, `upsertSchedule` (`0 */5 * * * *`, `0 * * * * *`, `0 */5 * * * *`), `@JobHandler(..., {concurrency:1, fleetConcurrency:1})`, `InvalidScheduleError` caught. Expire: select ≤ 200 `UPLOADING` older than `sessionExpiresAt`, per row conditional `→ EXPIRED` + history, then abort multipart outside the transaction. Sweep: (a) expired-lease `RUNNING` → `QUEUED` + message, (b) `QUEUED` untouched ≥ 5 min and not re-sent within the last minute (column `lastSentAt`) → message, (c) `UPLOADED` older than 5 min → finalize (R-5), (d) `PROCESSING` with all required tasks done → queue `publish`, (e) `PROCESSING` > 6 h → `FAILED processing_timeout`. Purge: ≤ 200 videos in `DELETED`/`EXPIRED`/(`FAILED` older than 7 days, `objectsPurgedAt IS NULL`); delete prefixes, ask the edge to drop `p/<id>/*` for a deleted public video (failure logged, retried next run because `edgePurgedAt` stays null), set `objectsPurgedAt`; never touches other states.
- **Rationale**: FR-036, FR-060, FR-061, AS-49–AS-52; S49 lease gives single-run, conditional updates make a double run harmless.

## R-18 Consumers
- **Decision**: `VideoProjectorModule` imports the database and clock only (like S29's). Three projectors: `video-product-deleted` (natural: `UPDATE Video SET productId=NULL, version=version+1 WHERE productId=$p AND shopId=$s`), `video-shop-deleted` (batches of 50 in a transaction each: `DELETED`, history, `video.deleted` outbox row, tasks `CANCELLED`; multipart abort is left to the purge job because a projector holds no storage), `video-shop-status` (version-guarded upsert into `VideoShopState`: `… ON CONFLICT (shopId) DO UPDATE … WHERE excluded.shopVersion > VideoShopState.shopVersion`). Invalid/foreign payloads follow the S29 `matchOrNull` + dead-letter pattern.
- **Note**: AS-54 says uploads are aborted after commit; the projector has no storage, so the purge job aborts open multipart uploads of `DELETED` videos (the same run that removes objects) — within the same ≤ 5 min window. Recorded as a deliberate boundary choice (projector stays free of storage/queue modules, as S32 required of S29).

## R-19 Migrations (expand → backfill → contract)
- See `data-model.md`. Expand: new columns nullable/defaulted, new tables, new indexes `CONCURRENTLY`-style where the repo's helper allows, status check widened (`UPLOADED`, `EXPIRED`, `DELETED`), `VideoTask.status` check widened (`CANCELLED`). Backfill: legacy rows get `version=1`, `visibility='public'`, `sizeBytes=0`, `contentType='video/mp4'`, `partSize=67108864`, `sessionExpiresAt=createdAt+24h`. Legacy objects live under `videos/<id>/…`, which the new layout (R-2) never serves: **decision, no legacy playback** — the sandbox holds no production videos (the old code was never reachable by sellers beyond a start/complete pair), so legacy `UPLOADING` rows become `EXPIRED`, legacy `PROCESSING` rows `FAILED` (`processing_timeout`, retryable only with a source, which the old layout keeps at `videos/<id>/source`: `sourceKey` is backfilled with that value so a retry can still read it), legacy `READY` rows stay `READY` but without `outputs`, so playback answers `404` until re-uploaded; this is recorded in `gaps.md` under "Spec changes" only if a human-signed page says otherwise (none exists). Contract: drop the FKs to `Shop` and `User`, drop `error`.
- `lock_timeout` set; down migrations provided.

## R-20 Events
- `domain/video-events.ts` uses `defineEvent` with schemas from `packages/contracts/src/media/video-events.ts` (`video.ready`, `video.failed`, `video.deleted`, version 1, topic `media.events`, key `aggregateId = videoId`). `OutboxService.append` runs inside the state change's `TransactionRunner.run`. `videoVersion` = the row's version after the change. No URL/key/token in any payload (asserted by a scan test). `videoEventSchemas` exported from the barrel and the contracts package.

## R-21 Observability and redaction
- `infra/video-observability.ts` registers `video_task_total{task,result}`, `video_task_seconds{task}`, `video_upload_to_ready_seconds`, `video_status_transitions_total{from,to}`, `video_stuck_recovered_total{kind}`, `video_playback_total{visibility,result}`, `video_queue_age_seconds`; task logs are structured with `videoId, task, attempt, result, requestId|traceId`; the trace id travels as a message attribute. The access-log redaction rule for the `token` query parameter is added to the existing S54 redaction configuration (a list of query keys) rather than a new mechanism; if the S54 mechanism has no query-key rule, the plan adds one key to its list and records a sibling bullet.

## R-22 Configuration and shutdown
- `video-config.ts` (`ConfigRules`): production requires `media_bucket`, `video_cdn_url`, `video_cookie_domain`, `cloudfront_key_pair_id`, `cloudfront_private_key`; `video_cdn_url`'s host must be a different site from `front_host`/`backend_host` and be contained in `video_cookie_domain`; the cookie domain must contain the API host; non-production may leave signing unset (unlisted playback → `503`). Messages name keys, not values. Shutdown: `VideoWorker.beforeApplicationShutdown` stops taking messages, aborts the controller (kills children, which re-queue without an attempt through the shutdown classification of R-9), then lets Nest close the pools last; a 30 s overall deadline is asserted in AS-62.

## R-23 Test harness
- `testing/video-app.ts` composes `createMediaApp` pieces (MinIO, Redis, fault proxy, recording metrics) with `VideoModule` + `VideoWorkerModule` + `VideoProjectorModule`, the in-memory transport for `video-transcode`, a frozen `Clock`, a throwaway RSA pair and the in-memory edge (removal spy). `test-videos.ts` generates tiny real clips with ffmpeg lavfi (`testsrc2`, `sine`), varying fps; truncated/text/audio-only files by byte operations. `stub-encoder.ts` writes an executable shell script into a temp dir put first on `PATH` (modes: sleep forever, flood stderr/stdout, exit 1 on the n-th call). `outbox-trigger.ts` creates/drops the failing trigger in a `finally`. Waves are driven by delivering every queued message of a wave concurrently through the real consumer entry point.

## Traceability: gaps.md item → work package

| Gap | WP | Gap | WP |
|---|---|---|---|
| A1 | 2, 6 | C-1–C-3 | 8 |
| A2, A3 | 6 | C-4 | 8, 4 |
| A4 | 6 | C-5 | 4, 8 |
| A5, A6 | 6 | C-6 | 4, 8 |
| A7 | 10 | C-7 | 4, 7 |
| A8 | 6, 10 | C-8 | 6, 8 |
| B1, B2 | 7 | C-9 | 8, 9 |
| B3, B4, B5 | 7 | D1, D2 | 9 |
| B6 | 3, 7 | D3 | 10 |
| B7 | 5, 7 | D4 | 10 |
| B8, B9 | 3, 7 | D5 | 10 |
| B10, B11 | 7 | D6 | 4, 5 |
| B12 | 10 | D7 | 11 |
| B13 | 7, 11 | E1–E4 | 1 |
| B14 | 3 | F1, F2 | 12 |
| B15 | 5 | F3 | sibling bullet (W04/W02) |
| F4 | 0, 5 | G1–G6 | 4, 6, 10, 2 |
| G7 | 1 | G8, G9 | 13, 0 |
| G10 | sibling bullet | Debt D-6/D-7/D-8/D-12 | 5, 12, 11, 1 |
