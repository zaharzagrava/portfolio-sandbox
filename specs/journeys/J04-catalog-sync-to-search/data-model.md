# Data Model: J04 — Catalog sync to search

J04 adds **no table, migration, queue or runtime route**. One topic-list edit (WP2) and one local-profile setting (WP3).

## Entities observed (owner → observable)

| Entity | Owner | Observable | States asserted |
|---|---|---|---|
| Import job | catalog-sync (S07) | `GET /shops/:id/imports/:importId`, SSE `import:{id}` | `UPLOADED → DONE | FAILED`; counters |
| Product | catalog (S05) | `GET /shops/:id/products[/:pid]` | `version` +1 per accepted change, `quantity`, `status` |
| Integration, link, conflict | catalog-sync (S08) | `GET /shops/:id/integrations/:iid`, `…/conflicts` | `ACTIVE`, `linkedProducts`, `lastError`, `openConflicts` |
| Sync operation, feed | catalog-sync (S09) | push results, `GET …/sync/pull` | `applied/replayed`, `seq` gap-free |
| Index document | discovery (S32) | `GET /products/search`, `GET /admin/search/index` | `inStock`, price, hidden with the shop |
| Pickup stock, product copy | fulfilment (S19) | `GET /search/near`, `GET /pickup-points/near` | independent of catalog stock |
| Consumer group | S53 | `GET /api/admin/consumers/:group` | `state`, `lag` |

## Canonical consumer aliases (`libs/infrastructure/projections/consumer-groups.ts`)

| Canonical | Real groups |
|---|---|
| `integrations-stock-push` | `catalog-sync-product-events` (and the tenancy consumer's group of S08) |
| `offline-sync-feed` | `catalog-sync-offline-feed` |
| `pickup-availability` | `pickup-index-stock`, `pickup-index-shop`, `pickup-index-product`, `pickup-index-point` |
| `search-product-index`, `product-cache-invalidator` | already registered |

## Topics (L-002, L-011)
`pickup.events`, `tenancy.events`, `catalog-sync.events` are added to `packages/backend/scripts/init-kafka-topics.sh` (`products.events` exists).

## Local-profile settings
`ALLOWED_PROVIDER_HOSTS` (host:port list); scanner through `clamav_host`; both refused/irrelevant in production (`NODE_ENV=production` with the list set fails startup).

## Test-kit types (test code only)
`ShopifyDouble` (`writeLog[{variantId,set,expected}]`, `answer(200|409|503|hang)`, `sell(variant,n)`), `ScannerDouble`, `CatalogFixture` (F1–F3), `PickupFixture`, `DeviceClient` (HLC, UUIDv7 `opId`), `Recorded` snapshot for AS-19.

## Boundary check (post-design)
The journey reads no table, topic or queue. The alias edit touches only the projections registry; the allow-list only the catalog-sync provider adapter and config.
