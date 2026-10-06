# SD-36 — Shop Integrations: Shopify/WooCommerce Catalog & Stock Sync (ETL)

Status: ☑ done (typechecked; specs written, not run) · Phase 6 · Depends on: SD-02, SD-29, SD-28, SD-27 (upsert path), F-05

## Marketplace adaptation
Shops already running Shopify/WooCommerce connect them: products and stock sync **incrementally**, both directions for stock (sell on either side), respecting provider rate limits.

## Patterns showcased
| Pattern | Lesson |
|---|---|
| Connector configs per shop/provider; OAuth tokens with refresh in Secrets Manager / encrypted column | 10/09 #36 |
| Scheduler → sync jobs per (shop, provider, entity) on SQS; **backfills on a separate queue** | 10/09 #36 |
| **Incremental sync with watermark + overlap window**, checkpoint per page | 06/02 §4 |
| **Distributed token bucket per provider credential** (SD-28) + honour `Retry-After` + breaker | 04/03 §4 |
| **Anti-corruption layer**: provider DTO → zod → normalised model; raw payload kept (JSONB) | 10/09 #36 |
| Idempotent upsert by (provider, externalId) | 10/09 #36 |
| **Bidirectional stock**: field ownership, **echo suppression** (origin tag + last-synced hash), conflict queue | 06/02 §3 |
| Provider webhooks → fast ACK → queue → same upsert path | 04/03 §5 |
| **Nightly reconciliation**: compare IDs/hashes, detect deletes, report drift | 06/02 §5 |
| Schema drift → quarantine table + alert, not crash | 10/09 #36 |

## Steps
- [x] `Integration`, `SyncCursor`, `ExternalLink(provider, externalId, localId, lastHash)`, `SyncQuarantine` models.
- [x] Provider port + Shopify adapter (real API shapes, fetch via ResilientHttpClient) + fake provider for tests.
- [x] Sync worker, webhook receiver, reconciliation job, echo suppression.
- [x] e2e (fake provider): incremental sync picks only changed products with overlap; our stock change pushed once, provider echo ignored; malformed product quarantined.

## Scale
- Target: 100k connected shops; provider rate limits are the bottleneck, not us → fairness + per-credential buckets.

## Implementation notes (2026-10-02)
- **Schema:** migration `20261002130000-integrations` adds `Integration` (sealed credentials via SecretBox), `SyncCursor` (watermark + in-pass page checkpoint), `ExternalLink` (provider id ↔ ours, raw payload, `lastHash`/`lastPushedHash`) and `SyncQuarantine`.
- **Provider port** (`provider.port.ts`) with `NormalizedProduct` zod as the anti-corruption layer:
  - `ShopifyProvider`: Admin REST 2024-10, `updated_at_min` + Link-header `page_info` pagination, `inventory_levels/set` (idempotent "set", not "adjust"), `X-Shopify-Hmac-Sha256` webhook verification, a per-credential fleet-wide token bucket (`integrations.shopify`) before each call, 429/Retry-After handled by the resilient client.
  - `FakeProvider`: a different shape, page size 2, records writes.
  - WooCommerce would be one more adapter on the same port.
- **`IntegrationSyncService`:**
  - **Incremental:** watermark − 5 min overlap; checkpoint per page; the watermark advances to the max `updatedAt` seen only after a full pass. Malformed items are quarantined and the sync continues.
  - **Inbound apply:** `syncHash` equal to `lastHash` → skip (covers overlap re-reads AND the echo of our own pushes); otherwise upsert the product + link + outbox.
  - **Outbound** (`StockPushProjector`, projector, coalesced): push stock only when the local-state hash ≠ `lastHash`. Inbound applies set `lastHash` to the provider state, so their own `products.events` push nothing → no ping-pong.
  - **Webhooks:** HMAC on the raw body → enqueue → fast 200; the worker fetches the current state.
  - **Queues:** `integration-sync` (incremental/webhooks, concurrency 20) and `integration-backfill` (initial pulls, concurrency 4). A 5-minute scheduled sync is the guarantee (webhooks get lost).
  - **Nightly `reconcile`:** zero + report products deleted at the provider; re-pull unknown remote ids.
- **Field ownership:** catalog fields are provider-owned (inbound only); stock is bidirectional.

## Test plan
| Scenario | API e2e | UI journey (web) | Unit |
|---|---|---|---|
| Shop connects a store; catalog appears | `integrations.e2e-spec.ts` › initial sync | web: connect Shopify (OAuth) → products listed (happy path) | — |
| Malformed provider product quarantined, sync continues | `integrations.e2e-spec.ts` | — | — |
| Incremental: only changes since the watermark; overlap re-read applies nothing | `integrations.e2e-spec.ts` | — | — |
| Marketplace sale pushes stock once; echo ignored both ways | `integrations.e2e-spec.ts` | — | — |
| Webhook HMAC (valid / forged) → fetch current state | `integrations.e2e-spec.ts` | — | — |
| Product deleted at provider → zeroed + reported | `integrations.e2e-spec.ts` | — | — |
