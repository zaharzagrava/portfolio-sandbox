---
id: S09
title: Offline-first inventory sync for store devices (operation idempotency, stock deltas, per-field last-writer-wins, change feed, conflicts)
kind: capability
status: draft
depends_on: [S01, S03, S05, S49, S50, S53]
concepts: [problem-json-errors, rate-limit-policy, outbox-task-queue]
models: []
scope:
  - packages/backend/libs/domains/catalog-sync/sync.module.ts
  - packages/backend/libs/domains/catalog-sync/api/sync*.ts
  - packages/backend/libs/domains/catalog-sync/application/sync-*.ts
  - packages/backend/libs/domains/catalog-sync/domain/sync-*.ts
  - packages/backend/libs/domains/catalog-sync/infra/sync-*.ts
  - packages/contracts/src/catalog-sync/offline-sync.ts
---
# S09 - Offline-first inventory sync for store devices
## Purpose
Shop staff count stock, receive deliveries and sell in person with poor connectivity. Their device queues what they did as operations, pushes them later, and pulls what changed on the server. Nothing is applied twice, nothing is lost, devices converge, and the few cases a machine cannot settle are shown to a person.

## Today
Offline sync is built as specified here. A push claims each operation in a committed row, calls the catalog with a deterministic operation id and then records the result; stock changes only through the catalog's stock command, fields only through its update command, and the change feed is built from the catalog's product events by a projector.
- The end-to-end files are `sync-push`, `sync-fields`, `sync-pull`, `sync-feed-consumer`, `sync-conflicts`, `sync-access` and `sync-lifecycle`, all named `*.e2e-spec.ts` in `packages/backend/libs/domains/catalog-sync`; the pure rules are proved by unit specs in its `domain` folder, and the migrations by `test/expand-migration.e2e-spec.ts`.
- The request, response and event schemas live in `packages/contracts/src/catalog-sync/offline-sync.ts`.
- The event is registered as `catalogsync.offline_conflict_opened` on topic `catalogsync.events`, like the integration events, because the event platform allows no `-` in a topic and no `_` in the first segment of a type.

## Entry points
- `POST /shops/:shopId/sync/push` (permission `products.write`, header `X-Device-Id`) and `GET /shops/:shopId/sync/pull` (permission `products.read`, header `X-Device-Id`).
- `GET /shops/:shopId/sync/conflicts` and `POST /shops/:shopId/sync/conflicts/:opId/dismiss`.
- Scheduled jobs `catalog-sync.redrive-stale-ops`, `catalog-sync.compact-change-log` and `catalog-sync.purge-sync-operations`, and the internal job `catalog-sync.backfill-change-log`.
- Event `catalogsync.offline_conflict_opened` on topic `catalogsync.events`; consumers of `products.events` and `tenancy.shop_deleted`.

## Rules
- **S09.R-01** An operation MUST take effect at most once per shop and operation id: a replay MUST return the original outcome with `replayed: true`, the same id with different content MUST be `rejected` `op_id_reused`, and the same id in another shop MUST be independent and not observable. [proof: S09 AS-02, S09 AS-03, S09 AS-04, S09 AS-05] [code: packages/backend/libs/domains/catalog-sync/application/sync-push.service.ts#SyncPushService] [code: packages/backend/libs/domains/catalog-sync/domain/sync-ops.ts#fingerprint]
- **S09.R-02** Each operation MUST be claimed in a committed row before the catalog is called, and its result MUST be recorded afterwards. A claim younger than 60 seconds MUST be answered `retry` `in_flight`, an older one MAY be taken over by exactly one request, and a scheduled job MUST complete claims older than 5 minutes once each. [proof: S09 AS-13, S09 AS-14] [code: packages/backend/libs/domains/catalog-sync/infra/repositories/sequelize-sync-operation.repository.ts#SequelizeSyncOperationRepository] [code: packages/backend/libs/domains/catalog-sync/application/sync-lifecycle.service.ts#SyncLifecycleService]
- **S09.R-03** Stock MUST change only through the catalog stock command with the deterministic operation id `sync:<shopId>:<opId>`, and this capability MUST NOT write the product table or publish product events. Stock MUST never go below zero: the applicable part is applied and the shortfall is an `oversold` conflict, and a result over the quantity limit is a `quantity_limit` conflict. [proof: S09 AS-01, S09 AS-08, S09 AS-09, S09 AS-10, S09 AS-52] [code: packages/backend/libs/domains/catalog-sync/infra/sync-catalog.adapter.ts#SyncCatalogServicesGateway] [code: packages/backend/libs/domains/catalog-sync/domain/sync-outcome.ts#clampDelta]
- **S09.R-04** A stock count MUST be applied as `counted - base`, a zero delta MUST NOT reach the catalog, and stock operations MUST NOT depend on the plausibility of their clock. [proof: S09 AS-06, S09 AS-07, S09 AS-19] [code: packages/backend/libs/domains/catalog-sync/domain/sync-merge.ts#stockDeltaOf]
- **S09.R-05** For each of `title`, `description` and `priceMinor` the edit with the greater hybrid logical clock MUST win, ties MUST be broken by the node id, and an equal clock MUST lose. Decisions for one product MUST be serialized, a field clock MUST advance only after the catalog accepted the value, and a stale edit MUST be `merged` with its fields listed as superseded and cause no catalog write. [proof: S09 AS-15, S09 AS-16, S09 AS-17, S09 AS-18] [code: packages/backend/libs/domains/catalog-sync/domain/sync-merge.ts#decideFields] [code: packages/backend/libs/domains/catalog-sync/infra/pg-advisory-product-edit-lock.ts#PgAdvisoryProductEditLock]
- **S09.R-06** A clock MUST be valid and its node MUST equal `X-Device-Id`, a field edit more than 60 seconds ahead of the server MUST be `clock_implausible`, and an operation more than 30 days old MUST be `op_expired`. Every push response MUST carry a `serverHlc` greater than all accepted clocks. [proof: S09 AS-19, S09 AS-20, S09 AS-21, S09 AS-23] [code: packages/backend/libs/domains/catalog-sync/domain/hlc.ts#plausible] [code: packages/backend/libs/domains/catalog-sync/application/sync-clock.service.ts#SyncClockService]
- **S09.R-07** A malformed operation MUST be rejected alone with its position and the others applied, and only envelope errors fail the request (`400`, `413`). The push MUST stop starting operations after its 20-second budget and report the rest `retry` `deadline_exceeded`, and a store failure MUST be `503` `sync_unavailable` with a generic detail and earlier operations durable. [proof: S09 AS-22, S09 AS-33, S09 AS-34, S09 AS-35, S09 AS-37, S09 AS-38] [code: packages/backend/libs/domains/catalog-sync/api/sync.controller.ts#SyncController]
- **S09.R-08** The change feed MUST be built from the catalog's product events, one entry per accepted event with a gap-free per-shop `seq`. Duplicates and older versions MUST be ignored, and archive, restore and deletion MUST appear as entries (a tombstone for deletion). [proof: S09 AS-26, S09 AS-27, S09 AS-28, S09 AS-29] [code: packages/backend/libs/domains/catalog-sync/infra/sync-feed.consumer.ts#SyncFeedConsumer] [code: packages/backend/libs/domains/catalog-sync/infra/repositories/sequelize-sync-feed.repository.ts#SequelizeSyncFeedRepository]
- **S09.R-09** A pull MUST return entries in increasing `seq` with `limit` 1 to 500 (default 200), and the cursor MUST be opaque and bound to the shop and the feed generation. A malformed or foreign cursor or a bad limit MUST be `400`, a cursor of an older generation, ahead of the head or older than the compaction horizon MUST be `410` `resync_required`, and a pull without a cursor MUST return the current state of the shop. [proof: S09 AS-24, S09 AS-25, S09 AS-30, S09 AS-31, S09 AS-32] [code: packages/backend/libs/domains/catalog-sync/application/sync-pull.service.ts#SyncPullService] [code: packages/backend/libs/domains/catalog-sync/domain/sync-cursor.ts#decodeSyncCursor]
- **S09.R-10** A conflict result MUST create one open conflict and one `catalogsync.offline_conflict_opened` outbox row in the transaction that records the result. Members with `products.read` MUST list conflicts newest first with a keyset cursor, and members with `products.write` MUST dismiss an open one exactly once (`409` `conflict_not_open` otherwise). [proof: S09 AS-08, S09 AS-39, S09 AS-40, S09 AS-41] [code: packages/backend/libs/domains/catalog-sync/application/sync-conflict.service.ts#SyncConflictService] [code: packages/backend/libs/domains/catalog-sync/api/sync-conflicts.controller.ts#SyncConflictsController]
- **S09.R-11** All routes MUST require authentication and the named permission, answer non-members and other shops' resources with `404`, follow the shop-status gate, and include the shop in every lookup. Shop, user and device MUST come only from path, session and `X-Device-Id`, and push and pull MUST be rate limited per device (`429` with `Retry-After`) with a body cap of 2 MiB. [proof: S09 AS-35, S09 AS-36, S09 AS-42, S09 AS-43, S09 AS-44, S09 AS-45, S09 AS-46, S09 AS-47] [code: packages/backend/libs/domains/catalog-sync/api/sync.controller.ts#SyncController] [code: packages/backend/libs/domains/catalog-sync/api/device-id.pipe.ts#DeviceId]
- **S09.R-12** On `tenancy.shop_deleted` all sync data of the shop MUST be removed and on `catalog.product_deleted` the product's field clocks MUST be removed, both idempotently. Operation records MUST be purged after 90 days except those with an open conflict, and superseded feed entries older than 30 days MUST be compacted. [proof: S09 AS-48, S09 AS-49, S09 AS-50, S09 AS-55] [code: packages/backend/libs/domains/catalog-sync/application/sync-lifecycle.service.ts#SyncLifecycleService] [code: packages/backend/libs/domains/catalog-sync/infra/sync-lifecycle.consumers.ts#OfflineShopDeletedConsumer]
- **S09.R-13** The capability MUST touch only tables it owns, reach products only through the catalog's exported services and events, have no foreign key, view or trigger on a catalog table, and export only `OfflineSyncModule`, `OfflineSyncWorkerModule` and `OfflineSyncProjectorModule` for it. [proof: S09 AS-53] [code: packages/backend/libs/domains/catalog-sync/sync.module.ts#OfflineSyncModule]
- **S09.R-14** Logs MUST carry request, shop, device and per-operation fields without product content, and the metrics `catalog_sync_offline_ops_total`, `catalog_sync_offline_push_duration_seconds`, `catalog_sync_offline_feed_lag_seconds`, `catalog_sync_offline_conflicts_open` and `catalog_sync_offline_ops_in_flight` MUST exist. [proof: S09 AS-51] [code: packages/backend/libs/domains/catalog-sync/application/offline-sync-metrics.ts#logOperation]

## Behaviors
- **S09.B-01** Given two offline devices that received three units and sold one, when they push in either order, then the stock is the start plus two and each operation is recorded once however often it is resent. [proof: S09 AS-01, S09 AS-02]
- **S09.B-02** Given two devices that edit the title and the price of one product, when both push, then both edits survive and a stale title edit changes nothing. [proof: S09 AS-15, S09 AS-16]
- **S09.B-03** Given two devices that sell the last unit, when both push, then one is applied, the other is a conflict, the stock is zero and staff can list and dismiss the conflict. [proof: S09 AS-08, S09 AS-40]
- **S09.B-04** Given a batch with one malformed operation, when it is pushed, then the others are applied and the broken one is reported by position. [proof: S09 AS-33]
- **S09.B-05** Given a device whose cursor is older than the feed horizon, when it pulls, then it is told to start over and a pull without a cursor returns the current state. [proof: S09 AS-32]

## Lifecycles
An operation is `pending` while claimed and then `applied`, `merged`, `conflict` or `rejected`; terminal rows never change. A conflict is `open` or `dismissed`. A feed entry is a product state with a version; a deleted product leaves a tombstone.

## Owns
- The tables `SyncOperation`, `SyncConflict`, `ShopChangeLog`, `ShopSyncState` and `ProductFieldClock`.
- The three scheduled jobs, the internal backfill job, the event `catalogsync.offline_conflict_opened` and the `catalog_sync_offline_*` metrics.
- The rate-limit policies `catalog-sync.sync-push.device`, `catalog-sync.sync-pull.device` and `catalog-sync.conflict-write.shop`.

## Decisions
- Stock merges as commutative deltas; text and price fields merge by last writer per field by hybrid logical clock.
- The claim is committed before the catalog is called and the catalog call carries a deterministic id, so a repeat can never apply twice.
- The feed is a read model of the catalog's events, not a trigger on its table.
- A shop's feed is built from the catalog the first time it is read; later changes arrive as events.

## Known gaps
- The latency success criterion has no automated proof and is listed in `specs/UNVERIFIED.md`.
