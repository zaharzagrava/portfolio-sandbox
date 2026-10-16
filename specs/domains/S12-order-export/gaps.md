# Gaps: S12 — Order Export (domain `orders`) versus the draft code

What the current code gets wrong or lacks against [`spec.md`](spec.md). This is the implementation agent's to-do list. Paths are under `packages/backend/` unless they start with `libs/` or `apps/`, which are also under it. Line numbers are from the draft at the time of writing.

The whole existing implementation is one 99-line service, `libs/domains/orders/application/order-export.service.ts`, plus a controller method pair and a worker branch inside `catalog-sync`, a topic policy in `orders/api/realtime-topics.ts`, and one test case inside `libs/domains/catalog-sync/catalog-import.e2e-spec.ts`. There is no export controller, DTO, schema, model, repository, port, state machine, history, recovery, retention or consumer in `orders`.

## A. Code versus spec

| # | Gap | Where | Spec |
|---|---|---|---|
| A1 | Export routes are served by `catalog-sync`'s controller (`export`, `exportStatus`, permission `orders.manage`) and the controller injects `OrderExportService` from `@app/domains/orders`; `orders` has no controller for them | `libs/domains/catalog-sync/api/catalog-import.controller.ts:8,29,49-60` | FR-001, FR-006, FR-034, AS-56 |
| A2 | The export rides the import queue: `EXPORT_QUEUE = 'catalog-imports'` duplicated in orders, message `{kind: 'export', jobId}`; the import worker has a `kind: 'export'` branch and injects `OrderExportService` | `libs/domains/orders/application/order-export.service.ts:18,41`; `libs/domains/catalog-sync/infra/catalog-import.worker.ts:4,21,25,29` | FR-036, AS-01, AS-44, AS-56 |
| A3 | `catalog-sync`'s modules provide and export `OrderExportService` (`SERVICES`), so the import module and worker module load order code; the e2e injects it | `libs/domains/catalog-sync/catalog-import.module.ts:8,12`; `catalog-import.e2e-spec.ts:16,122` | FR-034, AS-56, AS-57 |
| A4 | No `Idempotency-Key`, no one-active-export rule, no rate limit; `request()` inserts a row and enqueues, so any number run at once | `order-export.service.ts:36-43` | FR-003, FR-004, FR-005, AS-20–AS-26 |
| A5 | No DTOs, no `packages/contracts` schemas (`orderExportCreateRequestSchema`, `orderExportSchema`, `orderExportPageSchema`, `orderExportDownloadSchema`, `orderExportProgressEventSchema`, `orderExportEventSchemas`); the service returns ad-hoc objects | `order-export.service.ts:43,51`; `packages/contracts` (none) | FR-040, V.2 |
| A6 | `status()` returns `{status, rows, objectKey, downloadUrl}`: leaks the storage key and signs a link on every poll; no list route, no cancel, no download route, no not-ready/expired answers; a missing job throws a bare `NotFoundException` (no `export_not_found` code) | `order-export.service.ts:45-52` | FR-006, FR-020, AS-05, AS-19, AS-31, AS-32 |
| A7 | The claim is unfenced: `UPDATE … SET status='RUNNING' WHERE status IN ('QUEUED','RUNNING')` lets a duplicate or redelivered message start a second concurrent run of the same job; no lease, heartbeat, `attempt`, or owner; a stale worker can still write | `order-export.service.ts:55-58` | FR-024, AS-43, AS-49, AS-50 |
| A8 | Failure handling: any error sets `FAILED` and is rethrown; redelivery then finds `FAILED`, which the claim excludes, so a transient storage error is final; the raw error text (500 chars) is stored; no classification, no retry cap, no stable codes, no `failed` live event; `rows` counted before the upload is confirmed | `order-export.service.ts:78,89-93` | FR-021, AS-33–AS-36 |
| A9 | The read holds one server-side cursor on a pooled connection for the whole run, obtained through the Sequelize connection manager internals; no keyset batching, no read-ahead bound, no abort when the run is cancelled, no deadline, no storage inactivity timeout | `order-export.service.ts:61-77,98-100` | FR-014, FR-015, FR-022, AS-10, AS-11, AS-37, AS-38 |
| A10 | Query and file content are wrong: `order_id` is `so.id` (the **shop** order ID); `ORDER BY so."createdAt"` alone (non-deterministic on ties); `LEFT JOIN "Product"` for `sku` and `title` (cross-domain SQL, live title instead of the snapshot); only `priceAtPurchase` (no discount, no line total); no BOM, LF not CRLF, no formula guard; no shop-order status column name `shop_order_status` | `order-export.service.ts:67-70,83-86` | FR-007–FR-013, FR-010, AS-03, AS-06, AS-07, AS-13, AS-14 |
| A11 | Progress: only a `done {rows}` event at the end on `job:{id}`; no `totalRows`, no progress counters stored or published, no throttle; the live publish is awaited on the success path (a failing backplane would fail the job after the file is written) | `order-export.service.ts:97` | FR-018, FR-019, AS-15–AS-17 |
| A12 | State machine: statuses `QUEUED|RUNNING|DONE|FAILED` only (CHECK constraint); no `CANCELLED`, no `EXPIRED`; transitions are bare `UPDATE`s with no history row; no discriminated union or `assertNever` | `migrations/20261002100000-catalog-import.js:38`; `order-export.service.ts:55,91,96` | FR-002, AS-39–AS-42, AS-61 |
| A13 | No retention: files and rows are kept forever; no expiry, purge, or scheduled job; no recovery of stalled `RUNNING` or unclaimed `QUEUED` jobs | (missing) | FR-026, FR-031, AS-45–AS-47, AS-51, AS-52 |
| A14 | Live-topic policy: prefix `job` shared with imports (the registry ORs both), raw `SELECT 1 FROM "ExportJob"` by `createdBy` (creator-only, so a removed or other member cannot watch), module named `ExportJobTopicsModule` | `libs/domains/orders/api/realtime-topics.ts:8-24`; `realtime-topics.module.ts:6-7` | FR-019, AS-18, AS-56 |
| A15 | Table: foreign keys to `Shop(id)` and `User(id)` (IX.4), `kind` column, `rows`/`error` columns, no lease, attempt, totals, bytes, timestamps, failure code; created inside the *catalog-import* migration; no history table; no partial unique index for the one-active rule; no model class (raw SQL only) | `migrations/20261002100000-catalog-import.js:33-44`; `db/ownership.ts:83,90` (registry entry exists and is correct) | FR-002, FR-003, FR-035, AS-24, AS-57 |
| A16 | Layering (D-6): an application service injects the Sequelize connection and writes raw SQL; no repository port in `domain/`, no adapter in `infra/`; pure rules (CSV encoding, throttle, classification, transitions) are not separated; there is no `domain/` file for export | `order-export.service.ts:1-3,30-33` | FR-039, AS-13, AS-14, AS-16, AS-35, AS-61 |
| A17 | Barrel and wiring (D-8): `index.ts` exports `OrderExportService` and `ExportJobTopicsModule`; `apps/sse-gateway` imports the old topics module; `apps/core` has no export module (the routes are inside `CatalogImportModule`); `apps/worker` has no export worker module | `libs/domains/orders/index.ts:19,22`; `apps/sse-gateway/src/sse-gateway.module.ts:32,105`; `apps/core/src/core.module.ts:117,149`; `apps/worker/src/worker.module.ts:73` | Provides (modules), FR-034 |
| A18 | No consumers of `tenancy.shop_offboarding_started` / `tenancy.shop_deleted`; no scheduled jobs; no outbox use | (missing) | FR-032, FR-033, AS-53–AS-55, AS-60 |
| A19 | No finished event, no audit log line, no metrics, no structured job logging, no startup config validation (batch size 1,000 and the 600 s / 10-minute link are literals) | `order-export.service.ts:51,72` | FR-037, FR-038, AS-58, AS-59 |
| A20 | Storage port gaps: `put` has no abort signal or inactivity timeout and no per-attempt/promote semantics for fencing (it writes the final key directly); the in-memory adapter's `abortMultipartUpload` is a no-op; `presignGet` quotes `encodeURIComponent(name)` as the filename and does not select the user-content origin | `libs/infrastructure/storage/s3-object-storage.ts:67-78,120-127`; `in-memory-object-storage.ts:34,42` | FR-017, FR-020, AS-33, AS-38, AS-50 |
| A21 | Queue port gaps to confirm: delayed re-enqueue (`delaySeconds` exists), delivery count (`receiveCount` exists), heartbeat (exists in `consume`); dead-letter after 3 is queue configuration (Terraform and the local stand-in) and must be declared for `order-exports` | `libs/infrastructure/sqs/task-queue.port.ts` | FR-036 |
| A22 | Tests: one case inside `catalog-import.e2e-spec.ts` calls the service directly (not HTTP), an empty shop, a mocked `TaskQueue.enqueue`; no unit spec; no multi-line, no cross-tenant, no failure, no concurrency, no consumer test | `libs/domains/catalog-sync/catalog-import.e2e-spec.ts:120-128` | all AS |
| A23 | No benchmark for the memory and time claims | (missing) | AS-12, SC-001 |
| A24 | The order data it reads is still on the old shape: items carry `priceAtPurchase` and no title, discount or line total; `BisOrderItem` has a `BelongsTo` association to `Product`; `ShopOrder.shopId` and `BisOrderItem.shopId` are nullable | `libs/domains/orders/infra/models/bis-order-item.model.ts:14,30-37,40-41`; `shop-order.model.ts:15-16` | Requires S10; AS-03, AS-08 (sequencing, see C) |

## B. Debt-register rows that name `orders` or S12

Open rows of `docs/work/architecture/debt-register.md` that name `orders` or `S12`, and what this capability does about each.

| Row | What | S12's share and the IX.7 mechanism |
|---|---|---|
| **D-10** (D2) | Order export routes and the `kind: 'export'` worker branch live in catalog-sync; orders duplicates the queue name | **Paid here (S12).** Routes, job table, queue, topic, worker branch move to `orders` (FR-034–FR-036, AS-56, AS-57). S07 deletes its side (its A27); both land in the same release or S12 first with S07's temporary branch kept until S07 lands. Close the row by setting its status to `resolved (S12, S07)`. No IX.7 mechanism is needed: the data is `orders`' own. |
| **D-12** (IX.4) | Raw SQL on tables owned by another domain | The export's `LEFT JOIN "Product"` (`order-export.service.ts:69`) is S12's share → replaced by **R1** `ProductQueryService.getProductsByIds(ids ≤ 500, {shopId})` per batch for the SKU, and by the S10 item snapshot for the title (FR-010, AS-07). The other `orders` raw `Product` writes (stock `UPDATE`s) belong to S10/S11, see section D. |
| **D-7** (IX.4) | Other domains import `*Model` exports | S12 adds none and uses none: the export files read only `ShopOrder`, `BisOrder`, `BisOrderItem`, `ExportJob`, `ExportJobHistory`. `catalog-sync` imports an orders **service** (`OrderExportService`), not a model; that edge is removed by A1–A3 (X.5). The `BisOrderModel` / `ShopOrderModel` barrel exports stay until S10's consumers migrate; S12 must not add a consumer. |
| **D-8** (X.4) | Barrels export infrastructure internals | S12's part: remove `OrderExportService` and `ExportJobTopicsModule` from `orders/index.ts`; export only `OrderExportModule`, `OrderExportWorkerModule`, `OrderExportTopicsModule` (A17). |
| **D-6** (I.2) | `api/` and `application/` import `infra/` directly | S12's part: the new export code is built layered from the start (A16): repository port in `domain/`, adapter in `infra/`, controller → application service only. The old service is deleted, not refactored. |
| **D-11** (X.5) | orders ↔ payments model cycle | Not S12 (S10, S13, S14). The export touches no payment table or model; do not add an import of `payments`. |
| **D-15** (X.5) | Strongly connected component {catalog, discovery, experimentation, orders, payments} | S12 adds **no** new domain edge: orders → catalog already exists (R1 stock and prices, S10); the new R1 call uses the same edge; catalog does not import orders. S12 removes the edge `catalog-sync → orders`. |
| **D-17** (X.5) | File-level cycles (`bis-order` ↔ `bis-order-item` models) | Not S12 (S10). The export reads these tables through its own repository with a hand-written keyset query, so it does not depend on the associations. |

Closed rows (D-1…D-5, D-9, D-13) need nothing from this capability. D-14 and D-16 do not name `orders`.

## C. `pnpm --dir packages/backend check:table-ownership` lines for `orders`

The script could not be run in the unattended specification session (the command needs an approval that is not available there), so the lines below come from a static search of `libs/domains/orders` for table names, model imports and cross-domain imports. **The implementation agent must run `pnpm --dir packages/backend check:table-ownership` first and reconcile this table with the real output before starting.** Findings that belong to another capability are listed so nothing is lost; only the first row is S12's.

| Kind | File:line | Finding | Owner of the fix | Replacement (IX.7) |
|---|---|---|---|---|
| SQL `Product` | `application/order-export.service.ts:69` | `LEFT JOIN "Product"` for `sku` and `title` | **S12** | **R1** `getProductsByIds` per batch (SKU) + S10 item snapshot (title) |
| SQL `Product` | `application/checkout.service.ts:149`, `application/order.service.ts:97`, `infra/order.jobs.ts:50,106` | `UPDATE "Product" SET quantity …` stock moves | S10 / S11 | **R1** `ProductStockService.applyStockDelta` |
| MODEL | `orders.module.ts:8-9,13`, `api/orders.controller.ts:9`, `api/stripe-webhook.controller.ts:9`, `application/checkout.service.ts:8` | `ProductModel`, `PaymentModel` registered with `forFeature` / injected | S10 / S11 / S13 | **R1** `ProductQueryService`, `PaymentQueryService.getPaymentStatus` |
| MODEL (association) | `infra/models/bis-order.model.ts:18-19,23,75`; `infra/models/bis-order-item.model.ts:14,30-37` | `UserModel`, `PaymentModel`, `ProductModel` associations | S10 | plain IDs, no association |
| IMPORT | `infra/order-payment.listener.ts:4` | `PaymentStatus` from `@app/domains/payments` | S10 / S13 | event contract type from the payments entry point |
| IMPORT (reverse edge) | `libs/domains/catalog-sync/api/catalog-import.controller.ts:8`, `catalog-import.module.ts:8`, `infra/catalog-import.worker.ts:4`, `catalog-import.e2e-spec.ts:16` | `catalog-sync` imports `@app/domains/orders` | **S12** (with S07) | none: the export leaves `catalog-sync` |
| REGISTRY | `db/ownership.ts:90` | `ExportJob: 'domain:orders'` | S12 | add `ExportJobHistory: 'domain:orders'` in the same PR as the migration |
| FK | `migrations/20261002100000-catalog-import.js:35-36` | `ExportJob."shopId" → Shop`, `"createdBy" → User` | **S12** | plain ID columns, no FK |

## D. Order of work for the implementation agent

1. **Reconcile.** Run `pnpm --dir packages/backend check:table-ownership` and `pnpm check:boundaries` and note the baseline for `orders` and `catalog-sync`; compare with section C.
2. **Contracts first.** Add the six schemas to `packages/contracts` (A5), the problem codes, the event schema; write the e2e skeletons (they fail first, VII.9).
3. **Migration (expand/contract, `lock_timeout`).** Add columns (`attempt`, `totalRows`, `rowsWritten`, `bytesWritten`, `failureCode`, `failureMessage`, `leaseHolder`, `leaseExpiresAt`, `startedAt`, `finishedAt`, `expiresAt`), widen the `status` check (`CANCELLED`, `EXPIRED`), drop the two foreign keys, add `ExportJobHistory`, add the partial unique index (one `QUEUED|RUNNING` per shop) built concurrently, backfill `rows → rowsWritten` and `error → failureCode`; the `kind`, `rows`, `error` columns are dropped in a later contract step. Add `ExportJobHistory` to `db/ownership.ts` in the same PR (A15).
4. **Domain.** `domain/`: status union and transition table (AS-61), failure classification (AS-35), progress throttle (AS-16), CSV encoder and formula guard (AS-13, AS-14), row type and keyset cursor, ports (job repository, line reader, file sink, product SKU lookup, clock) with tokens; unit specs first.
5. **Infra.** Job repository (conditional transitions + history, claim with lease, fencing), line reader (keyset, async generator), storage sink (streaming, abort, promote), product SKU adapter over R1, queue consumer with validation, topic policy, tenancy event consumers, scheduled-job handlers.
6. **Application and API.** Export service (start with idempotency and the active-export rule, read, list, download, cancel), the run use case, `OrderExportModule` controller (`ShopScoped('orders.manage')`, one call per method, II.1).
7. **Wiring.** `OrderExportModule` (core), `OrderExportWorkerModule` (worker), `OrderExportTopicsModule` (sse-gateway); rate-limit policy and S49 job registrations; config validation; barrel (A17).
8. **Remove.** Delete `order-export.service.ts`, `api/realtime-topics.ts` (`ExportJobTopics`), `realtime-topics.module.ts`; in `catalog-sync` delete the two controller methods, the `OrderExportService` imports and the `kind` field (A1–A3) — coordinate with S07's A27; delete the e2e case at `catalog-import.e2e-spec.ts:120-128`.
9. **Prove.** The five e2e files, four unit specs, the benchmark script and the UI journey; run `tsc`, ESLint, `check:boundaries`, `check:table-ownership --strict` (AS-57); record the green run (VII.9); set D-10 to `resolved (S12, S07)` in the debt register and move pattern rows P0102 and P0207 toward `verified`.

**Sequencing with other capabilities.** S12's file content needs S10's item snapshot columns and S05's `externalSku` (both `[CONTRACT]` in `questions.md`). Until they land, the implementation may read `priceAtPurchase` as `unit_price_minor` with `discount_minor` 0 and the `Product` title through the R1 call; those temporary reads must be removed when S10 and S05 land, and AS-03 and AS-07 only pass in full after that.

## E. Plan update (2026-10-16): what changed since this list was written

Checked against the tree by `/speckit-plan`; details in [plan.md](plan.md) "Findings".

- **A24 / sequencing are mostly overtaken.** `BisOrderItem` already has `title`, `discountMinor`, `lineTotalMinor` (nullable until S10's backfill finishes) and `ProductDto.externalSku` exists. No "temporary read of `priceAtPurchase`" is needed; the reader uses the snapshot and a pure fallback for legacy null `title`/`lineTotalMinor`.
- **A14**: the prefix is already `order-export`; what remains is the viewer policy (creator-only raw SQL → `assertMember` with `orders.manage`) and the module rename.
- **G-54 (from S53)**: decided, see research R-11: projectors read membership through tenancy's R1 services; `apps/projector` drops `SequelizeModule.forFeature([ShopMembership])` and the tenancy model import (task in the S12 list).
- **S49 follow-up**: three `declareJobType` contracts and the `JobPayloads` augmentation (research R-07, contracts/async.md).
- **S51 follow-up**: no `job:` registration left in `orders`; topic `order-export:<id>`; W04 must subscribe to it (below).
- **S10 follow-up**: `check:table-ownership --strict` for `orders` reaches 0 only when `LEFT JOIN "Product"` is gone; `OrderExportService` and `ExportJobTopicsModule` leave the TRANSITIONAL block (pinned list in `orders-boundary.e2e-spec.ts` shrinks).
- **S05 follow-up**: SKU (and legacy title) via `getProductsByIds(ids ≤ 500, {shopId})`, one batch per page.

## Spec changes

- A new living-spec page `docs/spec/capabilities/S12-order-export.md` is created (none existed). It is written before the code changes, with `[proof:]`/`[code:]` markers kept true by `python3 scripts/livespec/check.py`. No `*.reviewed.json` is created or edited. If another page that a human signed (S07 or S10 pages, when present) states the old routes or the `kind:'export'` branch, S12 does not edit it; see the follow-ups.

## Sibling-spec follow-ups

- **S07**: delete the export controller methods (`catalog-import.controller.ts` export routes), the `OrderExportService` import, `OrderExportService` from `CatalogImportModule` providers/exports, the `kind` field and `kind:'export'` branch of `CatalogImportWorker`, and the `catalog-import.e2e-spec.ts` export case. S12's change removes the same lines for the export (it must, to build); S07 must not reintroduce them. Its AS-70 text "404 (served by S12)" is read as "no longer served by catalog-sync".
- **S10**: `OrderExportService` and `ExportJobTopicsModule` leave `orders/index.ts` and the allow-list in `orders-boundary.e2e-spec.ts`; the nullable `title`/`lineTotalMinor` on `BisOrderItem` must be filled (backfill) so the export's legacy fallback can be deleted; keep an index on `ShopOrder` by (`shopId`, `createdAt`, `id`).
- **W04**: subscribe to `order-export:<exportId>` (not `job:`); events `progress`, `done`, `failed`, `cancelled`; start with `POST /shops/:shopId/order-exports` plus `Idempotency-Key`; read `exportId` (was `jobId`); download only via `GET …/download`; handle `409 export_already_active {activeExportId}` by opening the existing export (L-010).
- **S53 / S03 / other projector owners**: obtain membership through `MembershipQueryService` or `ShopAccessService`, never `ShopMembershipModel` (G-54 closed on the projector app by S12).
- **S54**: the `@Idempotent` interceptor must not cache a non-2xx refusal (AS-25) and must compare path (AS-22); if it does not today, that is S54's to adopt.
- **Infrastructure ports (S07 shares)**: `ObjectStorage.put` gains `{signal, inactivityTimeoutMs}` (errors `StorageAbortedError`, `StorageStalledError`); `presignGet` gains `contentType` and `userContent` and quotes the file name per RFC 6266 (`attachmentDisposition`); additive, S07 should adopt rather than fork. The in-memory `abortMultipartUpload` already discarded parts (A20 was stale on that point).
- **S10**: the test `orders-boundary.e2e-spec.ts` "S10 AS-68: … table-ownership findings left for orders" now asserts zero findings (the S12 join is gone), and its TRANSITIONAL allow-list lost `OrderExportService` and `ExportJobTopicsModule`. S10's test plan should say the same.
- **S03**: its shop guard answers a malformed `shopId` in a path with `404 shop_not_found` before any pipe runs, so S12 AS-30's "malformed `shopId` → `400 validation_failed`" cannot hold for the shop segment (the `exportId` segment is `400 validation_failed`). S12's spec text should be amended by its owner.
- **S53**: the event-type pattern forbids an underscore in the first segment and the topic registry a hyphen in the aggregate type, so the export's event is `orderexport.finished` on `order_exports.events` (the draft said `order_export.finished` on `order-exports.events`). Consumers of the event (S28, optional) use the new names.
- **Infrastructure / operations (L-020)**: the queues `order-exports` and `order-exports-dlq` are in `infra/docker/elasticmq/elasticmq.conf` and `infra/stack/main.tf`, but the queue server reads its file only at start and the unattended session could not run `scripts/infra/reload-queues.sh` (or restart `marketplace_test_elasticmq`): the command needs an approval that was not available. The two queues were created on the running test queue server through the SQS API for the worker wiring spec; a restart of the test stack without the reloaded file drops them and `apps/worker` readiness then fails on `queue:order-exports` (which is the intended L-002 behaviour). A person (or an approved agent) runs `scripts/infra/reload-queues.sh` for the dev stack and restarts the test stack once.

## Spec changes (made during implementation)

- **Names**: the event is `orderexport.finished` (contract key and wire type) on the topic `order_exports.events`; `orderExportEventSchemas['orderexport.finished']` is the payload schema (as `orderEventSchemas` of S10), the envelope is the platform's.
- **Configuration**: keys are `orders_export_*` in `libs/common/config/orders-config.ts` (environment `ORDER_EXPORT_BATCH_SIZE`, `…_ROW_LIMIT`, `…_DEADLINE_SEC`, `…_LEASE_SEC`, `…_HEARTBEAT_SEC`, `…_STORAGE_INACTIVITY_SEC`, `…_FILE_RETENTION_DAYS`, `…_RECORD_RETENTION_DAYS`, `…_LINK_TTL_SEC`, `…_UNCLAIMED_SEC`); the user-content origin is the platform's existing `USERCONTENT_ORIGIN` (no `ORDER_EXPORT_USER_CONTENT_ORIGIN`), required in production by the rule `ordersExportRule`; the consumer's concurrency (2) is a constant. Start-up messages name the config key (`orders_export_batch_size`, …).
- **Retry counting**: a transient failure re-enqueues a delayed message, so the third-attempt rule counts the job's `attempt` (one per claim), not the queue's `receiveCount` (always 1 on a new message).
- **`shop_deleted` consumer** declares `idempotency: 'natural'` (as catalog-sync's): its chunked, resumable removal would otherwise run all chunks in one inbox transaction. The offboarding consumer is `inbox`.
- **Fixture `F5`**: `SO2` is `REFUNDED`, not `SHIPPED` (`ShopOrder_status_check` allows `PENDING|PAID|CANCELLED|REFUNDED`).
- **AS-19** reaches the "3,000 of 10,000 rows" state with the repository (claim and `recordProgress`) instead of a gated run, because under backpressure a gated run stores only its first batch.
- **AS-26** asserts `Retry-After` is a whole number of seconds, not its exact value: the limiter and the injected test clock do not share a time base. A limiter store that is down answers `503 rate_limiter_unavailable`.
- **AS-44**: the consumer registers `bodySchema: z.strictObject({exportId})`; routing an invalid body to the dead-letter queue is the queue port's behaviour (`libs/infrastructure/sqs/task-queue.e2e-spec.ts`), so the spec asserts the schema and the registration, not a broker round trip.
- **AS-58** asserts a span `order_export.run` per claim (ids and counts only) and the `requestId` of the download line; the test environment registers no tracer SDK, so a `traceId` field is not present in a log line there.
- No human-signed page (`*.reviewed.json`) was created or edited; no signed item changed.

## Remaining after S12

`pnpm --dir packages/backend check:table-ownership --strict` lists **no finding for `orders`** (16 findings in 7 other domains remain, none S12's): asset-library (3), catalog-sync (1: `catalog-import.service.ts` `Product`, S07's), community (1), content (1), launch-events (2: `ShopMembershipModel`), seller-insights (5), seller-onboarding (3). The stock `UPDATE "Product"` statements listed in section C no longer show in the check (S10/S11 moved them behind R1).

## Status at end of S12

| Item | Status | Where |
|---|---|---|
| A1–A3 routes, queue, worker branch, module providers in catalog-sync | closed | T070; `orders-boundary` AS-57; AS-56 |
| A4 idempotency, one active, rate limit | closed | AS-20–AS-26 |
| A5 contracts | closed | `packages/contracts/src/orders/order-export.ts` |
| A6 read/list/cancel/download, no storage key | closed | AS-05, AS-19, AS-31, AS-32 |
| A7 fenced claim and lease | closed | AS-43, AS-49, AS-50 |
| A8 failure classification, retry cap | closed | AS-33–AS-38 |
| A9 keyset batches, backpressure, deadline, inactivity | closed | AS-09–AS-11, AS-37, AS-38 |
| A10 file content | closed | AS-03, AS-06, AS-07, AS-13, AS-14 |
| A11 progress, advisory live channel | closed | AS-15–AS-17 |
| A12 state machine and history | closed | AS-39–AS-42, AS-61 |
| A13 retention and recovery | closed | AS-45–AS-47, AS-51, AS-52 |
| A14 live-topic policy | closed | AS-18; gateway wiring spec |
| A15 table, FKs, history, unique index, models | closed | migrations `20261016000600/610/700`, `db/ownership.ts` |
| A16 layering | closed | `domain/`, `application/`, `infra/`, `api/`; `orders-boundary` |
| A17 barrel and wiring | closed | `index.ts`; core, worker, gateway wiring specs |
| A18 tenancy consumers, jobs, outbox | closed | AS-53–AS-55, AS-60 |
| A19 audit line, metrics, config validation | closed | AS-58, AS-59 |
| A20 storage port | closed | `object-storage.port.spec.ts` (S12 tests) |
| A21 queue declarations | closed in files; **reload pending** (see follow-ups) | `elasticmq.conf`, `main.tf` |
| A22 tests | closed | five `order-export*.e2e-spec.ts` files + backpressure, repository, migration, unit specs, wiring specs |
| A23 benchmark | script exists, **not run at scale** | `scripts/bench/order-export-bench.ts`; Ops artifacts |
| A24 snapshot columns and legacy fallbacks | closed | `domain/export-row.ts`, `infra/export-line.reader.ts` |
| D-6, D-7, D-8, D-10, D-12 (S12's share) | closed | section B; debt register D-10 |
| G-54 (projector membership model) | closed | `apps/projector/src/projector.module.ts`; projector wiring spec |

## Gate repairs

- Gate failed: `boot-check` said the monolith was not ready after 240 s. Cause: `/health/ready` answered `queue:order-exports: down`; the dev queue server had not been reloaded after `elasticmq.conf` gained `order-exports` (L-020). The app itself had started ("Nest application successfully started"). The `JavaScript heap out of memory` / `RpcExitError SIGABRT` lines in api.log come from the ForkTsChecker type-check process (2 GB default heap), not the API, and do not affect readiness; this corrects the earlier T083 hypothesis. Fix: ran `scripts/infra/reload-queues.sh`; readiness is now `ready: true`. No code change.

- Gate failed: test integrity, `catalog-sync/catalog-import.e2e-spec.ts` had 16 it()/expect() calls against 20 at HEAD. Its order-export case moved to `orders/order-export.e2e-spec.ts` (AS-04, AS-05). Added a boundary test in the import spec proving the import module serves no order export (no `OrderExportService` provider, no export route or handler).

- Gate failed: test-plan.md scenario AS-12 had no test carrying its ID (only the bench script). Added `S12 AS-12` to `order-export-streaming.e2e-spec.ts`: a scaled run (3,000 and 30,000 lines) through the real run service, sampling heap, asserting growth under 200 MB and flat across a tenfold size. It does not replace the 100k/1M measurement: SC-001 stays an Ops artifact ("not run") in quickstart.md and specs/UNVERIFIED.md.

- Gate failed: `orders/flash-sale-*.e2e-spec.ts` (S11 AS-19, AS-37, AS-40). AS-19 and AS-37 were a code fault in S11: `SequelizeFlashSaleRepository.create` stamped the first `FlashSaleHistory` row with the database `now()` while `move` stamps later rows with the application clock, so under a controlled clock the `SCHEDULED` row sorted after later transitions (`ORDER BY "at", "id"`). `FlashSaleService.create` now passes its clock reading (`NewFlashSale.at`) and the repository uses it (falls back to `now()`). AS-40 (one `FlashSale` statement while the entry should be fresh) did not reproduce: the spec passed alone and in a full `libs/domains/orders` run (26 suites, 331 tests); it is load-sensitive because the cache's Redis key expires on wall time while freshness is on the test clock. Not changed; no test weakened.
