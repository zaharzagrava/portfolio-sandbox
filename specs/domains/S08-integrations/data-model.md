# Data Model: S08 — Catalog Sync Integrations

All tables are owned by `domain:catalog-sync` (register the six new ones in `packages/backend/db/ownership.ts` in the same change as their migration). IDs are UUID (uuidv7); `shopId`, `userId`, `localId` are plain IDs with **no foreign key** to other owners (IX.4). Timestamps `timestamptz`.

## Tables

### Integration (exists; altered)
`id`, `shopId`, `provider` CHECK `('shopify','woocommerce')`, `externalShop`, `status` CHECK `('ACTIVE','PAUSED','NEEDS_REAUTH','DISCONNECTED')`, `pausedReason` (`seller|shop_offboarding`, null unless PAUSED), `credentialsSealed` (nullable after erase; context `integration:<id>`), `locationId`, `connectedBy`, `lastError`, `lastSyncAt`, `consecutiveFailures` int default 0, `breakerOpenUntil`, `nextSyncAt`, `createdAt`, `updatedAt`.
- Drop FK `shopId → Shop`. Drop `lastHash`/`lastPushedHash` (contract step, after code stops reading them).
- Unique partial: `(provider, externalShop) WHERE status <> 'DISCONNECTED'`.
- Index `(shopId, createdAt DESC, id DESC)` for keyset lists; `(status, nextSyncAt)` for the scheduler.
- Data: `ERROR → NEEDS_REAUTH`; credentials re-sealed with the context.

### IntegrationHistory (new, append-only)
`id`, `integrationId`, `fromStatus`, `toStatus`, `reason`, `actorId`, `at`. Index `(integrationId, at)`.

### IntegrationInstall (new)
`id`, `shopId`, `userId`, `shopDomain`, `stateDigest` (sha256, unique), `expiresAt` (+10 min), `consumedAt`. Retention: expired > 1 day.

### SyncCursor (exists; altered)
`(integrationId, entity)` PK; `watermark`, `pageCursor`, `leaseHolder`, `leaseExpiresAt`, `fence` bigint. Watermark writes: `GREATEST` and `WHERE fence = :fence`.

### SyncRun (new)
`id`, `integrationId`, `kind` (`incremental|backfill|one|reconcile`), `startedAt`, `finishedAt`, `outcome` (`completed|completed_with_quarantine|yielded|failed|skipped_locked|skipped_breaker_open|skipped_shop_not_active|halted_schema_drift`), `counters` jsonb `{fetched, created, updated, unchanged, quarantined, stale}`, `detail` text (code only). Retention 30 days.

### ExternalLink (exists; altered)
PK `(integrationId, entity, externalId)` (`externalId = <productId>:<variantId>`); `localId`, `state` (`ACTIVE|UNLISTED|DELETED_AT_PROVIDER|IGNORED`), `contentDigest`, `syncedStock` int, `remoteUpdatedAt`, `lastStockWriteAt`, `lastLocalVersion` int, `raw` jsonb (≤ 256 KiB), `updatedAt`. Index `(localId)` with `shopId` carried via integration join in own tables (lookups by event: `(integrationId in shop's integrations, localId)`); add `shopId` column denormalised from the integration so event lookups put `shopId` in the predicate (AS-40).
- Data: rename old `<productId>` ids to `<productId>:<firstVariantId>`; later backfill creates other variants.

### SyncQuarantine (exists; altered)
`id`, `integrationId`, `entity`, `externalId` (nullable), `dedupeKey` (externalId or payload digest), `payloadDigest`, `reasonCode`, `message` (≤ 500), `payload` jsonb, `status` (`OPEN|RESOLVED|DISMISSED`), `occurrences`, `firstSeenAt`, `lastSeenAt`, `resolution` (`fixed_at_provider|dismissed|expired`), `dismissedBy`, `resolvedAt`. Unique `(integrationId, entity, dedupeKey) WHERE status = 'OPEN'`.

### StockConflict (new)
`id`, `integrationId`, `shopId`, `externalId`, `productId`, `kind` (`oversold|quantity_limit`), `base`, `local`, `remote`, `merged`, `resolvedTo`, `status` (`OPEN|DISMISSED`), `createdAt`, `dismissedBy`, `dismissedAt`, `resolution`. Unique `(integrationId, externalId, base, local, remote) WHERE status='OPEN'` → re-running a merge opens no second conflict.

### WebhookReceipt (new)
`(integrationId, deliveryId)` PK, `receivedAt`. Retention 7 days.

### ReconciliationRun (new)
`id`, `integrationId`, `startedAt`, `finishedAt`, `outcome` (`completed|aborted_mass_delete|failed`), `counts` jsonb, `findings` jsonb (≤ 1,000), `truncated`, `previousRunId`. Trigger: `BEFORE UPDATE` raises when `OLD.finishedAt IS NOT NULL`; `DELETE` stays permitted (retention and shop purge). Retention 90 days.

## State machines

Integration status (closed table, `assertNever` over the union):

| From \ Action | connect/reconnect | pause | resume | auth_failed | uninstall/disconnect | offboarding_started | offboarding_cancelled |
|---|---|---|---|---|---|---|---|
| (none) | ACTIVE | — | — | — | — | — | — |
| ACTIVE | — | PAUSED(seller) | ✗ 409 | NEEDS_REAUTH | DISCONNECTED | PAUSED(shop_offboarding) | no-op |
| PAUSED | ACTIVE (reconnect) | ✗ 409 | ACTIVE | NEEDS_REAUTH | DISCONNECTED | keep reason | ACTIVE only if reason = shop_offboarding |
| NEEDS_REAUTH | ACTIVE | ✗ 409 | ✗ 409 | — | DISCONNECTED | — | — |
| DISCONNECTED | ACTIVE (same row) | ✗ 409 | ✗ 409 | — | no-op (204) | — | — |

Each transition: conditional `UPDATE … WHERE id AND status = :from RETURNING`, history row and outbox event in one transaction; zero rows = refused/no-op → no event.

Link state: `ACTIVE ⇄ UNLISTED`, `ACTIVE → DELETED_AT_PROVIDER → ACTIVE` (relisted), any → `IGNORED` (local deletion; terminal). Quarantine: `OPEN → RESOLVED | DISMISSED` (terminal, conditional update). Conflict: `OPEN → DISMISSED`. Run lease: free → held(fence n) → expired → held(fence n+1).

## Validation rules (summary)
`shopDomain`: `^[a-z0-9][a-z0-9-]*\.myshopify\.com$`, ≤ 255, lower-cased, no port/scheme/path. `storeUrl`: https, port 443, no user-info/IP literal, SSRF-checked at validation and per call. Price: decimal string → minor units (exponent of platform currency, no floats). Stock: integer in `[0, 1e9]` after the `-n → 0` rule. `externalId` ≤ 64, `externalSku` ≤ 128, title ≤ 200, `message` ≤ 500, raw ≤ 256 KiB, webhook body ≤ 1 MiB.

## Migration order (expand → data → contract; `lock_timeout`, not at startup)
1. Expand: new columns/tables/indexes, drop Shop FK, widen status check, partial unique, trigger, ownership registry.
2. Data (separate script): link id rename, re-seal credentials, `ERROR→NEEDS_REAUTH`, backfill `ExternalLink.shopId`.
3. Contract: narrow provider check, drop old hash columns, remove old schedules (`removeSchedule`).
