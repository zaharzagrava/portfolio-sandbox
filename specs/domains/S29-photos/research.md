# Research: S29 — Product and review photos (domain `media`)

No `NEEDS CLARIFICATION` remains: `questions.md` defaults are accepted as written. This file records the design decisions that the spec leaves to the plan, each checked against the code read on 2026-10-13. IDs `R-n` are referenced from `plan.md` and the tasks.

## R-1 One SQL runner, three transports (D-6, D-8)

- **Decision**: `domain/` declares ports; `infra/pg-media-repository.ts` implements them over a tiny `SqlRunner = (text, params) => Promise<rows>` (positional `$n`). The same class runs in three places: the Nest API (runner built from the CLS transaction by `TransactionRunner.run`), the Nest worker/projector (same), and `apps/lambdas` (a `pg` client inside the Lambda's own `BEGIN/COMMIT`, exactly what `Sql`/`tx` do today). The processor core `createMediaProcessor(deps)` receives `{ repository, blobs, scanner, clock, metrics, logger, tx }` where `tx(fn)` is supplied by the caller; the core never imports Nest, Sequelize or `pg`.
- **Rationale**: the Lambda must stay a small, Nest-free handler (cold start), and the current `MediaProcessor` is already shaped this way. Moving the SQL into one repository removes raw SQL from `application/` (E6) without making the Lambda boot a container. The Lambda's `pg` transaction is not a `sequelize.transaction` site (rule 4: the gate counts only direct Sequelize sites; `.tx.baseline` is 4 and all four belong to `video.service.ts`, S30, untouched).
- **Alternatives**: boot a Nest application context in the Lambda (cold start, 10× memory); keep two SQL implementations (drift, the current state).

## R-2 Status machine and claims in `domain/` (III.7, AS-49)

- **Decision**: `domain/media-status.ts` holds the status union, the transition table (exactly AS-49's twelve pairs) and `assertTransition(from, to)`; every `switch` ends in `assertNever`. The repository exposes one method per transition, each a conditional `UPDATE … WHERE id = $1 AND status = $from [AND …] RETURNING` that must affect one row, followed by the history insert in the same transaction. `version` increases by 1 in each transition's `UPDATE`.
- **Claim SQL** (FR-010): `UPDATE "Media" SET status='PROCESSING', attempts=attempts+1, "leaseUntil"=$now+interval '5 minutes', version=version+1 WHERE "originalKey"=$k AND (status IN ('PENDING_UPLOAD','UPLOADED') OR (status='PROCESSING' AND "leaseUntil" <= $now)) RETURNING …`. No row: a second `SELECT status, "leaseUntil"` (by the same key) distinguishes `BUSY` (PROCESSING, lease valid) from `SKIPPED` (anything else, or unknown key → counter). When the returned `attempts` is greater than 5 the processor does not process: it rejects with `processing_failed` (AS-22, the fifth claim is the last one that processes; the sixth finds `attempts = 5` and rejects — implemented as "if `attempts` after increment > 5").
- **Why not use SQS receive count**: the attempt count lives in the row, so the same rule holds for the Lambda, a worker process and the re-drive job. The receive count is only logged.
- Clock: `now` is passed in by the caller (`Clock` in Nest, `() => new Date()` in the Lambda); tests freeze it (VII). No `Date.now()` in `domain/`.

## R-3 Duplicate scan inside the READY transaction (FR-033, AS-29)

- **Decision**: after the three variants exist (R-6) the processor opens the transaction: (1) `pg_advisory_xact_lock(hashtextextended('media.dhash.b'||i||':'||value, 0))` for the four bands **in ascending lock-key order** (no deadlock between two workers), (2) per band `SELECT id, dhash, "createdAt" … WHERE status='READY' AND purpose='product' AND "shopId" <> $shop AND "dhashBi" = $v ORDER BY id LIMIT 500` (partial index on `purpose='product' AND status='READY'`), counting `media_duplicate_scan_truncated_total` when a band returns 500 rows, (3) pure `findNearest(hash, candidates)` in `domain/duplicate-match.ts` (distance ≤ 3, smallest distance, ties by smallest ID, near-uniform hashes never match), (4) the conditional `PROCESSING → READY` update stores hash, bands, match, distance and time, and the history row and the outbox rows (`media.ready` with `duplicateSuspected`, optionally `media.duplicate_suspected`) are written, (5) commit. Two simultaneous copies serialise on the band lock; the second sees the first committed `READY` row and flags it.
- **Purpose scope**: `review` photos skip hashing entirely (`dhash` stays null, FR-030); the image pipeline still computes the hash for product photos only (a `computeHash` flag from the purpose).
- **Alternatives**: `SERIALIZABLE` (retry storms, not needed), a unique pending-hash table (extra writer).

## R-4 Exact-type presign and size re-check (FR-003, FR-008, AS-06, AS-08)

- **Decision**: extend `PresignPostOptions` additively: `contentTypes?: string[]` (exact list, becomes one `eq`/`in` condition set) and `minBytes?: number`; `contentTypePrefix` stays for the callers that use it today (checked by grep at implementation time; none are changed here). `head` already returns `size` and `contentType`; `put` gains `options?: { cacheControl?, timeoutMs? }`; `getStream` gains `options?: { timeoutMs? }` (abort signal); `delete` stays. `InMemoryObjectStorage` mirrors every change so unit and app tests keep working.
- `complete` is: select-by-principal → `head` (outside any transaction) → `409 upload_incomplete` when absent → size 0 or > 15 MiB → reject path (`size_invalid`, delete object, `200 {status:'REJECTED'}`) → else `tx { PENDING_UPLOAD → UPLOADED + history }` → **after commit** enqueue `{mediaId, originalKey}`. A lost enqueue is recovered by `media.requeue-stuck` (AS-52), so enqueue failure after commit does not fail the request (it is logged and counted; the response is still `202`).
- Concurrent completes: the conditional update succeeds for one caller; the loser re-reads and answers from the current state without enqueueing (AS-09).

## R-5 Scanner port and the move out of `catalog-sync` (X.3, FR-013)

- **Decision**: new `libs/infrastructure/antivirus/` with `MalwareScanner` (abstract class token: `scan(stream, { timeoutMs }): Promise<{clean:true}|{clean:false, signature}>`), `ClamdMalwareScanner` (the INSTREAM code moved from `catalog-sync/infra/clamav.ts`, with the existing timeout parameter), `DisabledMalwareScanner` (non-production only; logs a warning once at startup) and a test fake (`FakeMalwareScanner`: clean, infected, slow, down). `catalog-sync/infra/clamav.ts` becomes a re-export of the new function so S07 keeps working untouched; the S07 follow-up (switch its import, delete the shim) is listed in `gaps.md`.
- The processor passes the original as a stream to the scanner, then reads it again for decoding only if clean (an extra GET of ≤ 15 MiB is cheaper than buffering the object twice in memory next to libvips). An unreachable/timed-out scanner throws `TransientProcessingError` (`media_scan_unavailable_total`).

## R-6 Image pipeline additions (FR-011–FR-016, AS-13–AS-16, AS-24)

- **Decision**: in `infra/image-pipeline.ts` (sharp/libvips stays in `infra/`): read the header with `sharp(buf, {limitInputPixels: false}).metadata()` and decide `image_too_large` (> 50,000,000 pixels, from `width*height` before any pixel decode; `limitInputPixels` is then set to 50 MP for the decode as a second guard), format allowlist `jpeg|png|webp|heif-as-avif-only` → `avif` (a `heif` whose `compression` is not `av1` is `format_not_allowed`), `pages > 1` → `multi_frame`, zero/undecodable → `not_an_image`, svg/gif/tiff recognised by `metadata().format` → `format_not_allowed`. Pipeline: `rotate()` (apply EXIF orientation) → `toColourspace('srgb')` / `pipelineColourspace` with the embedded profile honoured before it is dropped → `resize({width, withoutEnlargement:true})` → `webp({quality:80})` with no `keepMetadata`. Hash (dHash 9×8) is computed from the oriented greyscale thumbnail for `product` only.
- `RejectedImageError` carries a `code` from the closed vocabulary (`domain/reject-code.ts`); the decoder message is logged by the caller and never stored. Anything that is not a `RejectedImageError` is transient.
- Bands, `hamming`, `NEAR_DUPLICATE_BITS` and the near-uniform rule move to `domain/duplicate-match.ts` (B8); `image-pipeline.ts` keeps only the sharp calls and imports the pure `dhash` bit-packing from `domain/`.
- Three variants are written with `put(key, buf, 'image/webp', {cacheControl, timeoutMs: 10_000})`; then `head` of the three keys (a missing/zero-size object → transient) before the READY transaction (AS-24). Whole run bounded at 45 s by one `AbortSignal.timeout(45_000)` threaded into the three kinds of call; a run that exceeds it ends as transient with the lease released (`leaseUntil = now` in a release statement), attempt already counted.

## R-7 Events with `appendWithExecutor` (IX.6, FR-080, B9)

- **Decision**: five `defineEvent` definitions in `application/events/media-events.ts` from schemas in `packages/contracts/src/media/events.ts` (`mediaEventSchemas`). In Nest, `OutboxService.append` inside `TransactionRunner.run`; in the Lambda path the repository's transition methods take an `OutboxExecutor` and call `appendWithExecutor(executor, envelope)` (framework-free, validated, topic `media.events` derived from `aggregateType: 'media'`; the existing hand-written `INSERT INTO "Outbox"` at `media-processor.ts:68-89` is deleted, which closes the S53 follow-up and C-4). `aggregateId` is the media ID, except `media.gallery_changed` whose `aggregateId` is the `productId`.
- `mediaVersion` is the row's `version` after the transition. `media.ready` carries `duplicateSuspected: boolean` and never the match; `media.duplicate_suspected` carries both shop IDs and is for moderation only.

## R-8 Gallery write (FR-040–FR-044, AS-30–AS-38)

- **Decision**: `GalleryService.replace(shopId, productId, mediaIds, expectedVersion, actor)`: check order = shop gate (`ShopScoped`) → product through `ProductQueryService.getProductsByIds([productId], {shopId})` (missing/foreign → `404 product_not_found`; `ARCHIVED` → `409 product_archived`) → body is already validated by the pipe (the spec's order puts version before attachability) → `tx { ensure ProductGallery row (INSERT … ON CONFLICT DO NOTHING, version 0) ; SELECT … FOR UPDATE ; compare expectedVersion (409 version_conflict + currentVersion) ; load photos by (id IN ids AND shopId = $s AND purpose='product') FOR SHARE ; classify failures (not_found for unknown/other shop/review, not_ready for own non-READY) → 422 ; no-op when list and version equal ; DELETE+INSERT ProductMedia (one multi-row insert) ; version+1 ; outbox gallery_changed }`. The row lock on `ProductGallery` serialises two `PUT`s with the same `expectedVersion`; the loser re-reads the bumped version and answers `409` (AS-35). The `READY` check uses `FOR SHARE` on the photo rows so a concurrent `DELETE` (which needs `FOR UPDATE` on the photo) cannot interleave.
- The product call (R1) is made **before** the transaction (no network I/O inside it, III.3). A product archived or deleted in the milliseconds between is acceptable: the gallery of an archived product stays readable by members and `catalog.product_deleted` removes it.
- Reads: member `GET` shares the item mapper; public `GET /products/:productId/gallery` (exists since W02 B-1) is rewritten to use `getProductsByIds([id])` + `ShopQueryService.getShopsByIds([shopId])` for visibility (ACTIVE product, not sandbox, shop ACTIVE and not sandbox) instead of `isPubliclyVisible`, and the join to `Media` becomes the gallery repository's query; the existing `media-gallery-public.e2e-spec.ts` scenarios are kept (L-017: the scenarios survive the rename into `media-gallery.e2e-spec.ts`) and the file is folded in.
- Max batch of R1 calls per page: one (`getProductsByIds` once per request), as S05's follow-up asks.

## R-9 Read paths and the optional principal (FR-050–FR-054)

- **Decision**: `GET /media/:id` keeps `@Firewall({anonymous:true})` (`UserAuthOptionalGuard` sets `request.user = null` or the user). The application service tries the owner view only when a user is present: one query `WHERE id = $1 AND (status='READY' OR "uploaderId" = $2 OR ($3 shop-member condition))`. Shop-member condition: since membership lives in S03, the service first loads by `id AND status<>'DELETED'` with `uploaderId = $user` (fast path) and, for a non-uploader and a non-`READY` shop photo, calls `ShopAccessService.assertMember(shopId, userId, 'products.read')` and treats a throw as `404`; the lookup of the photo itself therefore carries the principal for the uploader path, and the member path is a second, shop-scoped query (`WHERE id=$1 AND "shopId"=$2`) after the membership proof (III.4 satisfied: the shop is the principal of that query).
- `Cache-Control`: `public, max-age=15` for READY public views, `private, no-store` for owner views, set by a response interceptor local to the controller (not in the service). Batch: `SELECT … WHERE id = ANY($1) AND status='READY'`, one statement, answered in request order with `null` for the rest. `getReadyMediaByIds` is the same query with the optional predicates inside the `WHERE`, DTO mapping through one `toUrls(variants, mediaOrigin)` function used by every read (A8: `media_cdn_url` is required, no fallback).
- Rate limit `media.read.ip` on `GET /media/:id`, `GET /batch/media`, both gallery reads (fail open).

## R-10 Rate-limit policies (S50 follow-up, A2)

- **Decision**: `media/rate-limit-policies.ts` with `definePolicies('media', …)` declares `media.upload.user` (tokenBucket 30/60 s, key `user`, closed), `media.upload.shop` (120/60 s, key `shop`, closed), `media.gallery.shop` (60/60 s, key `shop`, closed), `media.read.ip` (600/60 s, key `ip`, open), and augments `PolicyNameRegistry` like `marketing/rate-limit-policies.ts`; `MediaModule` registers them. `discussion.write` is no longer referenced by `media`. `complete` and `DELETE` carry no extra policy: they act only on rows the caller owns, are idempotent and bounded by the 50-slot quota (FR-006 limits "upload requests" only); this is recorded so the choice is visible. The `shop`-keyed policies take the path `shopId` after the `ShopScoped` guard has run.
- The names that S50's G-35 lists as mis-used stay declared by the domain that holds the call site; media's call site is `discussion.write` in `media.controller.ts` — removed.

## R-11 Jobs and consumers (S49, S53; FR-046, FR-062–FR-064)

- **Decision**: `MediaWorkerModule` (apps/worker) declares three job types with `declareJobType` next to the `JobPayloads` augmentation (payload `z.object({}).strict()`), registers schedules with `upsertSchedule` (`*/5 * * * *`, `* * * * *`, `0 * * * *`) catching `InvalidScheduleError`, and the handlers call application services (`ExpireUploadsService`, `RequeueStuckService`, `PurgeService`) whose pure decision parts (cut-off times, what is shared) are in `domain/`. Handlers are bounded (100 / 100 / 200 rows) and idempotent; single-run is S49's lease. No `JobsService.cancel` is used. Storage deletes happen outside DB transactions; a failed delete leaves the row for the next run (AS-53).
- `MediaProjectorModule` (apps/projector) declares two projectors (`catalog.product_deleted` v1, `tenancy.shop_deleted` v1) following the S53 `Projector` declaration used by `ShareLinksProjectorModule`; idempotency mechanism is **natural** (delete-by-key is a no-op the second time; photo `→ DELETED` is a conditional update), documented in the module. Payloads are validated with zod from `contracts`; failures are dead-lettered by the framework. The media module must be loadable in `apps/projector` (S32 follow-up): `MediaProjectorModule` imports only database, outbox and the projections framework, never `StorageModule` or `ProductModule`.
- `catalog.product_deleted` and `tenancy.shop_deleted` schemas are imported from the producers' contracts (check at implementation; if only the producers' internal types exist, a media-local zod subset is used with a `[CONTRACT]` bullet).

## R-12 Migrations: expand → backfill → contract (III.11, E1, C-3)

Three files (naming as S19: `…-media-s29-expand.js`, `…-backfill.js`, `…-contract.js`), each with `SET lock_timeout`; indexes `CREATE INDEX CONCURRENTLY` (migration outside a transaction block, as the S19 files do — pattern copied from `20261013120000-pickup-s19-expand.js`).

1. **Expand**: new `Media` columns `attempts INT NOT NULL DEFAULT 0`, `leaseUntil`, `version INT NOT NULL DEFAULT 1`, `rejectCode TEXT`, `uploadedAt`, `duplicateDistance SMALLINT`, `duplicateAt`; CHECK on `status` replaced by one allowing the seven statuses (`NOT VALID` then `VALIDATE`), CHECK on `purpose` allowing `product|review` (`post` rows handled in step 2 first, so `VALIDATE` runs after the backfill); tables `MediaStatusHistory`, `ProductGallery`; indexes: `(uploaderId, status)`, `(shopId)`, `(status, uploadedAt) WHERE status='UPLOADED'`, `(leaseUntil) WHERE status='PROCESSING'`, `(status, updatedAt) WHERE status IN ('REJECTED','EXPIRED','DELETED')` for purge, product-only partial band indexes replacing the four old ones.
2. **Backfill** (batched): `rejectCode` from `rejectReason` (`not a decodable image…` → `not_an_image`, else `processing_failed`); legacy `post` rows → `DELETED` with a history row (actor `system`; they were never linked to anything, S25 is text-only); one `ProductGallery` row per product that has `ProductMedia` rows (version 1); a history row `null → <current status>` for every existing photo so the history is complete.
3. **Contract**: drop the foreign keys `Media.shopId → Shop`, `Media.uploaderId → User`, `ProductMedia.productId → Product` (one statement each, `lock_timeout`), drop column `rejectReason`, drop the old band indexes. The `ProductMedia.mediaId → Media` FK stays (same owner) but loses `ON DELETE CASCADE`: the purge removes a photo's links first.
Running code between steps: expand is backward compatible (new columns have defaults; old code still writes `rejectReason`, still reads `PENDING_UPLOAD/PROCESSING`); the contract step ships only after the new code is deployed.

## R-13 Configuration (E3, FR-091, AS-58)

`media_cdn_url`, `media_bucket`, `clamd_address` (existing key name to be confirmed in `types.ts:150`) become required when `NODE_ENV=production`; validation lives in the existing config rules module (S54 startup validation) with named errors; the "different site" rule compares the origin's registrable host to `front_host` and the API host. A non-production `media_scanner_disabled=true` switch selects `DisabledMalwareScanner` and logs a warning at startup. The Lambda reads the same names from its environment and validates them at module load (throws → cold-start failure is visible).

## R-14 Observability (FR-090, AS-57)

Metrics registered in the S54 registry: `media_processing_total{result}`, `media_processing_seconds`, `media_upload_to_ready_seconds`, `media_duplicate_suspected_total`, `media_duplicate_scan_truncated_total`, `media_unknown_key_total`, `media_scan_unavailable_total`, `media_processing_attempts_exhausted_total`. The processor takes a `MediaMetrics` port (`inc`, `observe`) so the Lambda adapts it to its CloudWatch EMF helper (`shared/telemetry.ts`) and Nest adapts it to the registry. Log lines come from a `MediaLogger` port: `{ mediaId, result, attempt, durationMs, requestId, traceId }`; the trace/request id are read from the message attributes (queue attributes written by `enqueue`, propagated from the request context at `complete`).

## R-15 Lambda handler (B11)

`apps/lambdas/src/handlers/media-processing.ts` builds its adapters (pg pool with `max: 2`, S3 client, clamd scanner, EMF metrics) and calls `createMediaProcessor`; the Dynamo `Idempotency` wrapper is removed: the row claim and the lease are the idempotency mechanism (R-2) and the 120 s window longer than the 60 s timeout disappears. `BUSY` and transient errors throw so SQS redelivers (partial batch response); `SKIPPED`, `READY`, `REJECTED` acknowledge. Keys outside `media/originals/` are filtered **and counted** (`media_unknown_key_total` for unknown keys inside the prefix; a debug log for foreign prefixes). The S3 notification parser stays.

## R-16 Tests (VII, test-plan.md)

Eight e2e files under `libs/domains/media/` + three unit specs, as in `test-plan.md`. Test-stack needs (L-011): a MinIO bucket `marketplace-media` with the object-created notification NOT required (tests deliver messages explicitly), Redis for the limiter, a TCP fault proxy helper (new `libs/domains/media/testing/fault-proxy.ts`), the `FakeMalwareScanner`, the in-memory queue transport. The doctor (`scripts/qa/…`) gets a check that the bucket and the `media-processing` queue exist (L-002/L-011): confirmed at implementation by reading `elasticmq.conf` and the doctor. Batches: run each e2e file in its own process (L-008); the whole domain suite once at the end.

## R-17 Items that stay outside code (rule 2)

AS-60 (bucket lifecycle and CDN headers: `infra/modules/s3_cloudfront` is edited and a post-deploy check script is added, but nothing in CI can prove it), AS-61 (k6 presign script + 1,000-image throughput script), SC-001 (95% READY within 10 s at 1,000 queued), SC-005 (p95 < 300 ms at 600 req/s). They go under "Ops artifacts" in `quickstart.md` and as rows in `specs/UNVERIFIED.md` (added at plan time, status `not run`). SC-002/SC-003/SC-004/SC-006–SC-009 are covered by the e2e and unit suites on a reduced corpus (the fixture corpus is generated by the test, not a 1,000-image set); the reduced size is stated in the tests, not claimed as the full criterion.

## R-18 Out of this plan (stated so nothing is silently dropped)

Web screen and journey (F1) belong to W04: a bullet for W04 goes in `gaps.md` and the Playwright file `seller-photos.spec.ts` is not created here. Video (S30) files are untouched, including the four `sequelize.transaction` sites in `video.service.ts`.

## Traceability: every `gaps.md` item → plan task area

| Gaps | Area (see `plan.md` work packages) |
|---|---|
| A1 | WP-2 contracts, WP-7 controllers (`ValidationPipe` whitelist, `forbidNonWhitelisted`) |
| A2 | WP-5 policies (R-10) |
| A3, A4, A5, E7 | WP-6 upload service, problem codes |
| A6 | WP-7 read/delete/batch/gallery routes |
| A7, A8, A9 | WP-7 read service, `MediaQueryService`, config |
| B1–B7, B10 | WP-4 processor core, WP-3 domain, WP-3b scanner/storage |
| B8, C1–C3 | WP-3 domain duplicate-match, WP-4 READY transaction |
| B9, E2 | WP-4 events, contracts |
| B11, E4 | WP-4b Lambda, barrel |
| D1–D3 | WP-8 gallery |
| D4 | WP-9 consumers and jobs |
| E1, C-2, C-3 | WP-1 migrations, registry |
| E3 | WP-1 config |
| E5 | WP-10 tests |
| E6 | WP-3/4 repository ports |
| F1 | out of scope (W04), gaps bullet |
| F2, F3 | WP-11 ops artifacts |
| C-1 | WP-8 (R1 for product) |
| C-4 | WP-4 events (R-7) |
| C-5 | WP-6/WP-7 (S03 `ShopAccessService`, `ShopQueryService`) |
| Debt D-6, D-7, D-8, D-12, domain-map §4 | WP-3, WP-4b, WP-1 |
