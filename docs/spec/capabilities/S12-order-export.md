---
id: S12
title: Order export (streamed CSV to object storage, live progress, fenced worker, retention)
kind: capability
status: draft
generated_at: 0000000
depends_on: [S03, S05, S10, S49, S50, S51, S53]
concepts: [rate-limit-policy, outbox-task-queue, job-scheduler-lease, transaction-runner, problem-json-errors]
models: []
scope:
  - packages/backend/libs/domains/orders/**/*export*
  - packages/contracts/src/orders/order-export.ts
---
# S12 - Order export

## Purpose
A shop's staff download everything the shop has sold as one CSV file. The file is built in the background in constant memory, straight into object storage, by a worker that owns the export through a lease; the seller starts the export, watches it progress and downloads it through a short-lived link. Exports, their routes, their queue and their live topic belong to `orders`, not to `catalog-sync`.

## Entry points
- `POST /shops/:shopId/order-exports` starts an export (`202`, `Location`); `GET /shops/:shopId/order-exports` lists the shop's exports by keyset; `GET /shops/:shopId/order-exports/:exportId` reads one; `POST /shops/:shopId/order-exports/:exportId/cancel` cancels; `GET /shops/:shopId/order-exports/:exportId/download` signs a ten-minute link. The two old paths under /shops/:shopId/exports (start and status) answer `404`; no controller defines them. [code: packages/backend/libs/domains/orders/api/order-export.controller.ts#OrderExportController]
- The queue `order-exports` carries `{exportId}` only; a consumer in the worker app runs the export. [code: packages/backend/libs/domains/orders/infra/order-export.consumer.ts#OrderExportConsumer]
- The live topic `order-export:<exportId>` carries `progress`, `done`, `failed` and `cancelled`. [code: packages/backend/libs/domains/orders/api/order-export-topics.ts#OrderExportTopics]
- Jobs: `orders.recover-stalled-exports` (every minute), `orders.expire-exports` (every 15 minutes), `orders.purge-exports` (daily). [code: packages/backend/libs/domains/orders/infra/order-export.jobs.ts#OrderExportJobs]
- The event `orderexport.finished` (version 1, topic `order_exports.events`) and the tenancy events `shop_offboarding_started` and `shop_deleted`, which cancel and purge exports. [code: packages/backend/libs/domains/orders/infra/order-export.tenancy.consumers.ts#OrderExportShopDeletedConsumer]

## Rules
- **S12.R-01** Starting needs `orders.manage`, an `Idempotency-Key` and at most five starts per shop and hour; a refused start creates no job and stores nothing under the key. [proof: S12 AS-01, S12 AS-20, S12 AS-23, S12 AS-26] [code: packages/backend/libs/domains/orders/rate-limit-policies.ts#ordersRatePolicies]
- **S12.R-02** At most one export per shop is `QUEUED` or `RUNNING`, enforced by a partial unique index, and a second start answers `409 export_already_active` with `activeExportId`. [proof: S12 AS-24, S12 AS-25] [code: packages/backend/libs/domains/orders/infra/export-job.repository.ts#SequelizeExportJobRepository]
- **S12.R-03** The file holds exactly the shop's own order lines, one record each, in the order of the shop order's creation time, shop order id and line id, with exact money, a byte-order mark, CRLF records and a leading apostrophe on text cells that start with `=`, `+`, `-`, `@`, tab or carriage return. [proof: S12 AS-03, S12 AS-06, S12 AS-08, S12 AS-13, S12 AS-14] [code: packages/backend/libs/domains/orders/domain/export-csv.ts#encodeRecord]
- **S12.R-04** The SKU comes from the catalog's exported lookup in batches of at most 500 distinct products, never one call per line; the title is the snapshot taken at purchase. [proof: S12 AS-07] [code: packages/backend/libs/domains/orders/infra/export-sku.adapter.ts#ExportSkuAdapter]
- **S12.R-05** The worker reads keyset batches of 1,000 lines, each its own short read with no open transaction or held connection, and pulls the next batch only when storage accepts the previous bytes (at most 3,000 lines read ahead). [proof: S12 AS-09, S12 AS-10, S12 AS-11] [code: packages/backend/libs/domains/orders/infra/export-line.reader.ts#ExportLineReader]
- **S12.R-06** A status change is a conditional update that carries the lease holder, with a history row (and, for a final status, the outbox event) in one transaction; a worker that lost its lease changes nothing. [proof: S12 AS-50, S12 AS-60, S12 AS-61] [code: packages/backend/libs/domains/orders/domain/export-state.ts#canTransition]
- **S12.R-07** A transient failure (storage, catalog, database) returns the export to `QUEUED` and is retried by queue redelivery up to three attempts; a permanent failure ends in `FAILED` at once; only a stable failure code and a fixed generic message are stored or returned. [proof: S12 AS-33, S12 AS-34, S12 AS-35, S12 AS-36, S12 AS-37, S12 AS-38] [code: packages/backend/libs/domains/orders/domain/export-failure.ts#classify]
- **S12.R-08** Progress is stored and published at most once a second and always for the last batch; publishing is advisory and never fails the export. [proof: S12 AS-15, S12 AS-16, S12 AS-17] [code: packages/backend/libs/domains/orders/domain/export-progress.ts#shouldPublishProgress]
- **S12.R-09** Cancelling a `QUEUED` or `RUNNING` export ends it as `CANCELLED`; cancelling a `CANCELLED` export answers `200` unchanged; `DONE`, `FAILED` and `EXPIRED` exports answer `409 export_not_cancellable`. [proof: S12 AS-39, S12 AS-40, S12 AS-41, S12 AS-42] [code: packages/backend/libs/domains/orders/application/order-export-command.service.ts#OrderExportCommandService]
- **S12.R-10** The download link exists only for a `DONE` export (`409 export_not_ready` before, `410 export_expired` after expiry), is an attachment named `orders-<exportId>.csv`, and each issued link is audited in a log line without the link. [proof: S12 AS-05, S12 AS-19, S12 AS-51, S12 AS-58] [code: packages/backend/libs/domains/orders/application/order-export-command.service.ts#OrderExportCommandService]
- **S12.R-11** A stalled export is recovered: an expired lease returns the export to `QUEUED` or, at the third attempt, ends it as `FAILED attempts_exhausted`; an unclaimed `QUEUED` export older than two minutes is enqueued again. [proof: S12 AS-45, S12 AS-46, S12 AS-47, S12 AS-48, S12 AS-49] [code: packages/backend/libs/domains/orders/application/order-export-maintenance.service.ts#OrderExportMaintenanceService]
- **S12.R-12** A finished file is deleted after seven days (`EXPIRED`) and a finished record after ninety days; a refused delete leaves the export `DONE` and is retried. [proof: S12 AS-51, S12 AS-52] [code: packages/backend/libs/domains/orders/application/order-export-maintenance.service.ts#OrderExportMaintenanceService]
- **S12.R-13** `shop_offboarding_started` cancels the shop's active exports and `shop_deleted` removes its files, rows and history, each safe to deliver twice. [proof: S12 AS-53, S12 AS-54, S12 AS-55] [code: packages/backend/libs/domains/orders/infra/order-export.tenancy.consumers.ts#OrderExportOffboardingConsumer]
- **S12.R-14** Only a current member of the shop with `orders.manage` may read, download, cancel or listen to an export; every refusal looks the same as an unknown export. [proof: S12 AS-18, S12 AS-27, S12 AS-28, S12 AS-29] [code: packages/backend/libs/domains/orders/api/order-export-topics.ts#OrderExportTopics]
- **S12.R-15** The domain reads no table of another domain for exports, exports no model, and `catalog-sync` holds no export code or queue use. [proof: S12 AS-56, S12 AS-57]
- **S12.R-16** A configuration value that is out of range stops the app at start and names the key. [proof: S12 AS-59] [code: packages/backend/libs/common/config/orders-config.ts#ordersExportRule]

## Behaviors
- **S12.B-01** Given the standard five lines of a shop, when the export runs, then the job is `DONE` with 5 rows, the file holds the header and 5 lines, and one finished event exists. [proof: S12 AS-02]
- **S12.B-02** Given a worker killed in the middle of a run, when recovery runs after the lease, then the export is redelivered and the final file equals the file of an uninterrupted run. [proof: S12 AS-45]

## Lifecycles
`QUEUED → RUNNING → DONE → EXPIRED`; `RUNNING → FAILED`; `QUEUED | RUNNING → CANCELLED`; `RUNNING → QUEUED` on a retry, a lost lease or a shutdown.

## Owns
Tables `ExportJob` and `ExportJobHistory`; the queue `order-exports` and its dead-letter queue; the topic prefix `order-export`; job types `orders.*-exports`; the event `orderexport.finished`; the policy `orders.export-start.shop`; keys `orders_export_*`. [code: packages/backend/libs/domains/orders/rate-limit-policies.ts#ordersRatePolicies]

## Decisions
- Retries happen only by queue redelivery, so there is one retry layer; a stale worker's file is written to a per-attempt key and only the fenced completion makes it the export's file.
- A file is built from batches read at different instants: it excludes orders created after the request, and each line shows its shop order's status as of its batch.
- The event type is `orderexport.finished` on the topic `order_exports.events`: the platform's event-type pattern allows no `_` in the first segment and its topic names no `-`.

## Known gaps
- The benchmark (one million lines under five minutes and 200 MB), the chaos run and the edge settings (user-content origin, lifecycle rule for incomplete uploads) are not proved by an automated test; they are listed in `specs/UNVERIFIED.md`.
- A malformed shop id in a path is answered `404 shop_not_found` by the shop guard (S03), not `400 validation_failed`.
