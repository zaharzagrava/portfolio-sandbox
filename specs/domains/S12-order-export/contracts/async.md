# Asynchronous contracts: queue, live topic, event, jobs, consumers, config

## Queue `order-exports`
- Standard queue (not FIFO: no `groupId`/`dedupeId`, L-001). Dead-letter queue `order-exports-dlq`, `maxReceiveCount 3`. Declared in `infra/docker/elasticmq/elasticmq.conf` and `infra/stack/main.tf`; the worker's readiness fails while `queueExists('order-exports')` is false (L-002).
- Body `z.strictObject({ exportId: z.string().uuid() })`, enforced by `consume(..., { bodySchema })` (invalid → DLQ with no side effect, AS-44). The old `{kind:'export', jobId}` shape is invalid.
- Producer: after the creating transaction commits; retry re-enqueue with `delaySeconds` 60 ± 20 % (≤ 900); recovery re-enqueue of unclaimed `QUEUED`.
- Consumer: `concurrency` from config (default 2), visibility 5 min with heartbeat; messages for unknown or non-`QUEUED` exports are acknowledged (unknown → one warning without row data).

## Live topic `order-export:<exportId>` (S51)
| Event | Payload | Replay |
|---|---|---|
| `progress` | `{rowsWritten, totalRows, bytesWritten}` | no |
| `done` | `{rowsWritten, bytesWritten}` | yes |
| `failed` | `{code}` | yes |
| `cancelled` | `{}` | yes |

Viewer policy: signed-in user who is currently a member of the job's shop with `orders.manage` (`ShopAccessService.assertMember`); all refusals identical. Registered by `OrderExportTopicsModule` only (sse-gateway). No `job:` prefix is registered by orders. Publishing is advisory: never awaited on the success path inside a transaction, failures logged at most once a minute. `orderExportProgressEventSchema` = discriminated union on `type` over the four payloads above.

## Event `order_export.finished` v1 (outbox → topic `order-exports.events`, key `exportId`)
Envelope `{eventId, type, version: 1, occurredAt, aggregateId: exportId}`; payload `{exportId, shopId, createdBy, status: 'DONE'|'FAILED'|'CANCELLED', failureCode: string|null, rowsWritten, bytesWritten, attempt, startedAt: iso|null, finishedAt: iso}`. Exactly one per job, appended in the final-status transaction; none for retry, requeue, expiry, purge. Exposed as `orderExportEventSchemas` in `packages/contracts` and as a `defineEvent` in `application/events/`. Topic added to the events topic registry.

## Scheduled jobs (S49, single-run, leases)
| Type | Schedule | Payload | Effect |
|---|---|---|---|
| `orders.recover-stalled-exports` | every minute | `{}` | expired `RUNNING` → `QUEUED`+enqueue or `FAILED attempts_exhausted`; `QUEUED` > 2 min unclaimed → one enqueue |
| `orders.expire-exports` | every 15 min | `{}` | `DONE` older than 7 d: delete file, then `EXPIRED` |
| `orders.purge-exports` | daily | `{}` | finished rows older than 90 d with history (any leftover file first) |

Each declared with `declareJobType` + `JobPayloads` augmentation in `application/order-export.job-types.ts` (loaded by the barrel), upserted at boot; `InvalidScheduleError` is caught and logged as a start-up failure.

## Consumers (S53 `Projector`, `idempotency: 'inbox'`)
`order-export-shop-offboarding` handles `tenancy.shop_offboarding_started` (cancel active exports; `…_cancelled` ignored); `order-export-shop-deleted` handles `tenancy.shop_deleted` (cancel active, delete files, rows, history). Invalid payload or unknown version → `PermanentError` (dead letter).

## Rate-limit policy
`orders.export-start.shop`: 5 per hour, subject = shop, fail closed, added to `ordersRatePolicies`.

## Configuration (validated at start, AS-59)
`ORDER_EXPORT_BATCH_SIZE` 1000 (≥ 1), `ORDER_EXPORT_ROW_LIMIT` 20 000 000 (≥ 1), `ORDER_EXPORT_DEADLINE_SEC` 7200, `ORDER_EXPORT_LEASE_SEC` 300 (≥ 2 × heartbeat), `ORDER_EXPORT_HEARTBEAT_SEC` 60, `ORDER_EXPORT_STORAGE_INACTIVITY_SEC` 60, `ORDER_EXPORT_FILE_RETENTION_DAYS` 7 (> 0), `ORDER_EXPORT_RECORD_RETENTION_DAYS` 90 (> 0), `ORDER_EXPORT_LINK_TTL_SEC` 600, `ORDER_EXPORT_UNCLAIMED_SEC` 120, `ORDER_EXPORT_USER_CONTENT_ORIGIN` (required in production). Names are placeholders to be aligned with the S54 config toolkit's naming at implementation; the validation messages must name the key.
