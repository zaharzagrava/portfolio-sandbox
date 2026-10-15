# Events, messages, jobs and policies: S08

## Produced events (outbox → topic `catalog-sync.events`, key `integrationId`)
Envelope `{eventId, type, version: 1, occurredAt, aggregateId}`; payloads in `integrationEventSchemas` (contracts). Written with `outbox.append(event)` inside the transaction of the change; none on 409, replay or no-op.

| type | payload |
|---|---|
| `catalog_sync.integration_connected` | `{integrationId, shopId, provider, externalShop, connectedBy}` |
| `catalog_sync.integration_status_changed` | `{integrationId, shopId, from, to, reason: connected\|seller\|shop_offboarding\|offboarding_cancelled\|auth_failed\|uninstalled\|disconnected\|reconnected}` |
| `catalog_sync.integration_attention_required` | `{integrationId, shopId, reason: needs_reauth\|breaker_open\|schema_drift\|sync_lag\|reconcile_mass_delete, detail}` |
| `catalog_sync.stock_conflict_opened` | `{conflictId, integrationId, shopId, productId, kind, base, local, remote, resolvedTo}` |
| `catalog_sync.reconciliation_completed` | `{integrationId, shopId, runId, outcome, counts}` |

This domain publishes **no** `products.events` row (A2). The topic is shared with S07's `catalog_sync.import_finished`; consumers filter on `type`.

## Consumed
| Source | Handler | Idempotency |
|---|---|---|
| `products.events` `catalog.product_created\|updated\|archived\|restored\|deleted` | stock push / `IGNORED` link | S53 inbox record by `eventId`; link `lastLocalVersion` guard; coalescing per `productId`; invalid → DLQ |
| `tenancy.shop_offboarding_started {shopId,purgeAt}` / `_cancelled {shopId}` / `shop_deleted {shopId}` | pause / resume own pauses / purge in ≤1,000-row batches | inbox record; conditional updates; resumable purge |

## Queues (validated at message creation, L-001; standard queues → only `delaySeconds`, never `groupId`)
Message `{integrationId: uuid, kind: 'incremental'|'backfill'|'one'|'reconcile', externalId?: string(1–64)}` (strict zod; extra field / bad UUID / empty `externalId` → reject, DLQ after receive count).
- `integration-sync`: `incremental`, `one`; concurrency 20; visibility 300 s; DLQ after 5 receives.
- `integration-backfill`: `backfill`, `reconcile`; concurrency 4; visibility 900 s; DLQ after 3 receives.
Both queues and DLQs must exist in `elasticmq.conf` and terraform (L-002); the capability's task list includes the queue-server reload command (L-020).

## Scheduled jobs (S49; `declareJobType` with payload contract next to the `JobPayloads` augmentation)
- `catalog-sync.sync-all` every 5 min (renamed; removes `integrations.sync-all`).
- `catalog-sync.reconcile-all` daily 03:40 UTC, enqueues one `reconcile` per eligible integration (removes `integrations.reconcile-all`).
- `catalog-sync.purge-integration-data` daily.
Registration catches `InvalidScheduleError`; `removeSchedule` for the two old names.

## Rate-limit policies (S50 registry)
`integrations.shopify` (exists, token bucket 40/20 s, per credential), `integrations.woocommerce` (bucket 20 burst, 5/s, fail closed), `catalog-sync.integration-write.shop` 30/min, `catalog-sync.sync-now.integration` 1/min, `catalog-sync.reconcile-now.integration` 1/h (all fail closed), `catalog-sync.webhook.integration` 1,200/min and `catalog-sync.webhook.ip` 600/min (fail open). 429 from a provider → `penalize(policy, credentialId, retryAfterMs)`; other workers' `check` answering `reason: 'paused'` yields with `retryAfterMs`.

## Metrics (FR-102)
`catalog_sync_runs_total{provider,kind,outcome}`, `catalog_sync_lag_seconds{provider}`, `catalog_sync_items_total{provider,result}`, `catalog_sync_provider_calls_total{provider,status}`, `catalog_sync_provider_429_total{provider}`, `catalog_sync_echo_suppressed_total`, `catalog_sync_quarantine_open`, `catalog_sync_conflicts_open`, `catalog_sync_webhooks_total{provider,result}`, `catalog_sync_breaker_open{provider}`, `catalog_sync_reconcile_findings_total{kind}`. No label carries a token, secret, signature or payload.
