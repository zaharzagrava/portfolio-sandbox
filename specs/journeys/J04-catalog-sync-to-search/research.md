# Research: J04 — Catalog sync to search

`gaps.md` was written by static reading before S01–S55 were built. This audit (static reading of the current tree, nothing run) re-rates each row. Paths are under `packages/backend/`.

## 1. Audit of gaps.md

| Gap | State now | Evidence | Decision |
|---|---|---|---|
| G-01 envelope | BUILT | `libs/infrastructure/outbox/outbox-publisher.service.ts:90,261` | Journey proves it end to end; no work. |
| G-02 product events | BUILT | `libs/domains/catalog/application/events/product-events.ts`, `catalog/product-events.e2e-spec.ts` | WP1: confirm no raw `products.events` writer remains outside catalog. |
| G-03 R1 commands | BUILT | `catalog/application/product-import.service.ts`, `product-stock.service.ts`, adapters `catalog-sync/infra/*-catalog.adapter.ts` | None. |
| G-04 online stock writers | PARTIAL | orders and auctions use `applyStockDelta`; `order.service`, `order.jobs`, `auction.jobs`, `payment.service` not read | WP1: verify none writes `Product.quantity` raw; fix any hit in its own domain. |
| G-05 import end | PARTIAL | event registered as `catalogsync.import_finished` (`catalog-sync/application/events/import-events.ts:15`; S53 patterns forbid `_` in the first segment); SSE `import:{id}` built | Name differs from spec text only; journey observes SSE and status, never the topic. Note in living spec. |
| G-06, G-07 import start, scan | BUILT | `import.jobs.ts:44`, scanner port `import-scanner.adapter.ts`, `Idempotency-Key` specs | None; WP4 supplies the scanner double. |
| G-08 Shopify connect | PARTIAL | install, callback, `integrations.manage` exist; **no provider host allow-list** (`provider-http.ts` uses `safeRequest` only) | WP3. |
| G-09 doubles | PARTIAL | lib-level fakes only (`catalog-sync/test/fakes/`) | WP4 (HTTP doubles in the journey kit). |
| G-10 webhook | BUILT | `api/integration-webhook.controller.ts`, `application/webhook.service.ts` | Journey proves dedupe and `401`; fix in S08 if the run disagrees. |
| G-11 stock push | PARTIAL | `catalog-sync/infra/product-events.consumer.ts` (group `catalog-sync-product-events`), `domain/stock-merge.ts`; canonical name not registered | WP2 alias. |
| G-12 FIFO queues | SUPERSEDED | queues deliberately standard (L-001, `task-sync-queue.ts:14`) | No work; lease and fencing stay. |
| G-13..G-15 reconcile, device push, feed | BUILT | `integration-reconcile.e2e-spec.ts`, `sync-pull.e2e-spec.ts`, migration `20261015300100` drops the trigger, `sync-feed.consumer.ts` (group `catalog-sync-offline-feed`) | WP2 alias `offline-sync-feed`. |
| G-16, G-17 search | PARTIAL | alias `search-product-index` exists in `libs/infrastructure/projections/consumer-groups.ts`; route in discovery; `GET /admin/search/index` exists | WP5: verify `projectionLagSeconds`, response shape in the journey. |
| G-18 near-me copy | BUILT | `fulfilment/infra/pickup-product.projector.ts`, `product-copy.store.ts` | WP2 alias `pickup-availability` (real groups `pickup-index-stock|shop|product|point`). |
| G-19 topics | OPEN | `scripts/init-kafka-topics.sh` lists no `pickup.events`, `tenancy.events`, `catalog-sync.events` | WP2 (L-002, L-011). |
| G-20 near-me API | BUILT | `fulfilment/api/pickup-public.controller.ts:40,52`, adjustments `pickup-points.controller.ts:110` | Journey parses the schemas. |
| G-21 framework | BUILT | inbox, `min-version.ts`, `coalesce.ts`, redrive under `libs/infrastructure/projections/` | None. |
| G-22 control surface | BUILT | `test/journeys/support/control-surface.ts` and server side | WP2: add J04 job types to the allow-list where missing. |
| G-23 shop lifecycle | PARTIAL | `catalog-sync/infra/tenancy-events.consumer.ts`, `pickup-shop.projector.ts`, `search-shop-state` | AS-20 proves it; fix per domain. |
| G-24 import fan-out | UNVERIFIED | `community/infra/feed-projectors.ts` has no import-origin skip | WP6 (S26). |
| G-25 rate limits | PARTIAL | `catalog-sync/rate-limit-policies.ts`, `fulfilment.near-search` | WP6: journey address on the allow-list. |
| G-26 local stack | OPEN | `apps/local-monolith` has no scanner double and no provider allow-list | WP3, WP4. |
| G-27 kit | OPEN | no catalog journey file or fixtures | WP4, WP5. |
| D-7/D-12 | BUILT | no `ProductModel` use in discovery, fulfilment, community, catalog-sync | WP1: `catalog/infra/models/product.model.ts:137` comment about discovery may be stale. |
| D-15, D-10, D-8 | PARTIAL/unverified | search route moved; queues separate | WP1 static gates (`check:boundaries`). |

## 2. Decisions

- **Canonical consumer groups are aliases, not renames** (as J02, `consumer-groups.ts`): renaming drops committed offsets. Alternative rejected: rename.
- **Provider host allow-list** `ALLOWED_PROVIDER_HOSTS` (host:port) in `libs/common/config/local-profile-config.ts`, refused when `NODE_ENV=production`, consumed by the Shopify adapter's `safeRequest` options for listed host:port only. Alternative (switch the SSRF guard off) rejected.
- **Scanner double**: a clamd-protocol TCP server in the journey kit reached through `clamav_host`; the scan hop stays. Alternative `media_scanner_disabled` rejected.
- **Shopify double**: HTTPS server in the kit (self-signed, trusted by CA fingerprint like the J02 receiver). Alternative in-process `FakeProvider` rejected (per process, G-09).
- **Hop ids** `J04.H1`…`J04.H16` in `wait-for-contract.ts`.
- **Test-first per story slice**; fix in the owning domain.

## 3. Known-failure classes applied
L-001 no FIFO options; L-002/L-011 topics added to the init script; L-003 no "A or B"; L-005/L-006 each scenario creates its products; L-010 idempotent fixtures; L-013/L-016 `restoreAll`; L-018 standalone boots at the final checkpoint, not tasks; L-029 journey serial.
