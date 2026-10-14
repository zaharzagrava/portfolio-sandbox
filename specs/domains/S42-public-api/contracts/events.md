# Contract: S42 events, queues and jobs

Envelope for every event: `{eventId, type, version: 1, occurredAt, aggregateId}` (S53). Zod schemas in `packages/contracts/src/developer-platform/events.ts`. No event carries a key, a secret or a hash.

## Produced

| Event | Payload | aggregateId | Path | Consumers |
|---|---|---|---|---|
| `developer_platform.api_key_created` | `{keyId, shopId, prefix, livemode, scopes, actorId}` | `keyId` | outbox, same transaction as the insert | audit, S28 (optional) |
| `developer_platform.api_key_rotated` | `{keyId, shopId, prefix, livemode, scopes, actorId, successorId}` | `keyId` | outbox, same transaction as the conditional update | same |
| `developer_platform.api_key_revoked` | `{keyId, shopId, prefix, livemode, scopes, actorId?, reason: manual\|shop_deleted\|rotation_expired}` | `keyId` | outbox; exactly once, on the first transition | same |
| `developer_platform.api_version_pinned` | `{shopId, version, previousVersion, actorId}` | `shopId` | outbox | S43 (optional) |
| `api.request_logged` v1 | `{requestId, clientRequestId?, shopId, keyId, livemode, version, method, route, status, durationMs, deprecated, errorCode?, batchOps?, idempotentReplay}` | `shopId` | direct producer with bounded buffer (best effort, research R-07); `eventId` derived from `requestId`; additive change of the existing event, version stays 1 | this domain's projector and usage metering only |
| `usage.recorded` v1 | `{metric: "api.calls", quantity ≥ 1, ts}` | `shopId` | outbox, in the transaction that marks the bucket emitted; `eventId` = UUIDv5(`shopId\|api.calls\|<minute>\|<sequence>`) | S18 |

## Consumed

| Source | Event | Handler (group) | Dedupe | Invalid payload |
|---|---|---|---|---|
| `tenancy.events` | `tenancy.shop_deleted` `{shopId}` | `public-api-shop-lifecycle` | inbox by `eventId`; the conditional revoke is idempotent anyway | zod fails → DLQ, no effect |
| `tenancy.events` | `tenancy.shop_status_changed` `{shopId, from, to, reason?, shopVersion}` | same | newer `shopVersion` wins | DLQ |
| `api.request_logged` | — | `public-api-request-log` (projector → ClickHouse) | insert dedupe token = `requestId` | DLQ |
| `api.request_logged` | — | `public-api-usage-metering` | inbox by `eventId` | DLQ |

Consumer declarations use the S53 modes (`inbox` for the three with state, `versionGuard` for the status entry); duplicate-delivery and invalid-payload tests per consumer are in `developer-platform-consumers.e2e-spec.ts` (VII.4).

## Queue

| Queue | Type | Message | Consumer |
|---|---|---|---|
| `public-api-bulk-chunk` (+ `public-api-bulk-chunk-dlq`) | standard SQS, at-least-once; **no FIFO options** (L-001); defined in `infra/docker/elasticmq.conf` and `infra/stack/main.tf` (L-002) | `{jobId, shopId, index, items:[{operationId, productId, delta}]}`, zod-validated | `BulkChunkWorker` in `PublicApiWorkerModule`; readiness fails while the queue is missing |

## Jobs (S49, `declareJobType` with payload contract)

| Job | Schedule | Mode | Does |
|---|---|---|---|
| `public-api.flush-key-usage` | every minute | single run | drain the `lastUsedAt` write-behind atomically (restore on failure), monotonic update |
| `public-api.close-usage-minutes` | every minute | single run | emit `usage.recorded` for buckets older than the minute + 5 s (research R-08) |
| `public-api.purge-bulk-jobs` | daily | single run | delete jobs and chunks past `expiresAt`, batches of 500 |

## Metrics (S54 registry; closed label sets, no key/shop/client IDs)

`public_api_auth_failures_total{reason}`, `public_api_key_cache_degraded_total`, `public_api_deprecated_calls_total{route,version}`, `public_api_quota_degraded_total{reason}`, `public_api_request_records_dropped_total`, `public_api_batch_deadline_exceeded_total`, `public_api_bulk_chunk_replayed_total`.
