# Tasks: S30 — Product video and VOD (domain `media`)

**Input**: `/opt/sdd/repo/specs/domains/S30-video/` — plan.md, spec.md (US1–US6), test-plan.md, gaps.md, questions.md (defaults accepted), research.md (R-1–R-23), data-model.md, contracts/video-api.md, contracts/events.md, quickstart.md.

**Tests**: required (test-plan.md, constitution VII). Order inside every story: failing test task → code task. A test must be able to fail (L-003); a missing ffmpeg is reported *blocked*, never skipped.

## Conventions

- Paths are under `packages/backend/` unless they start with `packages/contracts/`, `docs/`, `infra/`, `scripts/` or `specs/`. `M/` = `libs/domains/media/`.
- E2E runs: `/opt/sdd/repo/scripts/sdd/test-spec.sh M/<file>`; unit: `pnpm test -- M/domain`. Run backend commands from `packages/backend`. One e2e file per process (L-008). Same test fails 5 times → write blocker in `questions.md`, stop.
- Undo by hand edit only (no checkout/restore/reset/stash/clean). Never create/edit `*.reviewed.json`.
- Transactions only through `TransactionRunner.run` / `@Transactional`; no new `sequelize.transaction`; `.tx.baseline` 4 → 0.
- Every test creates its own shop, user, product, video (L-005/L-006); faults and stubs removed in `afterEach`/`finally` (L-013).
- Story labels: US1 upload, US2 pipeline, US3 delivery, US4 management, US5 lifecycle, US6 events/ops/boundaries.

---

## Phase 1: Setup (WP-0 prerequisites and spikes)

- [X] T001 Write the living-spec page rules first (rule 0): create `docs/spec/capabilities/S30-video.md` modelled on `docs/spec/capabilities/S29-photos.md` (front matter, purpose, entry points, rules, behaviours; no `[proof:]`/`[code:]` anchors yet — added in T133). No `*.reviewed.json`.
- [X] T002 Check `ffmpeg -version` and `ffprobe -version`; record the result in `specs/domains/S30-video/questions.md` under a "Blocked" note if missing (plan risk b: report *blocked*, the 5-attempt rule does not apply to a missing binary). Add `ffmpeg`/`ffprobe` presence guard helper `M/testing/require-ffmpeg.ts` that **fails under `CI=true`** and marks the suite blocked locally with a loud warning (G9, F1).
- [X] T003 [P] Spike (R-3): in `M/video-upload.e2e-spec.ts` (first `describe` block, kept as AS-08), prove against real MinIO that a presigned `UploadPart` URL with a signed `Content-Length` rejects ±1 byte. If MinIO does not enforce it, apply the fallback and stop rule in research R-3 and note it in `questions.md`.
- [X] T004 [P] Doctor/readiness check (L-002, L-011): extend the doctor so it fails when queue `video-transcode` or `video-transcode-dlq` (in `infra/docker/elasticmq/elasticmq.conf` lines 61–62) or the media bucket is missing in the test stack; run it and keep the output.
- [X] T005 [P] Add `fast-check` usage check: confirm it resolves in `packages/backend` (already used by S29); no new dependency.

---

## Phase 2: Foundational (blocking: data model, contracts, domain, ports, harness)

### Migrations and ownership (WP-1; E1–E4, D-12)

- [X] T006 Write the migration test first: `M/video-migration.e2e-spec.ts` (describe `Video migration`) — apply expand→backfill→contract on a fresh DB, assert every `data-model.md` column/CHECK (e.g. `sizeBytes` `CHECK 1024..21474836480`, `retryCount` `CHECK 0..3`, `shareToken varchar(43)` with `CHECK (visibility='unlisted') = (shareToken IS NOT NULL)`, `title varchar(200) NOT NULL`, `internalError varchar(500)`), the five indexes, no FK from `Video`/`VideoTask` to `Shop`/`User`, and down-migration; plus a unit comparison of CHECK vocabularies with the TypeScript unions (`M/domain/video-status.spec.ts` later).
- [X] T007 Create `migrations/<ts>-video-s30-expand.js` (R-19): new `Video` columns (`failureCode`, `internalError`, `retryCount`, `sourceKey`, `uploadId` NULL, `sizeBytes`, `contentType` in (`video/mp4`,`video/quicktime`,`video/webm`), `partSize` 67108864, `sessionExpiresAt`, `shareToken`, `productId`, `outputs jsonb`, `objectsPurgedAt`, `edgePurgedAt`, `readyAt`, `version int NOT NULL DEFAULT 1`), widened `status` CHECK (`UPLOADING`,`UPLOADED`,`PROCESSING`,`READY`,`FAILED`,`EXPIRED`,`DELETED`), `VideoTask` columns (`claimedAttempt`, `leaseExpiresAt`, `lastSentAt`, `output`, `internalError`, `CANCELLED`, UNIQUE `(videoId,name)`), tables `VideoStatusHistory` (actorType CHECK in user/system/worker, index `(videoId, createdAt)`) and `VideoShopState`, the five indexes of data-model.md, with `lock_timeout` (III.11).
- [X] T008 Create `migrations/<ts>-video-s30-backfill.js`: backfill new NOT NULL columns for existing rows (`sourceKey = 'vsrc/<id>/source'`, `partSize`, `sessionExpiresAt`, `version = 1`, `error` → `internalError`), batched.
- [X] T009 Create `migrations/<ts>-video-s30-contract.js`: set NOT NULLs, drop the FKs from `Video` to `Shop` and `User` (columns stay plain UUIDs), drop old `error` column, down-migration restores nullable shape.
- [X] T010 Register `VideoStatusHistory` and `VideoShopState` under `domain:media` in `db/ownership.ts` (E2); run `pnpm check:table-ownership --strict` → 0 for `media`.
- [X] T011 Update `docs/work/architecture/domain-map.md` media section: emits `video.ready`/`video.failed`/`video.deleted`; depends on tenancy (`ShopScoped`, `tenancy.shop_deleted`, `tenancy.shop_status_changed`) and catalog (`getProductsByIds`, `catalog.product_deleted`) (G7).
- [X] T012 Run the migration test T006 until green; apply migrations to the test DB (L-011) and re-run on a fresh stack later (T130).

### Contracts (WP-2; A1, G6, S48 follow-up)

- [X] T013 [P] Write contract parity spec `M/video-contracts.spec.ts` (keep W02 B-7 public/unlisted/no-sprite playback body checks, L-017) extended: each of the eleven schemas accepts the contract examples and rejects unknown fields (strict request schemas), `videoEventSchemas` equals `defineEvent` payloads, problem codes table equals `video-api.md`.
- [X] T014 Create `packages/contracts/src/media/video.ts`: `videoStartRequestSchema` `{title, sizeBytes, contentType, visibility, productId?}` strict; `videoStartResponseSchema`; `videoUploadStateSchema`; `videoCompleteRequestSchema` (non-empty, strictly ascending parts); `videoCompleteResponseSchema`; `videoOwnerSchema`; `videoListSchema`; `videoPatchRequestSchema` `{title?, productId?: string|null, expectedVersion}` strict; `videoPlaybackSchema` (keep `spriteUrl` tolerant of absence); `productVideosSchema` `{items:[{videoId,title,posterUrl,durationSec}]}`; problem-code vocabulary.
- [X] T015 [P] Create `packages/contracts/src/media/video-events.ts` with `videoEventSchemas` for `video.ready`, `video.failed`, `video.deleted` exactly as `contracts/events.md` (each with `videoVersion`; no URL/key/token/upload id).
- [X] T016 Move `productVideosSchema`: delete its definition from `packages/contracts/src/bff/upstream.ts`, keep the exported name via the package root; update importers `packages/contracts/src/bff/product-page.ts:14`, `libs/composition/bff/upstream/endpoints/video.ts`, `libs/composition/bff/testing/fixtures.ts` (fixtures use the real shape so drift shows as `UPSTREAM_INVALID`). Run the S48 BFF specs and contract parity T013.

### Domain (pure; WP-3; B6, B8, B9, B14) — tests first

- [X] T017 [P] Unit spec `M/domain/video-status.spec.ts` (`video status machine`): every from/to pair against the legal table (data-model status machine; `DELETED` terminal), CHECK-vocabulary/union parity (AS-10).
- [X] T018 [P] Unit spec `M/domain/dag.spec.ts` (`task graph`): order, cycle, unknown dependency, duplicate name, self dependency, readiness with `SKIPPED`/`FAILED`/`CANCELLED`; `fast-check` property (random acyclic graph sorts with dependencies first; one back edge always detected) (AS-16, B14).
- [X] T019 [P] Unit spec `M/domain/hls.spec.ts` (`HLS ladder and master playlist`): `it.each` over source heights 2160…144 and odd widths, aspect/even-size, no upscale (lowest rung at source size), lowest-rung bitrate cap; master builder from measured peak/average/resolution/frame rate/codecs, audio-less has no audio codec (AS-17, AS-19).
- [X] T020 [P] Unit spec `M/domain/probe-rules.spec.ts` (`source validation`): `it.each` over every failure code and boundary (7,200 s, 3,840×2,160, 1 s, 16×16) (AS-20).
- [X] T021 [P] Unit spec `M/domain/task-limits.spec.ts` (`task time limits and backoff`): backoff 30 s / 120 s (≤ 900), `max(600 s, 3×duration)` capped at 3 h, probe 60 s, poster/sprite 120 s, package 60 s, lease 5 min, `PROCESSING` limit 6 h (AS-24, AS-25).
- [X] T022 [P] Unit spec `M/domain/delivery-paths.spec.ts` (`delivery path builders`): `vsrc/`, `p/`, `u/` prefixes pairwise disjoint; no client string in any key; per-attempt output locations differ (`it.each`) (AS-36, AS-26).
- [X] T023 Create `M/domain/video-status.ts` (closed union, legal transition table, helpers) — make T017 pass.
- [X] T024 [P] Create `M/domain/dag.ts` rewrite (reject duplicate names and self dependencies, `SKIPPED`/`CANCELLED` readiness) — T018 passes.
- [X] T025 [P] Create `M/domain/hls.ts` rewrite (fixed-time keyframes, constant output frame rate, no upscale, master builder from measured values) — T019 passes.
- [X] T026 [P] Create `M/domain/probe-rules.ts` — T020 passes.
- [X] T027 [P] Create `M/domain/task-limits.ts` — T021 passes.
- [X] T028 [P] Create `M/domain/delivery-paths.ts` — T022 passes.
- [X] T029 [P] Create `M/domain/video-errors.ts` (failure-code vocabulary: retryable `transcode_failed`, `task_timeout`, `storage_unavailable`, `processing_timeout`; permanent `not_a_video`, `no_video_stream`, `duration_exceeded`, `duration_too_short`, `resolution_exceeded`, `source_size_mismatch`; problem-code table with HTTP status), `M/domain/video-events.ts` (`defineEvent` ×3), `M/domain/video-ports.ts` (`VideoStore`, `TranscoderPort`, `DeliveryEdge` token). `domain/` imports no `infra/`, `sequelize`, SDK (I.3).
- [X] T030 Run `pnpm test -- M/domain` and `pnpm exec tsc --noEmit`.

### Infrastructure ports (WP-4; G1, G2, C-5–C-7, D6) — tests first

- [X] T031 [P] Port spec for storage additions `libs/infrastructure/storage/object-storage.port.spec.ts` (against in-memory and real MinIO): `listParts`, `presignUploadPart` with exact length, `head` returning size + cache-control, `put` with cache-control and timeout, `deletePrefix`, per-call timeouts; additive, S29 behaviour unchanged.
- [X] T032 Extend `libs/infrastructure/storage/{object-storage.port.ts,s3-object-storage.ts,in-memory-object-storage.ts}` additively — T031 passes, S29 media specs still green.
- [X] T033 [P] Port spec `libs/infrastructure/delivery-edge/delivery-edge.spec.ts`: signed credential for a path pattern (signature verifiable with the throwaway RSA pair, scope one video, 4 h), path removal request spy, missing key → typed error (never an unsigned URL).
- [X] T034 Create `libs/infrastructure/delivery-edge/{delivery-edge.port.ts,cloudfront-delivery-edge.ts,in-memory-delivery-edge.ts,index.ts}` using `@aws-sdk/cloudfront-signer`, `Clock` injected (no `Date.now()`); T033 passes.
- [X] T035 [P] Config test `libs/common/config/video-config.spec.ts`: `video_cdn_url`, `video_cookie_domain` (must contain API and delivery hosts), `cloudfront_key_pair_id`, `cloudfront_private_key` validated at startup in production; non-production allows unsigned mode (→ 503 for unlisted); `media_cdn_url` no longer used by video (AS-58).
- [X] T036 Implement settings in `libs/common/config/{types.ts,video-config.ts,config-rules.ts,index.ts}` (S54 `ConfigRules` mechanism); T035 passes.

### Repositories, runner, harness (WP-5; B15, B7, D-6, F4)

- [X] T037 Create `M/infra/pg-video-repository.ts` and `M/infra/pg-video-task-repository.ts` (all SQL, every lookup carries `shopId` for seller paths, conditional updates asserting one row, history rows, version bumps, advisory-lock quota helpers) and `M/infra/video-store.ts` implementing the `VideoStore` port; use `TransactionRunner.run` only.
- [X] T038 [P] Create `M/infra/child-process.ts`: bounded runner (argument list, no shell, SIGKILL on timeout/abort/shutdown, 4 KB stderr / 1 MB stdout kept, process-gone assertion helper).
- [X] T039 [P] Create `M/infra/ffmpeg-transcoder.ts` implementing `TranscoderPort` (replaces `M/infra/ffmpeg.ts`: probe, poster, sprite+vtt, rendition with fixed-time keyframes and normalised frame rate, no audio flags for silent sources, per-attempt output keys).
- [X] T040 [P] Create `M/infra/video-observability.ts`: nine metrics (names per AS-57/spec), structured logs with `videoId`/`task`/`attempt`, trace propagation from the queue attribute `traceId`; add `token` to the access-log redaction key list (AS-41).
- [X] T041 Create test harness `M/testing/video-app.ts` (compose from `createMediaApp` pieces: MinIO, Redis, TCP fault proxy, recording metrics, `VideoModule`+`VideoWorkerModule`+`VideoProjectorModule`, in-memory `video-transcode` transport that can deliver concurrently/twice/delayed, frozen `Clock`, throwaway RSA pair, in-memory edge with removal spy), `M/testing/test-videos.ts` (tiny real clips via lavfi `testsrc2`/`sine`, fps 24/25/30/50/60, 6 s 720p; truncated/text/audio-only by byte ops), `M/testing/stub-encoder.ts` (executable first on `PATH`: sleep forever, flood, exit 1 on n-th call), `M/testing/outbox-trigger.ts` (failing trigger created/dropped in `finally`). Reuse the fault proxy of `media-app.ts`.

**Checkpoint**: migrations applied, contracts, domain, ports, repositories and harness ready; `tsc` clean.

---

## Phase 3: User Story 1 — Seller uploads a large video and can resume it (P1) 🎯 MVP

**Goal**: start, resume, complete (A1–A8, B13). **Independent test**: `video-upload.e2e-spec.ts`, two shops, real MinIO parts.

### Tests first (all in `M/video-upload.e2e-spec.ts`, describe `Video upload API`; run before the code, expect red)

- [X] T042 [US1] AS-01 start: 201 body parsed by `videoStartResponseSchema`, row + history row, part count/lengths, no key or upload id in body, body ≤ 4 KiB, frozen `expiresAt`, share token only for unlisted.
- [X] T043 [US1] AS-02 start validation: table-driven bad bodies and both size boundaries (1024 B, 20 GiB), unknown fields, bad `contentType`/`visibility`/title length; nothing persisted, no storage call.
- [X] T044 [US1] AS-03 authorization/shop gate: 401, `VIEWER` 403, non-member and unknown shop identical 404, `SUSPENDED` 403, `DELETING` 409.
- [X] T045 [US1] AS-04 product link at start: own `ACTIVE` product 201; unknown/other shop's identical 404; `ARCHIVED` 409; exactly one `getProductsByIds` batch read.
- [X] T046 [US1] AS-05 pending quota: 9 held + `Promise.all` of 5 → one 201, four 409 `pending_uploads_limit`; free one → 201.
- [X] T047 [US1] AS-06 rate limits: 21st start 429 + `Retry-After`; 121st mutation 429; limiter store down (fault proxy on Redis) → 503 `service_unavailable`.
- [X] T048 [US1] AS-07 storage failure at start: fault proxy refuse and hang → 503 `storage_unavailable` within 5 s, quota unchanged, row `EXPIRED`; retry after recovery 201.
- [X] T049 [US1] AS-08 each part permission enforced by storage (extends T003 spike): real PUT with correct body, ±1 byte, another part's URL, expired URL, another video's URL; assert objects.
- [X] T050 [US1] AS-09 resume: 7 of 12 parts present → uploaded/missing lists, fresh URLs, unchanged `expiresAt`; closed states 409, hidden states 404.
- [X] T051 [US1] AS-10 complete: 202, storage-side part comparison, size check, two history rows, one `probe` task, one message after commit, no storage call inside a transaction (transaction-scoped query log).
- [X] T052 [US1] AS-11 incomplete/mismatched: 409 `upload_incomplete` with `missingParts`; wrong etag 422 `parts_mismatch`; duplicate/unsorted/empty 400; status unchanged, no message.
- [X] T053 [US1] AS-12 replay and concurrency: `Promise.all` of two completes → one transition, one assembly, one message; replays on `PROCESSING` 202, `READY` 200, `FAILED` 200 with `failureCode`.
- [X] T054 [US1] AS-13 illegal states/hidden access: `EXPIRED` 409, `DELETED`/unknown/other shop's identical 404, 400, 401, `VIEWER` 403.
- [X] T055 [US1] AS-14 storage failure and size mismatch: fault proxy on assembly → 503 and `UPLOADED`, retry succeeds (re-heads source, no `NoSuchUpload`, L-016); size mismatch → `FAILED` `source_size_mismatch`, source deleted, one `video.failed`.

### Implementation

- [X] T056 [US1] Create `M/video-rate-limit-policies.ts`: `video.start.shop` (20/window), `video.write.shop` (120), `video.playback.ip` (600) via `definePolicies`; writes fail closed, playback fails open.
- [X] T057 [US1] Create `M/application/video-view.ts` (owner view mapping, no location/upload id/encoder text) and `M/api/video-problem.ts` (problem+json from `video-errors.ts`, generic 5xx detail).
- [X] T058 [US1] Create `M/application/video-upload.service.ts` start: tx1 under per-shop advisory lock (quota ≤ 10 `UPLOADING`, row + history, share token 32 random bytes base64url for unlisted, product check via R1 `getProductsByIds` **before** the tx), storage multipart create **outside** any transaction with 5 s limit, tx2 stores `uploadId` (failure → row `EXPIRED`, 503); part permissions signed locally bound to part number and exact length, 1 h.
- [X] T059 [US1] Resume in `video-upload.service.ts`: list storage parts, re-sign missing, never move `expiresAt`, state codes.
- [X] T060 [US1] Complete in `video-upload.service.ts` (R-5): compare client list with storage list, conditional claim `UPLOADING → UPLOADED`, assemble once outside tx, head size check, tx `UPLOADED → PROCESSING` + `probe` task + history; send first message after commit; loser of a concurrent call waits ≤ 10 s then drives itself; replay matrix; size mismatch → `FAILED` + `video.failed`.
- [X] T061 [US1] Create `M/api/video.controller.ts` seller upload routes (`POST /shops/:shopId/videos`, `GET …/:id/upload`, `POST …/:id/complete`) behind `Firewall` + `@ShopScoped('products.write')`, bodies parsed by contract schemas through the global pipe, `@RateLimit`.
- [X] T062 [US1] Run `/opt/sdd/repo/scripts/sdd/test-spec.sh M/video-upload.e2e-spec.ts` until green (T042–T055).

**Checkpoint**: US1 independently testable.

---

## Phase 4: User Story 2 — Every video becomes a smooth adaptive stream, once (P1)

**Goal**: pipeline (B1–B5, B7–B13). **Independent test**: `video-pipeline.e2e-spec.ts` with real ffmpeg; waves delivered concurrently through the real consumer.

### Tests first (`M/video-pipeline.e2e-spec.ts`, describe `Video transcoding pipeline`)

- [X] T063 [US2] AS-15 happy path: real 6 s 720p clip → wave order probe → poster ∥ thumbnails ∥ rungs → package → publish, `READY`, master with 3 renditions, VOD playlists, poster, sprite, one `video.ready`, history rows, all tasks `DONE`.
- [ ] T064 [US2] AS-18 renditions line up: sources at 24/25/30/50/60 fps → equal segment counts and boundaries, keyframe at each start, ≤ 4.5 s, VOD, end-of-list, target 4.
- [ ] T065 [US2] AS-19 master accuracy: measured peak/average vs segments, real resolution, frame rate, codecs; audio-less source has no audio codec.
- [X] T066 [US2] AS-21 rejection end to end: text file, audio-only, truncated MP4 → `FAILED` with code, one attempt, other tasks `CANCELLED`, no outputs, one `video.failed`, no decoder text in `GET`.
- [X] T067 [US2] AS-22 fan-in exactly once: four siblings finish via `Promise.all` → one `package` claim and message; duplicate messages for finished tasks are stale no-ops.
- [X] T068 [US2] AS-23 one runner per task: same message to two workers at once → one runs, one "busy" with no attempt; lease expiry takeover counts an attempt.
- [X] T069 [US2] AS-24 retry with backoff: stub encoder fails twice then works → attempts, delayed messages 30 s and 120 s, success; fails 3× → `FAILED`, cancelled tasks, event, fourth message no-op; storage cause → `storage_unavailable`. No `groupId`/`dedupeId` on the standard queue (L-001).
- [X] T070 [US2] AS-25 timeout and kill: stub encoder never ends → SIGKILL, process gone, attempt counted `task_timeout`; 10 MB flood bounded; argument with shell metacharacters inert.
- [X] T071 [US2] AS-26 fenced completion: two attempts of one rendition, first loses lease → separate output locations, only recorded attempt marks `DONE`, loser's objects removed, master references one attempt.
- [X] T072 [US2] AS-27 publish guard: repeated `Promise.all(delete, publish)` → never `READY` after `DELETED`; no `video.ready` when delete won.
- [X] T073 [US2] AS-28 optional sprite: stub failure of `thumbnails` ×3 → `SKIPPED`, `READY`, `spriteUrl: null`; success → sprite dimensions, tile cap (160×90, rows of 10, ≤ 100 tiles, one per 10 s), text track.
- [X] T074 [US2] AS-29 progress: polling through a run → `tasksTotal` 1 then full, `tasksDone` monotonic, equal at `READY`.
- [X] T075 [US2] AS-30 package verifies storage: delete a rendition's last segment before `package` → retryable failure, no master, not published.

### Implementation

- [X] T076 [US2] Create `M/application/video-pipeline.service.ts`: after `probe` validate with `probe-rules`, persist the graph (R-6), claim only `QUEUED` or expired lease (conditional update, attempt +1, `claimedAttempt`, lease 5 min), "busy" consumes no attempt, heartbeat extends lease and SQS visibility (900 s), fenced `DONE`, per-attempt output keys, transient retry via delayed message (30 s/120 s), permanent failure at once, optional `thumbnails` → `SKIPPED` at last attempt, cancel open tasks on `FAILED`, history rows, progress.
- [X] T077 [US2] Create `M/application/video-task-runner.ts`: task bodies (`probe`, `poster`, `thumbnails`, `transcode:<rung>`, `package` verifying every stored segment and building the master from measured values, `publish`) using `TranscoderPort` and storage with cache-control `public, max-age=31536000, immutable` (C-7); limits from `task-limits`.
- [X] T078 [US2] `publish` guarded conditional update (`PROCESSING → READY` with `NOT EXISTS` open required task) + history + `video.ready` outbox append in one transaction; loser exits (AS-27). Outbox via `OutboxService.append`.
- [X] T079 [US2] Create the worker consumer in `M/video-worker.module.ts` (rewrite): consume `video-transcode` (`{videoId, task}`, schema-validated, invalid body → DLQ at once), concurrency 2, trace attribute, shutdown re-queue without attempt (R-22); remove the re-provided `VideoService`.
- [X] T080 [US2] Run `/opt/sdd/repo/scripts/sdd/test-spec.sh M/video-pipeline.e2e-spec.ts` until green (T063–T075).

**Checkpoint**: upload → READY works end to end.

---

## Phase 5: User Story 3 — Viewers watch public videos; unlisted only with the link (P1)

**Goal**: delivery (C-1–C-9). **Independent test**: `video-delivery.e2e-spec.ts`.

### Tests first (`M/video-delivery.e2e-spec.ts`, describe `Video playback and delivery API`)

- [X] T081 [US3] AS-31 public playback: 200 `videoPlaybackSchema`, host `video_cdn_url` and `/p/<id>/` path, no `Set-Cookie`, `public, max-age=60`, no source key or storage address anywhere, `spriteUrl` null or URL.
- [X] T082 [US3] AS-32 unlisted playback: token → 200, three cookies (`Secure; HttpOnly; SameSite=None; Path=/u/<id>/`, `Domain` = configured parent, `Expires` +4 h), `private, no-store`, credential policy decoded and signature verified with the throwaway key, scope one video.
- [X] T083 [US3] AS-33 unlisted without token: none/wrong/foreign/empty → body identical to unknown ID's 404, no cookie.
- [X] T084 [US3] AS-34 only READY and visible: every status → 404; suspended shop (via `VideoShopState`) → 404 then resumes; delete → 404 at once.
- [X] T085 [US3] AS-35 signing misconfigured: no key → 503, no URL, no cookie.
- [X] T086 [US3] AS-36 originals never served: scan every route/status for source location and storage addresses, owner and anonymous.
- [X] T087 [US3] AS-37 delivery objects: head every stored output → content type and immutable cache header.
- [X] T088 [US3] AS-38 product page list: mixed videos → only `READY` public, newest first, ≤ 10; archived/sandbox/unknown/suspended-shop product → 404; one batch read; response parsed by the exported `productVideosSchema` (same one the BFF uses).
- [X] T089 [US3] AS-39 read rate limit: 601st 429; limiter store down → served.
- [X] T090 [US3] AS-40 no write per view: 1,000 playbacks → row counts/`updatedAt` identical, outbox unchanged, counter = 1,000.
- [X] T091 [US3] AS-41 secrets out of logs: captured logs, error bodies, metrics scanned for token, cookie values, key, part URLs; `token` appears as `[redacted]`.

### Implementation

- [X] T092 [US3] Create `M/application/video-playback.service.ts`: R3 `VideoShopState` check (no R1 on this path), READY-only, unlisted token compared in constant time, `DeliveryEdge` credential (4 h, one path pattern, `Clock`), 503 never unsigned, product list via R1 `getProductsByIds` + own tables (R-15); metrics counter; no writes.
- [X] T093 [US3] Create `M/api/video-playback.controller.ts`: `GET /videos/:id/playback`, `GET /products/:productId/videos`; headers/cookies per `video-api.md`; `@RateLimit('video.playback.ip')` fail open; identical 404 body.
- [X] T094 [US3] Run `/opt/sdd/repo/scripts/sdd/test-spec.sh M/video-delivery.e2e-spec.ts` until green (T081–T091).

**Checkpoint**: US1–US3 deliver the full viewer value.

---

## Phase 6: User Story 4 — A seller manages videos (P2)

**Goal**: read/list/edit/link/retry/delete (D1, D2, C-9). **Independent test**: `video-management.e2e-spec.ts`.

### Tests first (`M/video-management.e2e-spec.ts`, describe `Video management API`)

- [X] T095 [US4] AS-42 read one: owner view fields parsed by `videoOwnerSchema`; no location/upload id/encoder text; other shop/unknown/non-member identical 404; `VIEWER` may read.
- [X] T096 [US4] AS-43 list keyset: 45 videos, pages of 20, inserts between pages, limit 1–50 bounds, bad/foreign cursor 400 `invalid_cursor`, `DELETED` absent, no other shop's rows.
- [X] T097 [US4] AS-44 edit optimistic: version bump, stale 409 with `currentVersion`, concurrent edits one 200 one 409, `visibility`/unknown fields 400, `DELETED` 404.
- [X] T098 [US4] AS-45 link to product: R1 rules, unlink, 11th link 409 `product_video_limit`, two concurrent links on 9 → one succeeds.
- [X] T099 [US4] AS-46 retry: retryable codes 202 with resumed tasks (from last finished task) and messages after commit; non-retryable 409; wrong state 409; concurrent retries; 4th retry 409 `retry_limit`; purged source 409 `source_purged`.
- [X] T100 [US4] AS-47 delete: 204, row, history, one `video.deleted`, tasks `CANCELLED`, reads stop at once, upload aborted after commit, second delete 404, `VIEWER` 403, 401.
- [X] T101 [US4] AS-48 cross-tenant matrix: every seller route with the other shop's video and as non-member → identical 404 bodies; nothing changed.

### Implementation

- [X] T102 [US4] Create `M/application/video-manage.service.ts`: read, keyset list (index `video_shop_created_idx`), optimistic patch (`version`, no history row), product link under per-product advisory lock + R1 batch read outside tx, retry (≤ 3, resets failed/cancelled tasks to `PENDING` from the first unfinished, message after commit), soft delete (history, `video.deleted`, cancel tasks, abort multipart after commit); every lookup carries the shop.
- [X] T103 [US4] Add the management routes to `M/api/video.controller.ts` (`GET` list, `GET :id`, `PATCH :id`, `POST :id/retry`, `DELETE :id`) with `products.read`/`products.write`.
- [X] T104 [US4] Run `/opt/sdd/repo/scripts/sdd/test-spec.sh M/video-management.e2e-spec.ts` until green (T095–T101).

---

## Phase 7: User Story 5 — Nothing is left stuck, leaked or orphaned (P2)

**Goal**: jobs and consumers (A7, A8, B12, D3–D5, G4, G5). **Independent test**: `video-lifecycle.e2e-spec.ts`.

### Tests first (`M/video-lifecycle.e2e-spec.ts`, describe `Video lifecycle jobs and consumers`)

- [X] T105 [US5] AS-49 expire unfinished uploads: 24 h boundary with frozen clock, multipart aborted, `complete` → 409 `upload_expired`/`upload_closed`, double and concurrent runs one effect (`Promise.all`).
- [X] T106 [US5] AS-50 recover stuck work: four stuck kinds (lost message, expired lease, stuck `UPLOADED`, stuck `PROCESSING` without sent message) each recovered once; repeated and concurrent sweeps add no second message (`lastSentAt` 1 min guard); duplicates stale.
- [X] T107 [US5] AS-51 processing limit: 6 h boundary → `FAILED` `processing_timeout`, tasks `CANCELLED`, one `video.failed`.
- [X] T108 [US5] AS-52 purge: `DELETED`, `EXPIRED`, `FAILED` older than 7 days removed; `READY` outputs untouched; missing objects fine (L-016); edge-cache removal spy called for deleted public videos, failure repeated next run; idempotent; batch cap 200.
- [X] T109 [US5] AS-53 consumer `catalog.product_deleted`: effect, duplicate delivery single effect, invalid payload dead-lettered, foreign `shopId` no effect.
- [X] T110 [US5] AS-54 consumer `tenancy.shop_deleted`: 450 videos in batches of 50, one `video.deleted` each, replay no change, invalid payload dead-lettered.
- [X] T111 [US5] AS-55 consumer `tenancy.shop_status_changed` out of order: v5 then v4 keeps `SUSPENDED` v5; duplicates; no-video shop; invalid payload; playback and list react.
- [X] T112 [US5] S49 follow-up test: jobs `media.video-expire-uploads`, `media.video-requeue-stuck`, `media.video-purge` are declared (`declareJobType`, `z.object({}).strict()`), schedules upserted, each handler runs through the real job registry; `InvalidScheduleError` caught specifically; nothing calls `JobsService.cancel`.

### Implementation

- [X] T113 [US5] Create `M/video-maintenance.jobs.ts` (copy the pattern of S29's `media-maintenance.jobs.ts`): `declareJobType` ×3 next to the `JobPayloads` augmentation, `upsertSchedule` (sweep every minute, purge every 5 min, expire), `InvalidScheduleError` caught; single-run under S49 lease.
- [X] T114 [US5] Create `M/application/video-lifecycle.service.ts`, `video-sweep.service.ts`, `video-purge.service.ts`: expiry + multipart abort, requeue (lost messages, expired leases, stuck `UPLOADED` re-drive), `processing_timeout`, purge of objects and edge removal (`objectsPurgedAt`, `edgePurgedAt`), bounded 200 per run, tolerate missing objects/edge failure.
- [X] T115 [US5] Create `M/infra/video-consumers.ts` (three projector consumers on the S53 framework, zod-validated, DLQ, version guard for `VideoShopState` upsert `excluded.shopVersion > shopVersion`, shop-deleted batches of 50 with `video.deleted` per video) and `M/video-projector.module.ts` (no storage or queue module imported).
- [X] T116 [US5] Run `/opt/sdd/repo/scripts/sdd/test-spec.sh M/video-lifecycle.e2e-spec.ts` until green (T105–T112).

---

## Phase 8: User Story 6 — Events, operations and boundaries (P2)

**Goal**: events, observability, configuration, boundaries, shutdown, wiring (D6, D7, G3, D-8). **Independent test**: `video-events.e2e-spec.ts`.

### Tests first (`M/video-events.e2e-spec.ts`, describe `Video events, observability and configuration`)

- [X] T117 [US6] AS-56 events: three events appended in the state-change transaction, envelope fields, `videoEventSchemas`, rollback via outbox-insert trigger leaves neither state nor event, `videoVersion` strictly increasing, no secret in any payload.
- [X] T118 [US6] AS-57 observability: nine metric names/increments after a scripted run; log fields; trace propagated from the queue message.
- [X] T119 [US6] AS-58 configuration: boot with each missing/invalid setting → exit naming it; non-production unsigned mode → 503 for unlisted.
- [X] T120 [US6] AS-59 boundaries: run `check:table-ownership --strict` and `check:boundaries`; registry entries; no FK (catalog query on migrated schema); `VideoModule` boots from a test module importing only the barrel `M/index.ts`.
- [X] T121 [US6] AS-62 graceful shutdown: stub encoder running three tasks, close the app → encoders killed, tasks `QUEUED` with unchanged attempts, pools closed last, exit within 30 s.

### Implementation

- [X] T122 [US6] Create/finish `M/video.module.ts` (API only), register `VideoStatusHistory`/`VideoShopState` models, wire `DeliveryEdge`, rate-limit policies, observability; delete `M/application/video.service.ts` and `M/infra/ffmpeg.ts` (removes the four `// S54 T037 audit` sites; `.tx.baseline` → 0).
- [X] T123 [US6] Reduce `M/index.ts` to the Provides list (`VideoModule`, `VideoWorkerModule`, `VideoProjectorModule`, event definitions, schemas); no `VideoService` (D-8). Keep S29 exports untouched.
- [X] T124 [US6] Register modules: `apps/core/src/*.module.ts` (`VideoModule`), `apps/worker/src/*.module.ts` (`VideoWorkerModule`), `apps/projector/src/*.module.ts` (`VideoProjectorModule`).
- [X] T125 [US6] Implement startup validation hook and graceful shutdown ordering (kill encoders, re-queue without attempt, pools last) in the worker module (R-22).
- [X] T126 [US6] Run `/opt/sdd/repo/scripts/sdd/test-spec.sh M/video-events.e2e-spec.ts` until green; then **start the real `apps/core`, `apps/worker` and `apps/projector`** and confirm each boots (L-004, L-015); `doctor`/boot-check output kept.

---

## Phase 9: Polish and cross-cutting (WP-12–WP-14)

- [X] T127 Scenario inventory (L-017): list in `specs/domains/S30-video/gaps.md` (new section "Scenario inventory") each old test → AS-xx → new test title: waves in order probe → poster+rungs → package → publish, fan-in exactly once, the three pure checks of `M/domain/video.spec.ts`, W02 B-7 in `video-contracts.spec.ts`. Only then delete `M/video.e2e-spec.ts` and `M/domain/video.spec.ts`.
- [X] T128 [P] Ops artifacts: `scripts/load-tests/video-playback.k6.js` (SC-006), `scripts/ops/check-video-edge.sh` (AS-60, SC-008; exec bit if the harness allows), `infra/modules/s3_cloudfront/main.tf` video host/behaviors (public unsigned, unlisted signature required, immutable cache + `nosniff`, CORS with credentials on unlisted only, multipart abort after 2 days, sources to infrequent access after 30 days) (G8), CI image ffmpeg/ffprobe note (G9).
- [X] T129 Unverified criteria (rule 2): confirm `specs/domains/S30-video/quickstart.md` "Ops artifacts" table and `specs/UNVERIFIED.md` rows exist, status "not run", for SC-001, SC-002 (20 GiB), SC-006, SC-008 (edge), AS-60, AS-61; do not describe any as verified.
- [X] T130 Fresh-stack verification (L-012): `scripts/qa/fresh-run.sh` (or document why not possible) with migrations and the six e2e files each in a separate process (L-008); a batch without summary is a crash.
- [X] T131 Gates: `pnpm exec tsc --noEmit` (backend + contracts), ESLint (`pnpm exec eslint --fix libs/domains/media libs/infrastructure`), `pnpm check:boundaries`, `pnpm check:table-ownership --strict`, `.tx.baseline` = 0 for the domain and no new direct `sequelize.transaction`.
- [X] T132 Whole capability suite once: unit `pnpm test -- libs/domains/media` plus the six video e2e files and S29 media specs (regression), each file in its own process.
- [X] T133 Living-spec anchors: add `[proof: …]` and `[code: …]` to `docs/spec/capabilities/S30-video.md`; run `python3 scripts/livespec/check.py` from repo root → 0 errors. If a signed page's `[code:]` anchor moved, record it under "## Spec changes" in `gaps.md`.
- [X] T134 Sibling follow-ups: confirm the "## Sibling-spec follow-ups" section in `gaps.md` still lists S48, S27, S28, S32, S54, S29, W04, W02; add `- **S25/S24/S19/S11/S21/S38**: replace the loose schemas in packages/contracts/src/bff/upstream.ts with their own` only if not already there (S30 does not edit their specs). Add the S49 job-type note for S30 as done.
- [X] T135 Report: write the closing summary listing the S48 (schema moved, fixtures updated, BFF check in AS-38), S49 (three `declareJobType`, `InvalidScheduleError`) and S29 follow-ups as handled, and the open items (W04/W02 UI, ops artifacts not run, ffmpeg *blocked* if absent).

---

## Gaps → tasks

| Gap | Tasks | Gap | Tasks |
|---|---|---|---|
| A1 | T014, T043, T061 | C-1–C-3 | T082–T085, T092 |
| A2, A3 | T042, T048, T058 | C-4 | T036, T082 |
| A4 | T047, T056 | C-5, C-6 | T034, T036, T081, T092 |
| A5, A6 | T050–T055, T059, T060 | C-7 | T032, T077, T087 |
| A7 | T105, T114 | C-8 | T040, T089, T091 |
| A8 | T051, T106, T114 | C-9 | T088, T098, T102 |
| B1, B2 | T068, T071, T076 | D1, D2 | T095–T103 |
| B3–B5 | T066, T069, T073, T076 | D3 | T117, T078, T102 |
| B6 | T020, T026, T066 | D4 | T109–T111, T115 |
| B7 | T038, T070, T077 | D5 | T108, T114 |
| B8, B9 | T019, T025, T064, T065 | D6 | T035, T040, T118, T119 |
| B10, B11 | T072, T075, T077, T078 | D7 | T123, T124 |
| B12 | T106, T107, T114 | E1–E4 | T006–T012 |
| B13 | T040, T079 | F1, F2 | T127, T042–T121 |
| B14 | T018, T024 | F3, G10 | sibling bullets (T134) |
| B15 | T037, T029 | F4 | T041 |
| G1 | T031–T034 | G2 | T035, T036 |
| G3 | T056 | G4 | T112, T113 |
| G5 | T040, T115, T117 | G6 | T013–T016 |
| G7 | T011 | G8, G9 | T002, T128 |
| D-6 / D-7 / D-8 / D-12 | T037, T041, T123, T010 | | |

## Dependencies and order

- Phase 1 → Phase 2 (blocks all stories) → US1 → US2 (needs the complete step) → US3 (needs READY videos; can seed READY rows directly, so may start after Phase 2 in parallel with US2) → US4 (needs US1; retry needs US2) → US5 → US6 → Polish.
- Within a story: tests (red) → services → controllers → green run.
- Parallel: T003–T005; T013/T015; T017–T022 and T024–T029; T031/T033/T035; T038–T040; US3 tests with US2 implementation; T128 any time after Phase 2.

## MVP

Phases 1–3 (US1): resumable upload end to end. The first useful release is US1+US2+US3 (a video can be uploaded, transcoded and played).

## Notes

- Total: 135 tasks. Per phase: Setup 5, Foundational 36, US1 21, US2 18, US3 14, US4 10, US5 12, US6 10, Polish 9.
