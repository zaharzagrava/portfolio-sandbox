# Gaps: S29 — current `media` photo code versus the spec

The implementation agent's to-do list. Paths are under `packages/backend/` unless stated; line numbers are those read on 2026-10-05. `pnpm --dir packages/backend check:table-ownership` was run (87 findings in 21 domains; `media` has 2, listed in section C). The video files (`api/video.controller.ts`, `application/video.service.ts`, `domain/dag.ts`, `domain/hls.ts`, `infra/ffmpeg.ts`, `video.module.ts`) belong to S30 and are not listed.

## A. Code versus spec

### Upload API

| # | Gap | Where | Spec |
|---|---|---|---|
| A1 | `UploadDto.purpose` accepts `post`; there is no unknown-field rejection test and no `packages/contracts` schema (`mediaUploadResponseSchema` and the rest) for any media route | `libs/domains/media/api/media.controller.ts:9-11` | FR-001, FR-073, AS-02, AS-03 |
| A2 | Review upload borrows `discussion.write` (10/min, shared with posting); the shop upload, `complete`, `GET` and the gallery `PUT` have no rate limit at all | `api/media.controller.ts:28,35,41,47,54` | FR-006, FR-053, AS-05, AS-46 |
| A3 | `createUpload` runs raw SQL in `application/` (no repository, no history row, no quota, no transaction), signs an `image/` prefix (admits SVG, GIF, TIFF), returns no `expiresAt` of its own or `allowedContentTypes`, and returns the signed object including `key` | `application/media.service.ts:36-46` | FR-002–FR-005, AS-01, AS-04 |
| A4 | Policy has a prefix only: no exact type list and no minimum size | `application/media.service.ts:44` | FR-003, AS-06 |
| A5 | `complete` is select-then-act, never changes the status (so every call enqueues again), returns `200 {status}` for any state, `400` for a missing object, re-checks neither the size nor, for a shop photo, the uploader's current `products.write`, and enqueues without a recoverable `UPLOADED` state | `application/media.service.ts:53-64` | FR-008, AS-07–AS-10 |
| A6 | No `DELETE /media/:id`, no batch read, no public or member gallery read, no `GET` of a gallery version | `api/media.controller.ts` (whole file) | FR-040, FR-050–FR-052, FR-061, AS-37, AS-38, AS-44, AS-47 |

### Read

| # | Gap | Where | Spec |
|---|---|---|---|
| A7 | `GET /media/:id` is anonymous for every status (pending uploads and rejected files are readable by UUID), returns `rejectReason` (raw decoder text) and has no owner or shop-member view | `api/media.controller.ts:47-51`; `application/media.service.ts:66-75` | FR-050, FR-051, AS-41, AS-42, AS-54 |
| A8 | URL base falls back to `<s3_endpoint>/<bucket>` when `media_cdn_url` is unset: the storage endpoint becomes the "media origin" | `application/media.service.ts:71`; `libs/common/config/types.ts:103-106` | FR-054, FR-070, AS-55, AS-58 |
| A9 | No `MediaQueryService` (R1) with ownership predicates; no `getReadyMediaByIds`; no `Cache-Control` | whole domain; `index.ts` | FR-052, AS-44, AS-45 |

### Processing

| # | Gap | Where | Spec |
|---|---|---|---|
| B1 | Claim re-takes any `PROCESSING` photo at any time (no lease, no attempt count, no `BUSY`): two workers can process one photo; a poison file loops until the queue gives up | `infra/media-processor.ts:30-34` | FR-010, FR-019, AS-21, AS-22 |
| B2 | Unknown key returns `SKIPPED` silently (no counter); the Lambda filters keys but no log or metric says "ignored" | `infra/media-processor.ts:34`; `apps/lambdas/src/handlers/media-processing.ts:52` | AS-20, AS-57 |
| B3 | Rejection stores `error.message` verbatim (decoder text) in `rejectReason`; no closed codes, no history row, no `media.rejected` event | `infra/media-processor.ts:38-42`; `infra/image-pipeline.ts:41,43-45` | FR-018, AS-16, AS-17 |
| B4 | No malware scan of photos (`catalog-sync` has the only clamd adapter) | `infra/media-processor.ts:37`; `libs/domains/catalog-sync/infra/clamav.ts` | FR-013, AS-18, AS-19 |
| B5 | Allowlist contains `heif` (which also admits AVIF-in-HEIF and HEIC if the decoder has it); no multi-frame check (an animated WebP passes as its first frame); no sRGB conversion before the profile is dropped | `infra/image-pipeline.ts:5,40-47,50` | FR-011, FR-012, FR-014, AS-13, AS-16 |
| B6 | No timeouts on the original read, the variant writes or the whole run; no check that the three variant objects exist before `READY`; a partial write is only safe by accident | `infra/media-processor.ts:37,46-50` | FR-017, FR-020, AS-23, AS-24 |
| B7 | Size is only enforced by the signed policy; an object written another way is processed regardless | `infra/media-processor.ts:37`; `application/media.service.ts:59-60` | FR-012, AS-08 |
| B8 | Hash comparison, band split and the matching rule (`hamming`, `bands`, `NEAR_DUPLICATE_BITS`) live in `infra/` beside the image library instead of `domain/` | `infra/image-pipeline.ts:73-84`; `infra/media-processor.ts:11,58` | I.3, AS-27, AS-28 |
| B9 | Event written by raw `INSERT INTO "Outbox"` (IX.6), with a hand-built envelope (`schemaVersion`, no `uploaderId`, no `mediaVersion`) and the `possibleDuplicateOf` of another shop's photo inside the payload | `infra/media-processor.ts:68-89` | FR-017, FR-080, AS-56, AS-25 |
| B10 | Status changes write no history row; there is no `version` on the row | `infra/media-processor.ts:30,41,63-65`; `migrations/20261002090000-media.js` | FR-060, AS-49 |
| B11 | Lambda handler: Dynamo idempotency with a 120 s window longer than the 60 s function timeout; no trace propagation from the message; metrics use ad hoc names (`Marketplace/Media`); builds the processor with raw `pg` and S3 SDK because the barrel exports `MediaProcessor` and `Sql` | `apps/lambdas/src/handlers/media-processing.ts:17-41,53-58` | FR-020, FR-090, AS-57, D-8 |

### Duplicate detection

| # | Gap | Where | Spec |
|---|---|---|---|
| C1 | Detection runs for every purpose (review photos are hashed and compared); candidates come from `LIMIT 200` with no order and the first one under the threshold wins, not the nearest; no near-uniform rule; no truncation counter | `infra/media-processor.ts:52-58` | FR-030–FR-032, AS-26–AS-28 |
| C2 | The scan runs before and outside the READY transaction and takes no lock: two simultaneous near-duplicates both see nothing | `infra/media-processor.ts:52-67` | FR-033, AS-29 |
| C3 | The match is stored as a bare `possibleDuplicateOf` with no distance or time, and published on `media.ready`; there is no moderation event | `infra/media-processor.ts:66,80`; `application/events/media-events.ts:10` | FR-034, AS-25 |

### Gallery

| # | Gap | Where | Spec |
|---|---|---|---|
| D1 | No gallery version, no `expectedVersion`: last writer wins; delete-all then N inserts in a loop | `application/media.service.ts:77-88` | FR-040, FR-043, AS-30, AS-31, AS-35 |
| D2 | One `400` for every failure; the product check is a `JOIN "Product"` with a raw query (IX.4); no archived check, no `product_not_found` vs not-attachable distinction, no purpose check, no per-photo `failures` | `application/media.service.ts:79-82` | FR-041, FR-042, AS-33, AS-34 |
| D3 | No event on a gallery change; `GalleryDto` does not reject duplicate IDs | `application/media.service.ts:83-86`; `api/media.controller.ts:13-15` | FR-044, AS-30, AS-32 |
| D4 | No consumer of `catalog.product_deleted` (the FK `ON DELETE CASCADE` does the job today) or `tenancy.shop_deleted`; no jobs for expiry, re-drive or purge; nothing ever deletes an original or a variant | whole domain; `migrations/20261002090000-media.js` | FR-046, FR-062–FR-064, AS-39, AS-40, AS-51–AS-53 |

### Schema, events, configuration, tests

| # | Gap | Where | Spec |
|---|---|---|---|
| E1 | Migration: CHECK allows only four statuses; no `attempts`, `leaseUntil`, `version`, `rejectCode`, duplicate distance/time; no `MediaStatusHistory`, no `ProductGallery`; foreign keys to `Shop`, `User` and `Product` (cascade); no index for `(uploaderId, status)`, `(shopId)`, `UPLOADED` age, `PROCESSING` lease; band indexes cover `READY` photos of every purpose | `migrations/20261002090000-media.js:13-33` | FR-100, AS-47–AS-53, AS-59 |
| E2 | Event file defines only `media.ready`, its header comment claims consumers (feed, discussions) that do not exist, ID types are bare strings, and the Lambda writes the envelope by hand instead of validating against it | `application/events/media-events.ts:5-11` | FR-080, AS-56 |
| E3 | `media_cdn_url`, `media_bucket` and the scanner address are optional config keys, with no startup validation and no "different site" check | `libs/common/config/types.ts:103-108` | FR-091, AS-58 |
| E4 | Barrel exports `MediaProcessor` and `Sql` (D-8) and no `MediaQueryService`, `createMediaProcessor`, `MediaWorkerModule`, `MediaProjectorModule`; `MEDIA_QUEUE` is exported from `media.service.ts` and used by the Lambda manifest by name | `index.ts:7-10`; `application/media.service.ts:9` | X.4, FR-100, AS-59 |
| E5 | `media.e2e-spec.ts` calls services directly with the queue mocked (no HTTP, no 401, no IDOR, no validation classes, no concurrency, no 429, no contract schemas); only three tests; one reads rows with raw SQL in the test | `media.e2e-spec.ts:71-118` | VII.2, VII.3, VII.6, all rows of `test-plan.md` |
| E6 | Application layer holds SQL and a Sequelize connection; there are no repository ports or `infra/` repositories | `application/media.service.ts:2-3,38-41,54,66,77-88` | I.2, III.1 (D-6) |
| E7 | Presign and complete send no problem+json `code`s from the vocabulary of FR-073 (plain `BadRequestException`/`NotFoundException` messages) | `application/media.service.ts:37,58,60,82` | FR-073 |

### Operations and web

| # | Gap | Where | Spec |
|---|---|---|---|
| F1 | No web code for photo upload or the product gallery exists (`packages/web` has no reference to `media/uploads` or a gallery); W04 owns the screen and its journey | `packages/web` (searched) | AS-12, AS-30 (UI rows) |
| F2 | The k6 presign script and the 1,000-image throughput script named in SD-10 are not in `scripts/load-tests/` | `scripts/load-tests` | AS-61 |
| F3 | Bucket lifecycle (30 days IA, 180 days archive, abort incomplete uploads) and the media origin header policy (`nosniff`, immutable, no cookies) are claimed in SD-10 but must be verified in `infra/modules/s3_cloudfront` and given a post-deploy check | `infra/modules/s3_cloudfront/main.tf` | AS-60 |

## B. Debt register rows (`docs/architecture/debt-register.md`) that name `media` or S29

| Row | What applies to `media` | Mechanism that pays it | Closed by |
|---|---|---|---|
| D-6 (I.2) | `application/media.service.ts` holds SQL and the Sequelize connection; no repository ports | Repository port in `domain/`, adapter in `infra/` (I.2, III.1) | A3, A5, D1, E6 |
| D-7 (IX.4) | `media` imports no foreign `*Model`; it exposes no model either. The row stays open for others who might import `media` models: the barrel exports none | none needed here; keep the barrel free of models | E4, AS-59 |
| D-8 (X.4) | Barrel exports `MediaProcessor` and `Sql` because the Lambda wires them directly | `createMediaProcessor(deps)` factory exported from the entry point; `MediaWorkerModule` and `MediaProjectorModule` for the apps | B11, E4 |
| D-12 (IX.4) | Raw SQL on `Product` and `ProductMedia` (section C); 2 of the 87 findings | R1 `getProductsByIds([id], {shopId})` for the product; ownership move for `ProductMedia` | C-1, C-2 |
| Domain map §4 (`Outbox`, infra: catalog-import, media) | Raw `INSERT INTO "Outbox"` in `media-processor.ts` | IX.6: the outbox lib's exported append function (framework-free for the Lambda) | B9 |
| D-1 … D-5, D-9, D-10, D-11, D-13 … D-17 | Resolved or about other domains: nothing for `media` | — | — |

## C. Table-ownership findings for `media` (`pnpm --dir packages/backend check:table-ownership`)

```
media  (2)
  SQL   Product        owned by catalog   libs/domains/media/application/media.service.ts
  SQL   ProductMedia   owned by catalog   libs/domains/media/application/media.service.ts
```

| # | Finding | Mechanism that replaces it |
|---|---|---|
| C-1 | `SQL Product` — `JOIN "Product"` in the gallery attach (`media.service.ts:79`); S05's `gaps.md` already lists this line | **R1**: `ProductQueryService.getProductsByIds([productId], { shopId })` (S05) to prove the product exists in the shop and is `ACTIVE`; then query only `Media` and the gallery tables |
| C-2 | `SQL ProductMedia` — `DELETE`/`INSERT` at `media.service.ts:83-86` on a table the registry gives to `catalog` | **Ownership move** (not an IX.7 read path): `db/ownership.ts:68` changes `ProductMedia` to `domain:media`, `ProductGallery` is added, and the domain map's catalog and media sections are updated; catalog never touches either table. Readers of galleries use **R2** (`GET /products/:id/gallery`, `GET /batch/media` composed by the BFF) or **R3** (`media.gallery_changed`) |
| C-3 | Not found by the tool: foreign keys `Media.shopId → Shop`, `Media.uploaderId → User`, `ProductMedia.productId → Product` (migration `20261002090000-media.js:15-16,36-37`) | Expand/contract migrations dropping the FKs (one step each, `lock_timeout`); the cascade becomes the **R3** consumer of `catalog.product_deleted`, shop deletion the consumer of `tenancy.shop_deleted` |
| C-4 | Not found by the tool: raw `INSERT INTO "Outbox"` (`media-processor.ts:68-89`) | IX.6 technical-table exception through the outbox lib's append function, inside the domain's own transaction |
| C-5 | Not found by the tool: `AuthModule` import for the guard and nothing for tenancy | S03 `ShopAccessService` (R1) for `complete` and `DELETE` of shop photos, `ShopQueryService` (R1) for the public gallery visibility; `TenancyModule` and the catalog module imported in `media.module.ts` through their public entry points |

## D. Order of work suggested to the implementation agent

1. Migrations and registry (E1, C-2, C-3), contracts schemas (A1), config keys (E3).
2. Domain code and unit tests: status table, matching rules, rejection codes, image-pipeline additions (B5, B8, AS-13–AS-16, AS-27–AS-28, AS-49).
3. Upload API and `complete` with quotas, limits and history (A2–A5, E7), then the processor with lease, scanner port, codes, timeouts and outbox append (B1–B11, C1–C3), then reads, batch, R1 service and delete (A6–A9).
4. Gallery with R1 product check, versions and events (D1–D3); consumers and the three jobs (D4).
5. Extract the scanner to `libs/infrastructure/antivirus` (S07 follow-up), extend the storage port (B4, B6, B7), wire `createMediaProcessor` in `apps/lambdas` (B11, E4).
6. Replace `media.e2e-spec.ts` with the suites of `test-plan.md` (E5); add the web journey with W04 (F1), load scripts and ops checks (F2, F3); run `pnpm check:table-ownership --strict` and `pnpm check:boundaries` for AS-59.
