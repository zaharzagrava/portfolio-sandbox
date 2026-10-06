# Gaps: S30 — current `media` video code versus the spec

The implementation agent's to-do list. Paths are under `packages/backend/` unless stated; line numbers are those read on 2026-10-05. `pnpm --dir packages/backend check:table-ownership` was run (87 findings in 21 domains; `media` has 2, both in `application/media.service.ts` and both S29's, see section C: **the video code has 0 findings, but the check cannot see the foreign keys of C3**). The photo files (`api/media.controller.ts`, `application/media.service.ts`, `infra/media-processor.ts`, `infra/image-pipeline.ts`, `media.module.ts`) belong to S29 and are not listed. Files in scope: `api/video.controller.ts`, `application/video.service.ts`, `domain/dag.ts`, `domain/hls.ts`, `infra/ffmpeg.ts`, `video.module.ts`, `video.e2e-spec.ts`, `domain/video.spec.ts`, `migrations/20261002120000-videos.js`, `db/ownership.ts`.

## A. Code versus spec

### Upload

| # | Gap | Where | Spec |
|---|---|---|---|
| A1 | No `packages/contracts` schema for any video route; DTOs are class-validator classes without unknown-field rejection tests, no `contentType`, `productId`, `title` trimming, minimum size; `sizeBytes > 20 GiB` throws a raw `BadRequestException('max 20 GB')`, not problem+json with `code` | `api/video.controller.ts:10-22`; `application/video.service.ts:47` | FR-001, FR-002, FR-073, FR-074, AS-02 |
| A2 | Start returns the private source key and the storage upload id (`...upload`), one URL per part with no bound length, no `expiresAt`, no `partCount`, no share token | `application/video.service.ts:53-55` | FR-003, FR-004, AS-01, AS-08 |
| A3 | Start inserts through raw SQL in `application/` with placeholder `sourceKey = 'pending'`, then a second statement; a failure of the storage call leaves a row in `UPLOADING` forever; no quota, no history row, no transaction, no `503 storage_unavailable` | `application/video.service.ts:48-54` | FR-005, FR-007, AS-05, AS-07 |
| A4 | No rate limit on any video route | `api/video.controller.ts:29-39` | FR-006, AS-06 |
| A5 | No resume route (list stored parts, fresh part permissions); a client that loses its page cannot continue | whole controller | FR-008, AS-09 |
| A6 | `completeUpload` is select-then-act, returns `200 {status}` for any non-`UPLOADING` state, trusts the client's etags, completes the multipart upload before any status change (second concurrent call fails inside storage with a 500 and both start the pipeline), never checks the assembled size, and has no recoverable `UPLOADED` state | `application/video.service.ts:58-65` | FR-009, FR-010, FR-011, AS-10–AS-14 |
| A7 | No expiry of unfinished uploads (no job, no multipart abort); no 24-hour session | whole domain | FR-060, AS-49 |
| A8 | `startPipeline` writes `PROCESSING` and the `probe` row in a transaction and then enqueues with no recovery if the process dies between commit and send | `application/video.service.ts:67-73,195-210` | FR-023, FR-036, AS-50 |

### Pipeline

| # | Gap | Where | Spec |
|---|---|---|---|
| B1 | Claim accepts `QUEUED` **and** `RUNNING` at any time: two workers can run one task; no lease, no heartbeat-based takeover, no "busy" | `application/video.service.ts:82-86` | FR-024, AS-23 |
| B2 | `DONE` is written by task name only, so a stale worker's late completion overwrites; outputs of different attempts share keys (identical keys do not mean identical bytes: libx264 is not bit-exact) | `application/video.service.ts:91-93,158-163,172` | FR-025, AS-26 |
| B3 | Retry relies on the queue's visibility timeout (up to 900 s) with no backoff; a permanent failure (not a video) is retried three times; the abort on shutdown goes through the same path and burns an attempt | `application/video.service.ts:96-101`; `video.module.ts:37-39` | FR-026, FR-028, AS-21, AS-24, AS-62 |
| B4 | Failure writes the free-text `error` and no `failureCode`; no history row; no `CANCELLED` for the remaining tasks (they stay `PENDING`/`QUEUED` and may still be claimed and run) | `application/video.service.ts:102-107`; `domain/dag.ts:12` | FR-022, FR-026, AS-21, AS-24 |
| B5 | `SKIPPED` exists but nothing sets it; there is no `thumbnails` task and no optional-task rule | `domain/dag.ts:12,37`; `application/video.service.ts:130-195` | FR-020, FR-027, AS-28 |
| B6 | No source validation: duration, resolution, codec and minimum size are not checked after `probe`; a 16K or 10-hour file is accepted and a 2-hour ceiling is not enforced; `probe` returns `hasAudio` and nothing uses it | `application/video.service.ts:136-147`; `infra/ffmpeg.ts:32-39` | FR-029, AS-20, AS-21 |
| B7 | Fixed 2-hour time limit for every rendition, 120 s poster, no package timeout, no limit on the source download; a 10-second clip that hangs holds a slot for 2 hours; stdout of `run` is unbounded (`stdout += d`) | `application/video.service.ts:158,171`; `infra/ffmpeg.ts:11-14` | FR-028, AS-25 |
| B8 | Keyframes are `-g 48` (2 s only at 24 fps) and the frame rate is not normalised, so segment boundaries differ across renditions for 25, 30, 50, 60 fps sources; audio is always requested (`-c:a aac` for silent sources) | `domain/hls.ts:22-24` | FR-031, AS-18, AS-19 |
| B9 | `ladderFor` enlarges a source below 240p to the 240p rung (comment says "never upscale"); master playlist uses configured bitrates (`videoKbps * 1.07`), a constant `CODECS="avc1.4d401f,mp4a.40.2"` (wrong for 1080p and for silent video), constant `FRAME-RATE:24.000`; rendition width is computed from the source ratio, not measured | `domain/hls.ts:11-14,31-37`; `application/video.service.ts:164` | FR-030, FR-032, AS-17, AS-19 |
| B10 | `package` trusts the `DONE` outputs and does not check storage; a missing segment yields a playable-looking master | `application/video.service.ts:176-183` | FR-034, AS-30 |
| B11 | `publish` is an unconditional `UPDATE ... SET status = 'READY'` by id: a deleted or failed video would be resurrected; no history row; no event | `application/video.service.ts:185-189` | FR-035, FR-056, FR-070, AS-27, AS-56 |
| B12 | No sweep for lost messages, expired leases, stuck `UPLOADED`, or videos stuck in `PROCESSING`; no processing time limit | whole domain | FR-036, AS-50, AS-51 |
| B13 | Worker concurrency 2 and visibility 900 s are literals in the module; no heartbeat tie to the lease; no trace propagation from the message | `video.module.ts:31-34` | FR-024, FR-071, AS-57 |
| B14 | DAG: `topoSort` rejects cycles and unknown dependencies but not duplicate names or self dependencies; no property test | `domain/dag.ts:19-36`; `domain/video.spec.ts` | FR-021, AS-16 |
| B15 | The video service does raw SQL on its own tables from `application/` through `@InjectConnection` (no repository port, no `domain/` ports, ffmpeg and storage reached directly) | `application/video.service.ts:2,39,72-212` | I.2, D-6 |

### Delivery

| # | Gap | Where | Spec |
|---|---|---|---|
| C-1 | `GET /videos/:id/playback` is anonymous for unlisted videos with no token; any ID that leaks (logs, events, UUIDv7 time-ordering) plays | `api/video.controller.ts:41-54`; `application/video.service.ts:113-126` | FR-040, FR-041, AS-32, AS-33 |
| C-2 | Playback returns `404 'Video not ready'` for non-ready states but no shop-status check; no `title`, `width`, `height`, `renditions`, `spriteUrl`, `expiresAt` | `application/video.service.ts:114-118` | FR-040, AS-31, AS-34 |
| C-3 | Missing key pair silently returns the **unsigned** URL for an unlisted video | `application/video.service.ts:122` | FR-043, AS-35, AS-58 |
| C-4 | Cookie `Domain` is the delivery host's own hostname; browsers reject a cookie whose domain is not the response host or its parent | `api/video.controller.ts:49` | FR-042, AS-32 |
| C-5 | URL base falls back to `<s3_endpoint>/<bucket>` when `media_cdn_url` is unset; video shares the photo CDN setting instead of the dedicated video host S27 allows; the source (`videos/<id>/source`) lives under the same prefix as the public outputs | `application/video.service.ts:52,119`; `libs/common/config/types.ts:103-106` | FR-040, FR-044, AS-36, AS-58, CONTRACT S27 |
| C-6 | `getSignedCookies` is called from `application/` and the policy wildcard is `videos/<id>/*` on the same path as public output; `Date.now()` instead of the clock; no startup check of the key pair | `application/video.service.ts:9,123-125` | I.2, I.3 (in `domain/`), FR-040, AS-58 |
| C-7 | Stored outputs have a content type but no cache-control; the storage port's `put` takes none | `application/video.service.ts:162,172,181`; `libs/infrastructure/storage/object-storage.port.ts` | FR-038, AS-37 |
| C-8 | No rate limit; no metric per playback; no log redaction rule for a share token | `api/video.controller.ts` | FR-046, FR-048, AS-39, AS-41 |
| C-9 | No `GET /products/:id/videos`, no `productId` on `Video`, no link route | whole domain; `migrations/20261002120000-videos.js` | FR-047, FR-053, AS-38, AS-45 |

### Management, events, consumers

| # | Gap | Where | Spec |
|---|---|---|---|
| D1 | No owner read, list, edit, retry or delete route; no `version`, `failureCode`, `shareToken`, progress | whole controller | FR-050–FR-056, AS-42–AS-48 |
| D2 | `video()` loads by id and then optionally by shop (`AND "shopId"`) only when a shop is passed; `runTask` and `playback` load by id alone; there is no cross-tenant matrix test | `application/video.service.ts:212-219` | FR-050, AS-48 |
| D3 | No events: `application/events/media-events.ts` defines only the photo `media.ready`; no `video.ready`, `video.failed`, `video.deleted`, no `videoEventSchemas`; nothing goes through `outbox.append` | `application/events/media-events.ts`; `video.service.ts` | FR-070, AS-56 |
| D4 | No consumer for `catalog.product_deleted`, `tenancy.shop_deleted`, `tenancy.shop_status_changed`; no `VideoShopState` | whole domain | FR-062, AS-53–AS-55 |
| D5 | No purge, no edge-cache removal, no `FAILED` retention; no lifecycle expectations for abandoned multipart uploads | whole domain | FR-061, AS-52, AS-60 |
| D6 | No metrics, no structured task logs with `videoId`/`task`/`attempt`, no config validation for `cloudfront_*`, `video_cdn_url`, cookie domain | `application/video.service.ts` (`logger` unused) | FR-071, FR-072, AS-57, AS-58 |
| D7 | Barrel exports `VideoModule` and `VideoWorkerModule` only; `VideoService` is exported by the module (`exports: [VideoService]`) with no consumer; the worker module re-provides `VideoService` | `video.module.ts:10-11,43`; `index.ts` | X.4, D-8 |

### Data model

| # | Gap | Where | Spec |
|---|---|---|---|
| E1 | `Video` has foreign keys to `Shop` and `User` (IX.4); no `version`, `failureCode`, `retryCount`, `shareToken`, `productId`, `contentType`, `sizeBytes`, `partSize`, `sessionExpiresAt`, `objectsPurgedAt`, no `UPLOADED`/`EXPIRED`/`DELETED` in the status check; `VideoTask` has no `lease`, `claimedAttempt`, `CANCELLED` | `migrations/20261002120000-videos.js:9-13,26-35` | FR-056, AS-59 |
| E2 | No `VideoStatusHistory`, no `VideoShopState`; `db/ownership.ts` lists `Video` and `VideoTask` only; `ProductMedia` is still `domain:catalog` (S29 moves it) | `db/ownership.ts:68,81-82` | FR-100, AS-59 |
| E3 | Store-level invariants missing: at most 10 `UPLOADING` per shop and at most 10 non-deleted videos per product are not enforced by the store (needs a constraint, counter row or advisory lock) | `migrations/20261002120000-videos.js` | FR-005, FR-053, AS-05, AS-45 |
| E4 | Keyset list needs an index on `(shopId, createdAt DESC, id DESC) WHERE status <> 'DELETED'` | migration | FR-052, AS-43 |

## B. Tests

| # | Gap | Where | Spec |
|---|---|---|---|
| F1 | `video.e2e-spec.ts` calls `VideoService` directly with `TaskQueue.enqueue` spied (no HTTP, no real queue), seeds the `Video` row by raw SQL and a `Shop` through the tenancy model (a cross-domain model import), and is `describe.skip` when ffmpeg is missing: it must become the six supertest suites of `test-plan.md`, with no skip in CI | `video.e2e-spec.ts:11-18,32-60,64-67` | VII.2, VII.3, VII.6, AS-15–AS-30 |
| F2 | No test for any of the 62 scenarios beyond waves, fan-in once and the three pure checks of `domain/video.spec.ts` | `domain/video.spec.ts` | test-plan |
| F3 | No UI journey; no video code in `packages/web` (W04/W02 own it) | `packages/web/tests/` | AS-61 |
| F4 | Fault-injection tooling is missing: a TCP fault proxy for MinIO, a stub encoder on `PATH`, an outbox-insert trigger helper | `test/` harness | AS-07, AS-14, AS-24, AS-25, AS-56, AS-62 |

## C. Debt-register rows and ownership-check lines for this domain

Open rows of `docs/architecture/debt-register.md` that name `media` or `S30` (or every capability of every domain), and what replaces each:

| Row | Applies to S30 as | Replaced by |
|---|---|---|
| D-6 (I.2 layering: `api/` and `application/` import `infra/`) | `VideoService` injects the Sequelize connection and runs SQL, imports `infra/ffmpeg` and the storage and queue ports as concrete classes, signs credentials with an SDK call (`video.service.ts:2,10-15,72-212`) | repository ports and tokens in `domain/` (`VideoRepository`, `VideoTaskRepository`, `TranscoderPort`, `DeliveryEdgePort`) with adapters in `infra/`; the service keeps orchestration and transactions only |
| D-7 (model exports of other domains) | none: the video code imports no foreign model in production code. `video.e2e-spec.ts:15` imports tenancy's `ShopModel` (test only) | tests seed through the shared seed helpers (`SeedsService`), not another domain's model |
| D-8 (barrels export infrastructure internals) | `index.ts` exports `MediaProcessor` and `Sql` (S29's) and, through `VideoModule`, `VideoService` | `apps/worker` imports `VideoWorkerModule`; `apps/projector` imports `VideoProjectorModule`; the service is not exported (S29 removes the other two) |
| D-12 (raw SQL on tables owned by another domain) | `check:table-ownership` lines for `media` are `SQL Product` and `SQL ProductMedia` in `application/media.service.ts` — S29's, not video's; **S30 adds none and must not add any**: the product check is R1 `getProductsByIds([id], {shopId})` (AS-04, AS-45) and the product page list is R1 plus own tables (AS-38). The two undetected cross-domain items are the foreign keys to `Shop` and `User` (E1) → plain ID columns, no FK, no join | R1 for product checks; R3 for product deletion (`catalog.product_deleted`), shop deletion (`tenancy.shop_deleted`) and shop status (`tenancy.shop_status_changed` copied into `VideoShopState`, IX.8); R2 for the product page (S48 composes the two public routes) |
| D-11, D-15, D-17 and the other open rows | do not name `media` or `S30` | — |

`pnpm --dir packages/backend check:table-ownership` for this domain (copied verbatim, 2026-10-05):

```
media  (2)
  SQL   Product                    owned by catalog            libs/domains/media/application/media.service.ts
  SQL   ProductMedia               owned by catalog            libs/domains/media/application/media.service.ts
```

Both lines are S29's (`ProductMedia` moves to `media` there; the product join is replaced by R1 there). After S29 and S30 land, `check:table-ownership --strict` must report 0 for `media`, and the registry must hold `Video`, `VideoTask`, `VideoStatusHistory`, `VideoShopState` under `domain:media` (AS-59).

## D. Cross-capability work this capability needs (not in this domain's files)

| # | Work | Owner | Spec |
|---|---|---|---|
| G1 | `ObjectStorage` port: `listParts`, per-part presign with exact length, `head` with cache-control, `put` with cache-control and timeout, `deletePrefix`, per-call timeouts; a `DeliveryEdge` port (signed credential for a path pattern, path removal request) with a CloudFront adapter; delayed `enqueue` and attributes already exist in `TaskQueue` | infrastructure (S30 and S29 both extend the storage port) | FR-004, FR-009, FR-038, FR-040, FR-061 |
| G2 | Settings: `video_cdn_url`, `video_cookie_domain`, `cloudfront_key_pair_id`, `cloudfront_private_key` validated at startup; `media_cdn_url` is no longer used by video | `libs/common/config/types.ts` (S54 owns the mechanism) | AS-58 |
| G3 | Rate-limit policies `video.start.shop`, `video.write.shop`, `video.playback.ip` in the S50 registry | S50 | FR-006, FR-046 |
| G4 | Jobs `media.video-expire-uploads`, `media.video-requeue-stuck`, `media.video-purge` registered with S49 | S49 | FR-036, FR-060, FR-061 |
| G5 | Consumers on S53's framework; outbox append; trace attribute on queue messages | S53 | FR-062, FR-070, FR-071 |
| G6 | `packages/contracts` schemas listed under Provides | `packages/contracts` | FR-074 |
| G7 | Domain map update: `media` emits `video.*` and depends on tenancy and catalog | `docs/architecture/domain-map.md` | CONTRACT in `questions.md` |
| G8 | Edge/CDN infrastructure code: separate video host, public and unlisted behaviors, signature requirement on the unlisted path only, immutable cache and `nosniff` headers, CORS with credentials on the unlisted path, lifecycle rule aborting incomplete multipart uploads after 2 days, infrequent-access tiering of sources | infrastructure repo | AS-60 |
| G9 | CI image has `ffmpeg` and `ffprobe`; the suites fail in CI when they are missing | CI | test-plan |
| G10 | W04 seller upload screen and W02 product page player per the Requires list | `packages/web` | AS-61 |

## E. Order of work (suggested)

1. Migration (expand): new columns, tables, indexes, constraints; drop the two foreign keys; registry entries (E1–E4).
2. Domain: status table, graph rules, ladder, master builder, probe rules, limits, delivery paths, closed vocabularies (B6–B9, B14), with their unit specs.
3. Ports and adapters (G1, B15), then the application services: start, resume, complete, claim/fence/retry/sweep (A1–A8, B1–B5, B10–B13).
4. Delivery and management routes (C-1–C-9, D1–D2), contracts (G6), rate limits (G3).
5. Events, consumers, jobs, purge (D3–D5, G4, G5).
6. Replace `video.e2e-spec.ts` with the six suites and the fault tooling (F1–F4); recorded green run (VII.9).
