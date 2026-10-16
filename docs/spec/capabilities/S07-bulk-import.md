---
id: S07
title: Bulk catalog import (multipart upload, malware scan, streamed parse, checkpoints and leases, error report)
kind: capability
status: draft
generated_at: 0000000
depends_on: [S01, S03, S05, S12, S29, S49, S50, S51, S53, S54]
concepts: [rate-limit-policy, outbox-task-queue, job-scheduler-lease, transaction-runner, problem-json-errors]
models: []
scope:
  - packages/backend/libs/domains/catalog-sync/**/*import*
  - packages/backend/libs/domains/catalog-sync/domain/error-report.ts
  - packages/backend/libs/domains/catalog-sync/domain/file-name.ts
  - packages/contracts/src/catalog-sync/imports.ts
---
# S07 - Bulk catalog import

## Purpose
A seller replaces hand-keyed listing with a CSV or JSON-lines file of up to 5 GiB. The browser sends the file to object storage in parts; the platform scans it, reads it as a stream in constant memory, writes the products only through the catalog's import command in batches of 500, keeps a fenced, resumable checkpoint after every batch, and gives the seller live progress and a downloadable report of the refused rows. Order export no longer belongs to this domain (S12).

## Entry points
- `POST /shops/:shopId/imports` starts an import under an `Idempotency-Key` (`201`); `GET /shops/:shopId/imports/:importId/upload` re-signs the missing parts; `POST …/complete` finishes the upload (`202`, `Location`); `POST …/cancel`; `GET …/:importId`; `GET /shops/:shopId/imports` (keyset); `GET …/error-report`. [code: packages/backend/libs/domains/catalog-sync/api/catalog-import.controller.ts#CatalogImportController]
- The queue `catalog-imports` carries `{importId}` only; a consumer in the worker app runs the import. [code: packages/backend/libs/domains/catalog-sync/infra/import.consumer.ts#ImportConsumer]
- The live topic `import:<importId>` carries `progress`, `done`, `failed` and `cancelled`. [code: packages/backend/libs/domains/catalog-sync/api/realtime-topics.ts#ImportJobTopics]
- Jobs: `catalog-sync.recover-stalled-imports` (every minute), `catalog-sync.expire-pending-imports` (every five minutes), `catalog-sync.purge-imports` (daily). [code: packages/backend/libs/domains/catalog-sync/infra/import.jobs.ts#ImportJobs]
- The event `catalogsync.import_finished` (version 1, topic `catalogsync.events`, shared with the integrations) and the tenancy events `shop_offboarding_started` and `shop_deleted`, which cancel and purge imports. [code: packages/backend/libs/domains/catalog-sync/infra/import-lifecycle.consumers.ts#ImportShopDeletedConsumer]

## Rules
- **S07.R-01** Starting needs `products.write` and an `Idempotency-Key` (8 to 128 characters of `A-Za-z0-9_-`); a replay returns the stored body, an in-flight twin answers `409`, another body under the key `422 idempotency_key_reuse`, a missing key `422 idempotency_key_required`. A malformed body, query or cursor is `400 validation_failed`, never `422`. [proof: S07 AS-01, S07 AS-02, S07 AS-03, S07 AS-04, S07 AS-05] [code: packages/backend/libs/domains/catalog-sync/api/catalog-import.controller.ts#CatalogImportController]
- **S07.R-02** The storage key is made by the server from the shop and job ids; the file name is display text only, sanitised to at most 120 characters with no control character, separator or quote. [proof: S07 AS-01, S07 AS-27, S07 AS-31] [code: packages/backend/libs/domains/catalog-sync/domain/file-name.ts#sanitiseFileName]
- **S07.R-03** A client resumes an unfinished upload through `GET …/upload`, which lists the stored parts and signs only the missing ones. [proof: S07 AS-06] [code: packages/backend/libs/domains/catalog-sync/application/import-start.service.ts#ImportStartService]
- **S07.R-04** Completing validates every part (1..n once, in order, ETag known to storage) and the assembled size; the first valid call wins by a conditional transition, answers `202` with `Location` and enqueues one message after commit; a repeat answers `200`; `CANCELLED` and `EXPIRED` answer `409 import_not_completable`; a size that differs from the declared one fails the import `size_mismatch` (`422`). [proof: S07 AS-07, S07 AS-08, S07 AS-09, S07 AS-10, S07 AS-11, S07 AS-12] [code: packages/backend/libs/domains/catalog-sync/application/import-start.service.ts#ImportStartService]
- **S07.R-05** The state machine has eight states and exactly thirteen allowed transitions; every status change is a conditional update from the expected state with a history row in one transaction, and a final status also writes `catalogsync.import_finished` in that transaction. [proof: S07 AS-58, S07 AS-64] [code: packages/backend/libs/domains/catalog-sync/domain/import-status.ts#canTransition]
- **S07.R-06** A shop has at most three non-final imports (store-enforced by a slot index), starts at most ten per hour (`429 rate_limited`, `503` when the limiter is down), and a suspended or deleting shop refuses writes (`403 shop_suspended`, `409 shop_offboarding`). [proof: S07 AS-61, S07 AS-62, S07 AS-63] [code: packages/backend/libs/domains/catalog-sync/rate-limit-policies.ts#catalogSyncRatePolicies]
- **S07.R-07** Before any row is read the whole file passes the shared malware scanner and fails closed: infected means `FAILED malware_detected`; an unavailable or stalled scanner stays `SCANNING` and becomes `FAILED scan_unavailable` at the third delivery; production without a scanner stops the app at start. [proof: S07 AS-21, S07 AS-22, S07 AS-23, S07 AS-24, S07 AS-25, S07 AS-32] [code: packages/backend/libs/domains/catalog-sync/application/import-runner.service.ts#ImportRunnerService]
- **S07.R-08** The reader is chosen by the first 4 KiB, not by the name: JSON lines when the first byte after an optional byte-order mark is `{`, CSV for other UTF-8 text, and archives, binaries, documents, UTF-16 and NUL bytes end `FAILED unsupported_file_type`. [proof: S07 AS-26, S07 AS-27] [code: packages/backend/libs/domains/catalog-sync/domain/import-sniff.ts#sniff]
- **S07.R-09** A record is at most 1 MiB: an oversized JSON line is one row error, an oversized CSV record fails the import `malformed_file`. Headers match case-insensitively after trimming; `sku`, `title`, `price`, `category` are required and a missing or repeated one ends `FAILED invalid_header`. [proof: S07 AS-14, S07 AS-16, S07 AS-28, S07 AS-42] [code: packages/backend/libs/domains/catalog-sync/infra/import-parse-stage.ts#parseStage]
- **S07.R-10** Prices become integer minor units without floating point (at most two decimals), an empty stock cell means "do not touch stock", and file-rule failures are report lines that never stop their neighbours. [proof: S07 AS-15, S07 AS-20] [code: packages/backend/libs/domains/catalog-sync/domain/import-row.ts#parseRecord]
- **S07.R-11** Valid rows go to the catalog's import command in batches of at most 500 in file order, and the same SKU never appears twice in a batch; the import writes no product row and no product event; re-importing unchanged data changes nothing. [proof: S07 AS-13, S07 AS-17, S07 AS-18, S07 AS-19] [code: packages/backend/libs/domains/catalog-sync/domain/import-batcher.ts#ImportBatcher]
- **S07.R-12** The pipeline is one cancellable stream with backpressure (never more than a batch plus 16 records ahead); an error or abort destroys every stage. [proof: S07 AS-43, S07 AS-42] [code: packages/backend/libs/domains/catalog-sync/infra/import-pipeline.ts#runImportPipeline]
- **S07.R-13** After every batch the counters, `lastRow`, `nextByteOffset`, header and format are committed as one unit under a fenced lease (5 minutes, renewed every minute); a resumed run reads from `nextByteOffset` and never sends a row at or before `lastRow`; a runner that lost its lease commits nothing. [proof: S07 AS-33, S07 AS-34, S07 AS-35, S07 AS-36, S07 AS-37] [code: packages/backend/libs/domains/catalog-sync/infra/repositories/sequelize-import.repository.ts#SequelizeImportRepository]
- **S07.R-14** Redelivery of a final job, or a malformed message, has no effect; shutdown stops at a consistent point and keeps the job `PROCESSING`. [proof: S07 AS-38, S07 AS-39, S07 AS-41] [code: packages/backend/libs/domains/catalog-sync/infra/import.consumer.ts#ImportConsumer]
- **S07.R-15** Failures are retried only by queue redelivery, at most three deliveries; permanent failures (`source_missing`, `shop_not_active`, `invalid_header`, `malformed_file`, `too_many_errors`) end the import at once; only a stable code and a fixed generic message are stored or returned. [proof: S07 AS-44, S07 AS-45, S07 AS-46, S07 AS-71] [code: packages/backend/libs/domains/catalog-sync/application/import-runner.service.ts#ImportRunnerService]
- **S07.R-16** The recovery job re-enqueues an `UPLOADED` import older than two minutes and any `SCANNING` or `PROCESSING` import with an expired lease, at most once per window. [proof: S07 AS-40] [code: packages/backend/libs/domains/catalog-sync/application/import-lifecycle.service.ts#ImportLifecycleService]
- **S07.R-17** The error report holds one line per problem (`row,sku,field,code,message`) in file order, each exactly once across resumes, with spreadsheet formula guards; it is delivered only as a ten-minute presigned download from the user-content origin, and no route links the source file. [proof: S07 AS-29, S07 AS-30, S07 AS-47, S07 AS-48, S07 AS-49, S07 AS-50] [code: packages/backend/libs/domains/catalog-sync/domain/error-report.ts#reportLines]
- **S07.R-18** The status shows exact counters, a generic failure, report availability and history, and none of the storage key, upload handle, link, lease or scanner signature; every other shop's import answers the same `404`. [proof: S07 AS-51, S07 AS-52, S07 AS-53, S07 AS-54] [code: packages/backend/libs/domains/catalog-sync/application/import-query.service.ts#ImportQueryService]
- **S07.R-19** Live progress goes to current members with `products.read`; terminal events are replayable and nothing depends on the live channel. [proof: S07 AS-55] [code: packages/backend/libs/domains/catalog-sync/api/realtime-topics.ts#ImportJobTopics]
- **S07.R-20** Cancel works from every non-final state (running imports stop at the next batch boundary), keeps earlier writes, and never races a completion into two states; abandoned uploads expire after 24 hours. [proof: S07 AS-56, S07 AS-57, S07 AS-59] [code: packages/backend/libs/domains/catalog-sync/application/import-start.service.ts#ImportStartService]
- **S07.R-21** A shop runs one import at a time in creation order; a job that finds the shop busy is handed back with a delay of 60 seconds plus or minus 20 percent without spending a delivery. [proof: S07 AS-60] [code: packages/backend/libs/domains/catalog-sync/infra/import.consumer.ts#ImportConsumer]
- **S07.R-22** `shop_offboarding_started` cancels the shop's non-final imports and `shop_deleted` removes its rows, history and objects, each safe to deliver twice; final records are purged on a schedule (report after 30 days, record after 90). [proof: S07 AS-65, S07 AS-66, S07 AS-67] [code: packages/backend/libs/domains/catalog-sync/infra/import-lifecycle.consumers.ts#ImportOffboardingConsumer]
- **S07.R-23** Logs carry `importId`, `shopId` and request id and no row data or link; metrics count rows by outcome, imports by status and durations. [proof: S07 AS-68] [code: packages/backend/libs/domains/catalog-sync/application/import-metrics.ts#importMetrics]
- **S07.R-24** The import code reads no table of another domain, exports no model, uses no direct `sequelize.transaction`, and the export routes are not served by `catalog-sync`. [proof: S07 AS-69, S07 AS-70] [code: packages/backend/libs/domains/catalog-sync/index.ts]

## Behaviors
- **S07.B-01** Given an `UPLOADED` import of 1,200 valid rows, when the worker runs, then the import is `DONE` with 1,200 created, three catalog calls of 500, 500 and 200, the file deleted and one finished event. [proof: S07 AS-13]
- **S07.B-02** Given a worker stopped after batch 3 of 6, when the message is redelivered, then the file is read from the stored byte offset and the final counters equal an uninterrupted run. [proof: S07 AS-34]

## Lifecycles
`PENDING_UPLOAD → UPLOADED → SCANNING → PROCESSING → DONE`; `PENDING_UPLOAD | UPLOADED | SCANNING | PROCESSING → FAILED`; `PENDING_UPLOAD | UPLOADED | SCANNING | PROCESSING → CANCELLED`; `PENDING_UPLOAD → EXPIRED`.

## Owns
Tables `ImportJob` and `ImportJobHistory`; the queue `catalog-imports` and its dead-letter queue; the topic prefix `import`; job types `catalog-sync.*-imports`; the event `catalogsync.import_finished`; the policy `catalog-sync.import-start.shop`. [code: packages/backend/libs/domains/catalog-sync/rate-limit-policies.ts#catalogSyncRatePolicies]

## Decisions
- Parse and DTO failures are `400 validation_failed` (the platform pipe), not the `422` the first spec draft named; `422` stays for `invalid_parts`, `size_mismatch` and the idempotency codes.
- Counters and the catalog write are separate stores, so a crash between them may move at most one batch from created or updated to unchanged on redelivery.
- The scanner is the shared `MalwareScanner` of `libs/infrastructure/antivirus`; the old `infra/clamav.ts` shim is gone.

## Known gaps
- Throughput and memory at 1,000,000 rows and 5 GiB, twenty parallel shops, the kill loop, the browser journey and the edge `nosniff` header are not proved by an automated test; they are listed in `specs/UNVERIFIED.md`.
