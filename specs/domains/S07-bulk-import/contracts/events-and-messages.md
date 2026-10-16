# Events, messages, jobs, policies, config: S07

## Queue `catalog-imports` (standard queue; DLQ `catalog-imports-dlq`, `maxReceiveCount = 3`; both already in `elasticmq.conf` and `infra/stack/main.tf`)

Message `{ importId: uuid }`, strict. Consumer uses `bodySchema` (invalid ⇒ DLQ at once, AS-41), `concurrency 4`, `visibilityTimeoutSec 300` with heartbeat. Only `delaySeconds` is ever passed to `enqueue` (L-001). Producers: `complete` (after commit), recovery job, busy-shop hand-back (delay 60 s ±20%). The `kind` field is gone.

Consumer outcomes: finished job ⇒ ack; unknown job ⇒ throw (retry, then DLQ); lease held / shop busy / earlier job pending ⇒ hand back + ack; retryable failure ⇒ throw (`receiveCount ≥ 3` ⇒ record terminal failure first); terminal failure ⇒ record + ack.

## Outbox event (topic `catalog-sync.events`, key `importId`)

`catalog_sync.import_finished` v1, envelope `{eventId, type, version:1, occurredAt, aggregateId}`; payload `{importId, shopId, createdBy, status:'DONE'|'FAILED'|'CANCELLED'|'EXPIRED', failureCode:string|null, rowsProcessed, rowsCreated, rowsUpdated, rowsUnchanged, rowsFailed, startedAt:string|null, finishedAt:string}`. Schema `importEventSchemas` in contracts. Written with `outbox.append` in the final transition's transaction. The topic is shared with S08 (five integration events); S07 registers the new type in the same event definitions module style as `application/events/integration-events.ts` and does **not** define a second topic. Consumers S28/S43/S40 optional.

## Consumed events (projector; `CatalogImportProjectorModule`)

| Consumer name | Topic | Event | Idempotency | Effect |
|---|---|---|---|---|
| `catalog-sync-import-offboarding` | `tenancy.events` | `tenancy.shop_offboarding_started` (ignores `…_cancelled`) | `inbox` | cancel non-final jobs of the shop |
| `catalog-sync-import-shop-deleted` | `tenancy.events` | `tenancy.shop_deleted` | `natural` | delete objects then history then rows |

Payloads validated with the S03 schemas; invalid ⇒ `PermanentError` ⇒ DLQ with no change. Consumer names are distinct from S08's (`catalog-sync-shop-offboarding`, `catalog-sync-shop-deleted`, offline-sync ones).

## Realtime (S51)

Topic `import:{importId}`; policy: current member with `products.read` via `ShopAccessService.assertMember` (async). Events: `progress {processed, failed, bytesProcessed, sizeBytes}` (`replay:false`, after the checkpoint commit), `done {rowsProcessed, rowsFailed}`, `failed {code}`, `cancelled {}` (`replay:true`, after the terminal commit). Schema `importProgressEventSchema` (discriminated by event type). `ImportJobTopicsModule` imports `TenancyModule` (loaded in `apps/sse-gateway`). W04 must subscribe to `import:<importId>` and stop using `jobId`.

## Scheduled jobs (S49; `declareJobType` + `JobPayloads` augmentation; payload `{}`)

| Name | Cron (6-field) | Effect |
|---|---|---|
| `catalog-sync.recover-stalled-imports` | `0 * * * * *` | re-enqueue `UPLOADED` older than 2 min without live lease and `SCANNING|PROCESSING` with expired lease; at most once per 2-minute window via `lastEnqueuedAt` |
| `catalog-sync.expire-pending-imports` | `0 */5 * * * *` | `PENDING_UPLOAD` older than 24 h ⇒ `EXPIRED`, abort upload, finished event |
| `catalog-sync.purge-imports` | `0 20 3 * * *` | report objects after 30 days, records after 90, ≤ 500 per run, never non-final |

`@JobHandler(name, {concurrency: 1, fleetConcurrency: 1})`; handlers idempotent; `InvalidScheduleError` at bootstrap fails the worker start.

## Rate-limit policy (S50; `catalogSyncRatePolicies`)

`catalog-sync.import-start.shop`: `slidingWindow`, limit 10, `windowMs 3_600_000`, key `shop`, `failMode: 'closed'`. Called in code (`limiter.check`) by the start service. Removed: `imports.concurrent`.

## Configuration (validated at startup, S54)

Reused: `CLAMAV_HOST` (mandatory in production), `MEDIA_SCANNER_DISABLED` (non-production only), `USERCONTENT_ORIGIN`. New, optional with defaults in `domain/import-limits.ts`: `IMPORT_ERROR_CAP` (100000), `IMPORT_BUSY_DELAY_SECONDS` (60), `IMPORT_SCAN_INACTIVITY_MS` (60000), `IMPORT_SCAN_TOTAL_MS` (1800000). Numbers that are fixed by contract (batch 500, part 64 MiB, 5 GiB, 1 MiB record, lease 5 min/60 s, caps 3/10, retention 30/90 days, report link 10 min) are constants with a bounds check.
