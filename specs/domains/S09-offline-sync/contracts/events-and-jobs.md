# Events, consumers and jobs

## Produced

`catalog_sync.offline_conflict_opened` v1 on topic `catalog-sync.events` (shared with S07/S08; aggregate `CATALOG_SYNC_AGGREGATE`), key `opId`, envelope `{eventId, type, version: 1, occurredAt, aggregateId}`, payload `{opId, shopId, deviceId, productId, kind: 'oversold'|'quantity_limit', requested, applied, shortfall, quantityAfter}`. Written with `outbox.append` in the transaction that records the conflicting result and its `SyncConflict` row; a re-recorded result creates neither (unique `(shopId, opId)`). Schema in `syncEventSchemas` (contracts). Optional consumers: S28, S43, S40, W04.

This capability publishes **no** `products.events` (A4).

## Consumed (projector module, `OfflineSyncProjectorModule`)

| Consumer name | Event | Effect | Idempotency / failure |
|---|---|---|---|
| `catalog-sync-offline-feed` | `catalog.product_created\|updated\|archived\|restored\|deleted` (payload per `productEventSchemas` in contracts) | one feed entry (tombstone for `deleted`) under the `ShopSyncState` lock | natural: unique `(shopId, entityId, version)` + "newer version exists → ignore"; framework envelope check, zod, DLQ; missing `shopId`/`productVersion`, bad ID, unknown type → dead-letter, next event continues (AS-28) |
| `catalog-sync-offline-product-deleted` | `catalog.product_deleted` | delete `ProductFieldClock` of the product | delete is idempotent |
| `catalog-sync-offline-shop-deleted` | `tenancy.shop_deleted` v1 `{shopId}` | delete all of the shop's rows of the five tables, batches ≤1,000 | delete is idempotent |

Event definitions are re-declared as "consumed" the way `infra/product-events.consumer.ts` does (the producing domain owns the real definition). Consumer-group names differ from S08's, so both receive every event.

## Jobs (`OfflineSyncWorkerModule`, S49, single-run, leases)

| Job | Schedule | Work |
|---|---|---|
| `catalog-sync.redrive-stale-ops` | every minute | complete `pending` claims older than 5 min from stored `content` via the push path; conditional takeover so each finishes once, also with two instances |
| `catalog-sync.compact-change-log` | daily | per shop in batches: remove superseded entries older than 30 d, keep newest per product and tombstones <30 d, set `horizonSeq/horizonAt` |
| `catalog-sync.purge-sync-operations` | daily | delete operations older than 90 d except those with an open conflict, and their dismissed conflicts |
| `catalog-sync.backfill-change-log` (internal, not in Provides) | on demand | rebuild a shop's feed from `ProductCommandService.listByShop` with a new generation (R-07) |

Each name: `declareJobType({name, contract: z.object({…}).strict()})` next to the `declare module '@app/infrastructure/jobs/job-types'` augmentation of `JobPayloads` (S49 follow-up). `upsertSchedule` errors of type `InvalidScheduleError` are caught and reported at boot. `JobsService.cancel` is not called.

## Metrics and logs (FR-039)

Counters `catalog_sync_offline_ops_total{type,status}`, histogram `catalog_sync_offline_push_duration_seconds`, gauges `catalog_sync_offline_feed_lag_seconds`, `catalog_sync_offline_conflicts_open`, `catalog_sync_offline_ops_in_flight`. Log lines: `requestId`, `shopId`, `deviceId`; per operation `opId`, `type`, `status`, `code`, `durationMs`. Never titles, descriptions or bodies.
