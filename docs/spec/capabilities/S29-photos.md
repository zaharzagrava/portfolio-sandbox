---
id: S29
title: Product and review photos (upload, safe processing, duplicate flag, galleries, cleanup)
kind: capability
status: draft
depends_on: [S01, S03, S05, S49, S50, S53, S54]
concepts: [problem-json-errors, rate-limit-policy, outbox-task-queue, projection-and-replay, job-scheduler-lease, transaction-runner, tenant-shop-rbac]
models: []
scope:
  - packages/backend/libs/domains/media/api/media.controller.ts
  - packages/backend/libs/domains/media/api/gallery.controller.ts
  - packages/backend/libs/domains/media/api/batch.controller.ts
  - packages/backend/libs/domains/media/api/path-ids.guard.ts
  - packages/backend/libs/domains/media/api/media-problem.ts
  - packages/backend/libs/domains/media/application/upload.service.ts
  - packages/backend/libs/domains/media/application/media-read.service.ts
  - packages/backend/libs/domains/media/application/media-query.service.ts
  - packages/backend/libs/domains/media/application/media-delete.service.ts
  - packages/backend/libs/domains/media/application/gallery.service.ts
  - packages/backend/libs/domains/media/application/maintenance.service.ts
  - packages/backend/libs/domains/media/application/media-view.ts
  - packages/backend/libs/domains/media/application/events/media-events.ts
  - packages/backend/libs/domains/media/domain/*.ts
  - packages/backend/libs/domains/media/infra/image-pipeline.ts
  - packages/backend/libs/domains/media/infra/media-processor.ts
  - packages/backend/libs/domains/media/infra/media-blobs.ts
  - packages/backend/libs/domains/media/infra/media-consumers.ts
  - packages/backend/libs/domains/media/infra/media-observability.ts
  - packages/backend/libs/domains/media/infra/media-store.ts
  - packages/backend/libs/domains/media/infra/media-tx.ts
  - packages/backend/libs/domains/media/infra/pg-*.ts
  - packages/backend/libs/domains/media/media*.module.ts
  - packages/backend/libs/domains/media/media-maintenance.jobs.ts
  - packages/backend/libs/domains/media/media.constants.ts
  - packages/backend/libs/domains/media/rate-limit-policies.ts
  - packages/backend/libs/domains/media/index.ts
  - packages/backend/apps/lambdas/src/handlers/media-processing.ts
  - packages/backend/libs/infrastructure/antivirus/*.ts
  - packages/backend/libs/common/config/media-config.ts
  - packages/backend/migrations/20261013130*-media-s29-*.js
  - packages/contracts/src/media/media.ts
  - packages/contracts/src/media/gallery.ts
  - packages/contracts/src/media/events.ts
---
# S29 - Product and review photos (upload, safe processing, duplicate flag, galleries, cleanup)
## Purpose
A shop member uploads product photos and a signed-in buyer uploads review photos. The browser sends the bytes straight to storage with a short-lived signed permission, so the API never touches an image. A worker proves every upload safe before anyone can see it: it checks what the bytes really are, scans for malware, strips location and camera data, converts the colours to sRGB and writes three WebP sizes under names made from their content. A shop orders its product photos into a versioned gallery. Product photos that copy another shop's photo are flagged privately. Cleanup jobs expire unused slots, re-send lost work and purge old files.

## Entry points
- `POST /api/media/uploads` (review photos), `POST /api/shops/:shopId/media/uploads` (product photos), `POST /api/media/:id/complete`, `GET /api/media/:id`, `DELETE /api/media/:id`. [code: packages/backend/libs/domains/media/api/media.controller.ts#MediaController]
- `PUT` and `GET /api/shops/:shopId/products/:productId/gallery`, and the public `GET /api/products/:productId/gallery`. [code: packages/backend/libs/domains/media/api/gallery.controller.ts#GalleryController]
- `GET /api/batch/media?ids=`: up to 100 photos for the BFF. [code: packages/backend/libs/domains/media/api/batch.controller.ts#BatchController]
- `MediaQueryService.getReadyMediaByIds`: finished photos by id, with ownership predicates, for other capabilities. [code: packages/backend/libs/domains/media/application/media-query.service.ts#MediaQueryService]
- `createMediaProcessor`: the worker core that the `media-processing` Lambda runs. [code: packages/backend/libs/domains/media/infra/media-processor.ts#createMediaProcessor]
- Topic `media.events`: `media.ready`, `media.rejected`, `media.deleted`, `media.gallery_changed`, `media.duplicate_suspected`. [code: packages/backend/libs/domains/media/domain/media-events.ts#MediaReady]
- Jobs `media.expire-pending-uploads`, `media.requeue-stuck`, `media.purge`. [code: packages/backend/libs/domains/media/media-maintenance.jobs.ts#MediaMaintenanceJobs]
- Consumers of `catalog.product_deleted` and `tenancy.shop_deleted`. [code: packages/backend/libs/domains/media/infra/media-consumers.ts#MediaProductDeletedProjector]

## Rules
- **S29.R-01** The purposes MUST be `product` (shop route, member with `products.write`) and `review` (signed-in user); any other purpose, a missing purpose or an unknown field MUST answer `400` `validation_failed` and store nothing. [proof: S29 AS-02, S29 AS-03] [code: packages/backend/libs/domains/media/api/media.controller.ts#MediaController]
- **S29.R-02** The server MUST choose the storage key (`media/originals/shops/<shopId>/<uuid>` or `media/originals/users/<userId>/<uuid>`); the answer MUST carry no `key` property, and the signed form fields are the only place the key appears. [proof: S29 AS-01] [code: packages/backend/libs/domains/media/domain/upload-policy.ts#originalKeyFor]
- **S29.R-03** Asking for an upload MUST write the photo row and its first history row in one transaction, then sign locally; the signed permission binds the key, the `image/` content types, 1 to 15,728,640 bytes and 600 seconds. [proof: S29 AS-01, S29 AS-06] [code: packages/backend/libs/domains/media/application/upload.service.ts#UploadService]
- **S29.R-04** One uploader MUST hold at most 50 waiting uploads per scope (a shop, or personal); the 51st request answers `409` `pending_uploads_limit` with the count. [proof: S29 AS-04] [code: packages/backend/libs/domains/media/application/upload.service.ts#UploadService]
- **S29.R-05** Upload requests MUST be limited to 30 a minute per user and 120 a minute per shop, answering `429` with `Retry-After`, and `503` when the limiter store is down. [proof: S29 AS-05] [code: packages/backend/libs/domains/media/rate-limit-policies.ts#mediaRatePolicies]
- **S29.R-06** `complete` MUST accept only the uploader (a shop photo: only while they still hold `products.write`); it MUST move the photo `PENDING_UPLOAD → UPLOADED` conditionally and send one `{mediaId, originalKey}` message after the commit. [proof: S29 AS-07, S29 AS-09] [code: packages/backend/libs/domains/media/application/upload.service.ts#UploadService]
- **S29.R-07** `complete` MUST answer `409` `upload_incomplete` when the object is missing, reject an empty or oversize object as `size_invalid`, answer `409` `upload_expired` for an expired slot, and answer a replay from the stored state without a second message. [proof: S29 AS-08, S29 AS-09, S29 AS-10] [code: packages/backend/libs/domains/media/application/upload.service.ts#UploadService]
- **S29.R-08** A worker MUST claim a photo with one conditional update that sets a five-minute lease and counts the attempt; a held lease answers `BUSY`, a finished or unknown photo answers `SKIPPED`, and the fifth claim rejects the photo as `processing_failed`. [proof: S29 AS-20, S29 AS-21, S29 AS-22] [code: packages/backend/libs/domains/media/infra/pg-media-repository.ts#PgMediaRepository]
- **S29.R-09** The worker MUST decide the format from the bytes: JPEG, PNG, WebP and AVIF only, at most 50,000,000 pixels read from the header, one frame; every refusal MUST carry one code of `not_an_image`, `format_not_allowed`, `multi_frame`, `image_too_large`, `size_invalid`, `malware_detected` or `processing_failed`, never a decoder message. [proof: S29 AS-16, S29 AS-17] [code: packages/backend/libs/domains/media/infra/image-pipeline.ts#processImage]
- **S29.R-10** Every original MUST be scanned before a variant exists: an infected file is rejected as `malware_detected` and its original deleted; a scanner that gives no verdict ends the run transiently and the photo never becomes `READY`. [proof: S29 AS-18, S29 AS-19] [code: packages/backend/libs/domains/media/infra/media-processor.ts#createMediaProcessor]
- **S29.R-11** The pipeline MUST apply the EXIF orientation, convert pixels to sRGB, drop all metadata and write three WebP variants 200, 640 and 1600 pixels wide, never enlarged; the same input MUST give the same bytes and keys. [proof: S29 AS-12, S29 AS-13, S29 AS-14, S29 AS-15] [code: packages/backend/libs/domains/media/infra/image-pipeline.ts#processImage]
- **S29.R-12** A photo MUST become `READY` only after all three variant objects exist, and the status, history row, duplicate result and `media.ready` event MUST be written in one transaction with no storage call inside it. [proof: S29 AS-12, S29 AS-24] [code: packages/backend/libs/domains/media/infra/media-processor.ts#createMediaProcessor]
- **S29.R-13** Reading the original MUST stop after 20 seconds, each variant write after 10, the scanner after 15 and one run after 45; the run ends transiently with the lease released and the attempt counted. [proof: S29 AS-23] [code: packages/backend/libs/domains/media/infra/media-processor.ts#DEFAULT_LIMITS]
- **S29.R-14** Duplicate detection MUST apply to product photos only, compare against `READY` product photos of other shops, match at Hamming distance 3 or less, take the nearest (ties: smallest id) and never match a near-uniform hash. [proof: S29 AS-25, S29 AS-26, S29 AS-27] [code: packages/backend/libs/domains/media/domain/duplicate-match.ts#findNearest]
- **S29.R-15** Candidates MUST come from four 16-bit bands capped at 500 each, and the scan MUST run under advisory locks on the band values so two simultaneous copies see each other. [proof: S29 AS-28, S29 AS-29] [code: packages/backend/libs/domains/media/infra/pg-media-repository.ts#PgMediaRepository]
- **S29.R-16** A suspected duplicate MUST stay private: it MUST appear as `duplicateSuspected` on `media.ready` and with both shop ids on `media.duplicate_suspected`, and in no API response. [proof: S29 AS-25] [code: packages/backend/libs/domains/media/domain/media-events.ts#MediaDuplicateSuspected]
- **S29.R-17** A gallery MUST hold at most 20 `READY` product photos of its own shop; `PUT` MUST replace the whole list under a row lock on the version, answer `409` `version_conflict` with `currentVersion` for a stale version, and change nothing when the list and version equal the stored ones. [proof: S29 AS-30, S29 AS-31, S29 AS-35] [code: packages/backend/libs/domains/media/application/gallery.service.ts#GalleryService]
- **S29.R-18** A photo that cannot be attached MUST answer `422` `media_not_attachable` with a `failures` list: `not_found` for an unknown, foreign or review photo, `not_ready` for the shop's own unfinished one. [proof: S29 AS-33] [code: packages/backend/libs/domains/media/infra/pg-gallery-repository.ts#PgGalleryRepository]
- **S29.R-19** The gallery write MUST take the product from S05 (`getProductsByIds` with the shop) before the transaction: a missing or foreign product answers `404` `product_not_found`, an archived one `409` `product_archived`. [proof: S29 AS-34] [code: packages/backend/libs/domains/media/application/gallery.service.ts#GalleryService]
- **S29.R-20** A gallery body with more than 20 ids, a duplicate, a non-UUID, a bad `expectedVersion` or an extra field, or a malformed path id, MUST answer `400` `validation_failed` and change nothing. [proof: S29 AS-32] [code: packages/contracts/src/media/gallery.ts#galleryPutRequestSchema]
- **S29.R-21** The gallery write MUST need `products.write` and the gallery member read `products.read`, with `401`, `403`, the hidden `404`, `403` `shop_suspended` and `409` `shop_offboarding` as S03 defines them. [proof: S29 AS-36, S29 AS-37] [code: packages/backend/libs/domains/media/api/gallery.controller.ts#GalleryController]
- **S29.R-22** The public gallery MUST be served only while the product is `ACTIVE` and not a sandbox in an `ACTIVE`, non-sandbox shop; every other case answers one identical `404`. [proof: S29 AS-38] [code: packages/backend/libs/domains/media/application/gallery.service.ts#GalleryService]
- **S29.R-23** A `READY` photo MUST be readable by anyone as the public view with `Cache-Control: public, max-age=15`; any other status MUST be readable only by the uploader and, for a shop photo, by members with `products.read`, with `private, no-store`; everyone else gets the one `404`. [proof: S29 AS-41, S29 AS-42] [code: packages/backend/libs/domains/media/application/media-read.service.ts#MediaReadService]
- **S29.R-24** A malformed photo id MUST answer `400` before any database statement. [proof: S29 AS-43] [code: packages/backend/libs/domains/media/api/path-ids.guard.ts#uuidPipe]
- **S29.R-25** The batch read MUST answer in request order with `null` for anything not `READY`, from one statement, for at most 100 UUIDs; `getReadyMediaByIds` MUST put its predicates in the query and refuse more than 500 ids. [proof: S29 AS-44, S29 AS-45] [code: packages/backend/libs/domains/media/application/media-read.service.ts#MediaReadService]
- **S29.R-26** Photo reads MUST be limited to 600 a minute per address, answering `429` with `Retry-After`, and MUST still be served when the limiter store is down. [proof: S29 AS-46] [code: packages/backend/libs/domains/media/rate-limit-policies.ts#mediaRatePolicies]
- **S29.R-27** `DELETE` MUST be allowed to the uploader or, for a shop photo, a member with `products.write`; it MUST soft-delete with a history row and `media.deleted`, answer `409` `media_in_use` with the caller's products for a gallery photo and `409` `media_busy` while `UPLOADED` or `PROCESSING`, and do no storage call. [proof: S29 AS-47, S29 AS-48] [code: packages/backend/libs/domains/media/application/media-delete.service.ts#MediaDeleteService]
- **S29.R-28** A photo MUST move only along the twelve transitions of the status table, each by a conditional update with a history row, and `DELETED` MUST be final. [proof: S29 AS-49] [code: packages/backend/libs/domains/media/domain/media-status.ts#assertTransition]
- **S29.R-29** A late notification for a `REJECTED`, `EXPIRED` or `DELETED` photo MUST answer `SKIPPED` and change nothing; a second upload to a used key after `READY` MUST change nothing that is served. [proof: S29 AS-50] [code: packages/backend/libs/domains/media/infra/pg-media-repository.ts#PgMediaRepository]
- **S29.R-30** `media.expire-pending-uploads` MUST expire slots older than 60 minutes and delete their object; `media.requeue-stuck` MUST re-send `UPLOADED` photos older than 2 minutes and expired leases older than 10 minutes, at most 100 a run, once a minute; `media.purge` MUST remove terminal rows older than 7 days, at most 200 a run, keeping variants a live photo uses. [proof: S29 AS-51, S29 AS-52, S29 AS-53] [code: packages/backend/libs/domains/media/application/maintenance.service.ts#MaintenanceService]
- **S29.R-31** `catalog.product_deleted` MUST remove the product's gallery and `tenancy.shop_deleted` MUST delete the shop's photos and galleries; both MUST be harmless on a second delivery and refuse a malformed event without effect. [proof: S29 AS-39, S29 AS-40] [code: packages/backend/libs/domains/media/infra/media-consumers.ts#MediaShopDeletedProjector]
- **S29.R-32** Another user or another shop's member MUST get the same `404` as for an unknown photo on `complete`, `DELETE`, `GET` and gallery attachment, and nothing changes. [proof: S29 AS-54] [code: packages/backend/libs/domains/media/application/media-delete.service.ts#MediaDeleteService]
- **S29.R-33** No response MUST contain an original's key or a storage address; every URL MUST be on the configured media origin and name a content-hashed `.webp` object stored as `image/webp`. [proof: S29 AS-55] [code: packages/backend/libs/domains/media/domain/media-urls.ts#toUrls]
- **S29.R-34** Each of the five events MUST be written with the outbox in the transaction that changed the state, carry the envelope and a payload its schema accepts, and `mediaVersion` MUST only grow. [proof: S29 AS-56] [code: packages/backend/libs/domains/media/infra/pg-media-repository.ts#PgMediaRepository]
- **S29.R-35** The worker MUST count `media_processing_total{result}`, `media_processing_seconds`, `media_upload_to_ready_seconds`, `media_duplicate_suspected_total`, `media_duplicate_scan_truncated_total`, `media_unknown_key_total`, `media_scan_unavailable_total` and `media_processing_attempts_exhausted_total`, and log `mediaId`, `result`, `attempt`, `durationMs` and the queue message's `requestId` and `traceId`. [proof: S29 AS-57] [code: packages/backend/libs/domains/media/infra/media-observability.ts#registryMediaMetrics]
- **S29.R-36** Production MUST refuse to start without `media_cdn_url` (a different site from the app and the API), `media_bucket` and a scanner address, and with the scanner switched off; outside production the switch is allowed with a warning. [proof: S29 AS-58] [code: packages/backend/libs/common/config/media-config.ts#mediaProductionRule]
- **S29.R-37** The entry point MUST export only the Provides list, and `Media`, `MediaStatusHistory`, `ProductMedia` and `ProductGallery` MUST be registered to the media domain. [proof: S29 AS-59] [code: packages/backend/libs/domains/media/index.ts#createMediaProcessor]
- **S29.R-38** Originals MUST be private and move to cheaper storage after 30 and 180 days, and the media origin MUST send `nosniff`, the immutable cache header and no cookie. [proof: none] [code: infra/modules/s3_cloudfront/main.tf]

## Behaviors
- **S29.B-01** Given a shop member and a product photo, when they ask for an upload, post a JPEG to storage and call `complete`, then the photo is `UPLOADED` and one queue message exists. [proof: S29 AS-07]
- **S29.B-02** Given an uploaded 2400 × 1600 JPEG with GPS and an orientation tag, when the worker runs, then three clean WebP variants exist and `media.ready` is written once. [proof: S29 AS-12]
- **S29.B-03** Given a PHP script uploaded as `image/jpeg`, when the worker runs, then the photo is `REJECTED` with `not_an_image` and no variant exists. [proof: S29 AS-17]
- **S29.B-04** Given a photo claimed by a worker that died, when five minutes have passed, then another worker takes it over as attempt 2 and finishes it. [proof: S29 AS-21]
- **S29.B-05** Given a re-saved copy of shop A's photo uploaded by shop B, when it is processed, then it is `READY`, flagged privately, and no response names the match. [proof: S29 AS-25]
- **S29.B-06** Given two members who edit the same gallery version at once, then one answers `200`, the other `409`, and one event exists. [proof: S29 AS-35]
- **S29.B-07** Given a photo in a product gallery, when its uploader deletes it, then the answer is `409` `media_in_use` and the photo stays `READY`. [proof: S29 AS-48]
- **S29.B-08** Given a deleted shop, when the event is delivered twice, then its photos and galleries are gone once and a late worker run answers `SKIPPED`. [proof: S29 AS-40]
- **S29.B-09** Given a failing storage network on the third variant write, when the worker retries, then the first two variants keep their keys and the photo becomes `READY`. [proof: S29 AS-24]

## Lifecycles
A photo is `PENDING_UPLOAD`, then `UPLOADED` (browser confirmed), `PROCESSING` (claimed, lease held) and `READY` or `REJECTED`. An unused slot becomes `EXPIRED`. `READY`, `REJECTED`, `EXPIRED` and `PENDING_UPLOAD` can become `DELETED`, which is final; the purge job removes a terminal row seven days later. A gallery has a version that grows by one on every change.

## Owns
- PostgreSQL tables `Media`, `MediaStatusHistory`, `ProductMedia`, `ProductGallery` (plus S30's `Video` and `VideoTask`).
- Object-storage prefixes `media/originals/` (private) and `media/derived/` (public through the media origin).
- Queue `media-processing`, topic `media.events`, jobs `media.*`, consumer groups `media-product-deleted` and `media-shop-deleted`.
- Rate-limit policies `media.upload.user`, `media.upload.shop`, `media.gallery.shop`, `media.read.ip`.
- Metrics `media_*` and the problem codes of the photo routes.

## Decisions
- The worker core is framework-free (`createMediaProcessor`): the Lambda stays small and the same repository runs in Nest and in the Lambda over a `SqlRunner`.
- The claim and its lease are the idempotency mechanism; there is no second one in the Lambda.
- Storage cannot enforce a list of content types in a signed form, so the form allows `image/` and the worker decides from the bytes.
- Duplicate detection is advisory and private: it never blocks a photo and never names the other shop.

## Known gaps
- Throughput, latency and storage-tier criteria (SC-001, SC-005, AS-60, AS-61, SC-002 and SC-004 at 1,000 images) have no automated proof (listed in `specs/UNVERIFIED.md`).
- The seller screen and its browser journey belong to W04 and do not exist yet.
- The S32 index still shows no image: it must switch from its null image resolver to `getReadyMediaByIds`.
