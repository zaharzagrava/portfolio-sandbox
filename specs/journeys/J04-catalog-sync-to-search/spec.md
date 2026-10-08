# Feature Specification: J04 — Catalog Sync to Search: a shop imports its catalog (bulk file and Shopify), products become searchable and available near me, an offline store device sells stock, and the stock change syncs back to Shopify

**Feature Branch**: `J04-catalog-sync-to-search` (spec directory `specs/journeys/J04-catalog-sync-to-search`)

**Created**: 2026-10-08

**Status**: Draft

**Input**: User description: "Cross-domain journey J04: A shop imports its catalog (bulk file and Shopify), products become searchable and available near me, an offline store device sells stock, and the stock change syncs back to Shopify." Sources: constitution v3.1.0 (IV, VII, IX.7), `docs/architecture/domain-map.md`, `docs/architecture/debt-register.md` (D-7, D-8, D-10, D-12, D-15, D-16), the specs S05, S07, S08, S09, S19, S32, the sibling journeys J01 and J02 (control surface, hop-table style), the `interview-prep/` notes on events, projections and offline sync, and the current code (see `gaps.md`).

## Scope

A seller fills a shop's catalog from two sources, a bulk file and a Shopify store. The products show up in public search and, once the shop stocks them at a pickup point, in "available near me". A till in the store (an offline device) sells units; the sale lowers the catalog's stock, search shows the new availability, and Shopify's inventory is lowered to match. This journey proves only the **hand-offs between the domains**. Every rule inside one domain is already proven by that capability's own spec and is referenced, never re-tested (see `test-plan.md`).

The chain, with the kind of hand-off at each arrow (constitution IV.3, IX.7):

```
seller ─POST /shops/:id/imports (Idempotency-Key), PUT parts, POST …/complete─► catalog-sync (S07) ─SQS catalog-imports─► import worker
worker ──R1──► catalog.ProductImportService.upsertFromExternal(shopId, items, 'import') ─same transaction─► outbox: catalog.product_created|updated
worker ─outbox: catalog_sync.import_finished─► catalog-sync.events                                  (terminal; replayable SSE import:{importId})
seller ─POST /shops/:id/integrations/shopify/install, Shopify redirects to /integrations/shopify/callback─► catalog-sync (S08) ─SQS integration-backfill─► sync worker
worker ─HTTPS─► Shopify (edge double) ; ──R1──► catalog.upsertFromExternal(…, 'shopify') ─► outbox: catalog.product_*
Shopify ─signed webhook─► POST /integrations/:id/webhooks ─SQS integration-sync─► sync worker ; job catalog-sync.sync-all (every 5 min) ─► same queue
products.events (key productId) ─► discovery projector, group search-product-index (Elasticsearch)          [R3]   ─► GET /products/search
products.events ─► fulfilment projector, group pickup-availability (product copy: title, price, status)     [R3]
seller ─PUT /shops/:id/pickup-points/:pid/stock/:productId─► fulfilment ─outbox: pickup.stock_changed─► pickup.events ─► pickup-availability ─► GET /search/near
device ─POST /shops/:id/sync/push (stock.adjust, opId)─► catalog-sync (S09) ──R1──► catalog.ProductStockService.applyStockDelta (operationId sync:<shopId>:<opId>)
catalog ─same transaction─► outbox: catalog.product_updated (changedFields [quantity]) ─► products.events
   ├─► search-product-index        (inStock)                        ├─► offline-sync-feed (S09: other devices' pull)
   ├─► integrations-stock-push (S08): conditional write "set n, expected m" ─HTTPS─► Shopify (edge double)
   └─► pickup-availability (copy only; pickup stock is NOT changed by a catalog stock change)
Shopify echo (inventory update, next pull) ─► S08 merge: base = last synced stock ⇒ nothing to apply, nothing to push (no ping-pong)
```

In scope:

- The user-visible outcomes: products searchable, products available near me, stock equal in the catalog, in search availability, and at Shopify.
- The **eventual-consistency contract** of every asynchronous hop: maximum time to visibility on the local stack and how a client observes progress.
- The cross-domain failure modes: duplicate and out-of-order events, a consumer that is down and catches up, replay of a topic, a provider that is down (compensation), both sides selling the same unit (merge and conflict queue), a suspended shop, a retried request with the same idempotency key, cross-tenant access.
- The **journey control surface** (jobs, consumers, clock) as J01 defines it, and the provider doubles this journey adds (Shopify, malware scanner).
- The hand-offs that are missing or broken in the code today (`gaps.md`).

Out of scope (owners named):

- File rules (dialects, coercion, header check, scan, checkpoints, resume, error report) → **S07**. Shopify mapping, OAuth, webhook verification, SSRF guard, quarantine, reconciliation → **S08**. Device operations, hybrid clocks, field merge, change feed, conflict review → **S09**. Product validation, versions, archive, plan limits → **S05**. Index mapping, ranking, facets, reindex → **S32**. Pickup point rules, radius maths, clusters, exact check → **S19**.
- The buy chain (an order that consumes stock) → **J01**. Seller registration, verification and subscription → **J02**; J04 starts from a verified, active shop with a member who may write products and manage integrations (the fixture of J02, or the seeded equivalent).
- WooCommerce (same port and same hand-offs as Shopify; proven by S08).
- Screens (import wizard, integrations page, inventory, device app) → **W04** and phase 2. This is an **API journey with no UI scenario**.

## User Scenarios & Testing *(mandatory)*

### Notation and conventions

- People and things (created by the test through public APIs with unique names so journeys can share a stack; `<run>` is a unique lower-case alphanumeric run ID):
  - Shop `SH` (active, verified), owner `O` (has `products.write`, `products.read`, `integrations.manage`), a second shop `SH2` with owner `O2` (for IDOR), shopper `W` (anonymous), platform admin `A` (J01/J02 fixture), till device `D1` with header `X-Device-Id: till-<run>-1` and a second device `D2` (`till-<run>-2`).
  - File `F1`: CSV of **60** products. `sku = J04-<run>-001…060`, `title = "Lamp j04<run> 001"…"060"` (the token `j04<run>` is the search key), `price = 15.00`, `category = lamps`, `stock = 5`. File `F2`: the same rows with `stock` column absent and prices of rows 001–003 changed to `18.00`. File `F3`: not a catalog (a ZIP renamed `.csv`).
  - Shopify double `SD`: an HTTPS server owned by the test, speaking the Admin API shapes S08 uses (OAuth token exchange, products with variants, inventory levels, locations, webhook subscriptions). It holds 5 products / 7 variants (one draft product that must be ignored); variant `V1` (title `"Shopify Lamp j04<run> V1"`, price `19.99`, stock `10`) is the **device-sale variant**. `SD` can sign webhooks, can be told to answer `200`, `409`, `503`, or to hang, can change a variant's stock by itself (a sale on Shopify), and exposes its **write log** (`{variantId, set, expected}`) and current stock to the test.
  - Product `Pc` = F1 row 001 (CSV origin, no Shopify link), product `Ps` = the product of variant `V1` (Shopify origin, linked).
  - Pickup point `PP1` of `SH` at a known coordinate, and shopper location `L` 1.2 km from it.
- No database, topic or queue is read by the test. A hand-off step is written **`[trigger] → [domain reacts] → [observable]`**. Triggers are: an API call, a domain event, an SQS task, a scheduled job. Observables are public API reads, the Shopify double's log and stock, the SSE stream, or the control surface.
- **Waiting** is done only by polling an observable until it shows the expected state, with the deadline of the hop's contract (table below; deadline = 2 × maximum, poll interval 250 ms, scaled by `JOURNEY_TIME_FACTOR`). A fixed sleep is a test defect. Absence ("never") is asserted only after the same consumer reports `lag: 0` and the hop's maximum has elapsed on the stack clock.
- **Provider doubles** (system edge, local profile only, selected by configuration, refused at startup in production; constitution VII.2):
  - *Shopify double `SD`* as above. The local profile points the Shopify adapter at `SD` through an `allowedProviderHosts` setting (host and port), validated at startup, accepted only outside production; the SSRF guard stays on for every other host.
  - *Malware scanner double*: speaks the real streaming protocol, answers clean for everything except content containing the EICAR string. The scanner stays mandatory; the stack runs the double.
  - *Object storage*: the stack's real S3-compatible store. The test uploads parts to the presigned URLs, as a browser does.
  - *Platform admin* and *payment provider*: as J02 (not used here beyond the shop fixture).
- **Control surface** (J01's, admin role, local profile; see Cross-capability contracts): `POST /api/admin/jobs` + `GET /api/admin/jobs/:jobId`; `GET /api/admin/consumers/:group`, `…/pause`, `…/resume`, `…/replay {since}`; `GET|PUT /api/admin/clock`. J04 adds job types to the allow-list: `catalog-sync.sync-all`, `catalog-sync.reconcile-all`, `catalog-sync.recover-stalled-imports`, `search.reindex`. The journey restores the clock and resumes every consumer in `afterAll`, even on failure.
- Product state is read through **`GET /shops/:shopId/products?limit&cursor`** and **`GET /shops/:shopId/products/:productId`** (S05 member view: `externalSku`, `quantity`, `status`, `version`, `priceMinor`). Stock "in the catalog" always means this read.
- Every error is `application/problem+json` with a stable `code` (S54).

### Eventual-consistency contract (the hops)

Maximum time from the trigger until the result is visible **on the local stack** (single deployment of every process the chain needs: core, worker, projector, realtime gateway; outbox relay interval ≤ 2 s; search index refresh ≤ 1 s; sync consumers' coalescing window ≤ 2 s). The owner of each hop must meet it; the journey tests wait on it. These are local-stack numbers; the production staleness limits of the capability specs are looser and unchanged.

| Hop | From → to | Visible through | Max | Owner |
|---|---|---|---|---|
| H1 | `POST …/imports/:id/complete` accepted → SQS task → scan → parse → `DONE` (60 rows) | `GET /shops/:shopId/imports/:importId` (`status`, counters); SSE `import:{importId}` terminal event (replayable) | 30 s | S07 |
| H2 | import batch committed → products in the catalog | `GET /shops/:shopId/products` (already true when `DONE`) | at `DONE` | S05 |
| H3 | `catalog.product_created\|updated` → index document (title, price, `inStock`) | `GET /products/search?q=j04<run>` | 10 s | S32 |
| H4 | OAuth callback `302 ?connected=` → backfill task → products from `SD` in the catalog | `GET /shops/:shopId/integrations/:id` (`linkedProducts`, `lastSyncAt`); `GET /shops/:shopId/products` | 30 s | S08 |
| H5 | provider webhook accepted (`200`) → incremental pull → product updated | `GET /shops/:shopId/products/:id` | 15 s | S08 |
| H6 | job `catalog-sync.sync-all` run through the control surface → pull applied | `GET /api/admin/jobs/:jobId`; product read | 5 s to start, then 15 s | S08, S49 |
| H7 | `PUT …/pickup-points/:pid/stock/:productId` → `pickup.stock_changed` → offer in near-me | `GET /search/near`, `GET /pickup-points/near?productId=` (the latter is exact and immediate) | 10 s | S19 |
| H8 | `catalog.product_*` (title, price, archive, restore) → product copy in the pickup index | `GET /search/near` | 10 s | S19 |
| H9 | `POST …/sync/push` accepted → stock in the catalog | the push response (`quantityAfter`, `productVersion`); product read | synchronous | S09, S05 |
| H10 | `catalog.product_updated` (quantity) → `inStock` in the index | `GET /products/search` | 10 s | S32 |
| H11 | `catalog.product_updated` (quantity) → provider stock written | `SD` write log and stock | 10 s | S08 |
| H12 | `catalog.product_updated` → other device's change feed | `GET /shops/:shopId/sync/pull?cursor` with `D2` | 5 s | S09 |
| H13 | provider-side stock change (webhook or pull) → catalog stock merged | product read | 15 s | S08 |
| H14 | `tenancy.shop_status_changed` → products hidden / shown in search and near-me | `GET /products/search`, `GET /search/near` | 10 s | S32, S19 |
| H15 | a consumer resumed or replayed → `lag: 0` | `GET /api/admin/consumers/:group` | 15 s | S53 |
| H16 | any job run through the control surface → finished | `GET /api/admin/jobs/:jobId` | 5 s to start | S49 |

A consumer that is behind exposes its lag through `GET /api/admin/consumers/:group` (`lag`, `state`); a consumer at rest reports `lag: 0`. The search projection reports `projectionLagSeconds` on `GET /admin/search/index`; an integration reports `lagSeconds` on `GET /shops/:shopId/integrations/:id`.

Canonical consumer groups of this journey (names are contract, see `questions.md`): `search-product-index` (S32: `products.events`, `tenancy.events`), `product-cache-invalidator` (S05: `products.events`), `integrations-stock-push` (S08: `products.events`, `tenancy.events`), `offline-sync-feed` (S09: `products.events`), `pickup-availability` (S19: `pickup.events`, `products.events`, `tenancy.events`). Every one of them is idempotent by `eventId` (inbox) or a `productVersion` / `stockVersion` guard, validates its payload with zod, and dead-letters poison messages (IV.5).

**Saga statement.** No invariant in this journey spans two domains in one transaction. Catalog stock is the single source of truth inside the marketplace; search `inStock`, the pickup copy, the device feed and the Shopify inventory are **copies** that converge by events (IX.8). Compensation exists in two places: Shopify unreachable or refusing a write (AS-16: the difference stays visible and the next trigger repairs it) and both sides selling the last unit (AS-15: clamp to zero on both sides, open a conflict for a human). Nothing else is rolled back.

---

### User Story 1 — A bulk file becomes a searchable catalog, exactly once (Priority: P1)

A seller uploads a 60-product CSV straight to storage and finishes the upload. A minute later the products are in the shop and a shopper finds them by name. Running the same file again changes nothing anywhere; running it with new prices updates search.

**Why this priority**: it is the first source of catalog data and proves import → catalog → search.

**Independent Test**: public routes with a seeded shop and member, the storage presigned URLs, the scanner double; poll the import, the catalog and public search.

**Acceptance Scenarios**:

1. **AS-01** (file to search) — **Given** shop `SH`, owner `O` and `F1`:
   1. `[POST /shops/SH/imports {fileName, sizeBytes}` with `Idempotency-Key: k1` → catalog-sync → `201 {importId, parts[], …}]`; the test `PUT`s each part to its URL and calls `[POST …/imports/I/complete → catalog-sync → 202 + Location, status UPLOADED]`.
   2. `[SQS catalog-imports task → import worker: scan (scanner double, clean) → parse → R1 call catalog.upsertFromExternal in batches → catalog writes 60 products and one outbox row per product in the same transaction]` → observable: `GET …/imports/I` becomes `DONE` with `rowsCreated: 60, rowsFailed: 0` (H1); `GET /shops/SH/products` lists 60 products with `externalSku = sku`, `quantity 5`, `priceMinor 1500`, `version 1` (H2); the SSE stream `import:I` delivers `done`, also to a subscriber that connects after the end.
   3. `[catalog.product_created × 60 on products.events → search-product-index projector → index]` → observable: `GET /products/search?q=j04<run>` (anonymous) reports `total.value = 60` and `items[]` carrying `id`, `shopId = SH`, `priceMinor 1500`, `inStock: true` (H3). The same query for the other shop's token finds nothing of `SH2`.
   4. `[outbox catalog_sync.import_finished (status DONE) on catalog-sync.events]` → observable only through the terminal SSE event and the status read.
2. **AS-02** (retried start, re-import changes nothing) — **Given** AS-01 and the key `k1`:
   1. `[repeat POST /shops/SH/imports with k1 and the same body → idempotency facility → stored 201]` → the same `importId`; listing `GET /shops/SH/imports` shows exactly one import for the run.
   2. `[repeat POST …/complete → catalog-sync → 200 current status]` → no second task (the status history stays one run; counters do not move).
   3. `[start a second import with a new key and the same F1, upload, complete → worker → catalog answers `unchanged` for 60 items]` → `DONE` with `rowsUnchanged: 60, rowsCreated: 0`; every product keeps `version 1`; after the search consumer reports `lag: 0` and H3 has elapsed, `total.value` is still 60 and `projectionLagSeconds` did not rise because of this import (no events were written).
3. **AS-03** (changed rows reach search) — **Given** AS-02 and file `F2` (rows 001–003 at `18.00`, no stock column): **When** it is imported, **Then** `[catalog writes 3 updates, versions 2, quantity untouched]` → `rowsUpdated: 3, rowsUnchanged: 57`; `[catalog.product_updated × 3 → search-product-index]` → search shows `priceMinor 1800` for 001–003 and 1500 for the rest (H3); `quantity` is still 5 for all (an absent stock column leaves stock alone).
4. **AS-04** (a rejected file reaches nothing) — **Given** `F3` (ZIP renamed `.csv`): **When** the import runs, **Then** it ends `FAILED` with `failure.code: unsupported_file_type`, the terminal SSE event is `failed`, the shop's product count (list) and the search `total` for a fresh run token are unchanged, and no `catalog.product_*` event was produced (search `projectionLagSeconds` unchanged; the catalog list shows no new `createdAt`).

---

### User Story 2 — A Shopify store becomes part of the catalog and stays current (Priority: P1)

A seller connects a Shopify store. Its active variants appear as marketplace products with their stock, and later changes at Shopify, announced by webhook or found by the scheduled pull, flow in once, never twice.

**Why this priority**: it is the second catalog source and the origin of the stock that must flow back.

**Independent Test**: the Shopify double, the public install/callback routes, the worker and projector, the control surface.

**Acceptance Scenarios**:

1. **AS-05** (connect and backfill) — **Given** `SD` with 7 active variants and `O` with `integrations.manage`:
   1. `[POST /shops/SH/integrations/shopify/install {shopDomain: SD host} → catalog-sync → 200 {authorizeUrl}]`; the test plays the browser: it takes `state`, has `SD` sign the callback parameters and calls `[GET /integrations/shopify/callback → catalog-sync exchanges the code with SD, stores sealed credentials → 302 …?connected=<integrationId>]`.
   2. `[SQS integration-backfill task → sync worker pages through SD → R1 catalog.upsertFromExternal(…, 'shopify') → 7 products + outbox rows]` → observable: `GET /shops/SH/integrations/<id>` reaches `status ACTIVE, linkedProducts 7` (H4); the catalog lists 7 more products whose `quantity` equals `SD`'s stock and whose `externalSku` follows `shopify:<integrationId>:<productId>:<variantId>`; the draft product is absent.
   3. `[catalog.product_created × 7 → search-product-index]` → `GET /products/search?q=j04<run>` finds the Shopify variants (titles carry the token) with `inStock: true` (H3). The shopper's results now hold 60 CSV products plus 7 Shopify products.
   4. `[a second callback delivery with the same state → catalog-sync]` → `400 invalid_oauth_callback`; one integration and no second backfill (the product count stays 67).
2. **AS-06** (webhook fast path, duplicate delivery) — **Given** AS-05 and `SD` changing the price of `V1` to `21.50`:
   1. `[SD POSTs the signed products/update webhook to POST /integrations/<id>/webhooks, delivery ID d1 → catalog-sync verifies and answers 200 → SQS integration-sync one-product task]`; `[SD sends the identical delivery d1 again]` → `200`, no second task effect.
   2. `[sync worker pulls V1 → catalog.upsertFromExternal → one catalog.product_updated (productVersion +1)]` → observable: the product read shows `priceMinor 2150`, `version` +1 exactly (H5); search shows 2150 (H3). A webhook with a wrong signature answers `401` and changes nothing.
3. **AS-07** (scheduled pull finds a change without a webhook) — **Given** AS-05 and `SD` changing the title of another variant with no webhook:
   1. `[the operator runs POST /api/admin/jobs {type: "catalog-sync.sync-all"} → job scheduler → enqueue one incremental task per active integration of an active shop (R1 tenancy)]` → `GET /api/admin/jobs/:id` is `SUCCEEDED` (H6); running it a second time at once produces no second concurrent run of the integration (a lease), only a no-op.
   2. `[incremental pull → catalog.upsertFromExternal → product_updated]` → the product read and search show the new title (H6, H3); the integration's `lagSeconds` is below the pull interval.

---

### User Story 3 — A stocked product is available near me, and stays consistent with the catalog (Priority: P1)

The seller puts a catalog product on the shelf of a pickup point. A shopper nearby sees it with the point and the distance. When the product's title or price changes in the catalog, or it is archived, "near me" follows.

**Why this priority**: it is the hand-off from catalog events into the fulfilment read model, and the one domain whose stock is deliberately **not** the catalog's.

**Independent Test**: public near-me routes, the seller's pickup routes, catalog product routes.

**Acceptance Scenarios**:

1. **AS-08** (stock a point, find it) — **Given** `Pc` (catalog quantity 5) and no pickup stock:
   1. `[POST /shops/SH/pickup-points {name, address, lat, lng} → fulfilment → 201 PP1]` then `[PUT /shops/SH/pickup-points/PP1/stock/Pc {quantity: 4} → fulfilment checks the product belongs to SH through R1 catalog.getProductsByIds(ids, {shopId}) → writes stock and outbox pickup.stock_changed in one transaction → 200 {quantity 4, version}]`.
   2. `[pickup.stock_changed on pickup.events → pickup-availability projector → index]` → observable: `GET /search/near?lat&lng&radiusKm=5&q=j04<run>` from `L` lists exactly `Pc` (one item) with `nearest = {pickupPointId: PP1, distanceM ≈ 1200, quantity 4}` (H7); `GET /pickup-points/near?productId=Pc` lists `PP1` at once; a CSV product with no pickup stock is not listed; a product of `SH2` cannot be stocked by `O` (`404 product_not_found`, no event; AS-21).
   3. The offer's `title` and `priceMinor` are the catalog's, copied from the product event, not read from the catalog at query time.
2. **AS-09** (catalog changes follow into near-me) — **Given** AS-08:
   1. `[PATCH /shops/SH/products/Pc {expectedVersion, title: "Lamp j04<run> 001 XL", priceMinor: 1700} → catalog → catalog.product_updated (productVersion n+1)]` → `[pickup-availability product copy → index]` → near-me shows the new title and `1700` (H8), and search shows them (H3).
   2. `[POST …/products/Pc/archive {expectedVersion} → catalog.product_archived]` → near-me no longer lists `Pc` (H8) and public search no longer finds it (H3); `GET /pickup-points/near?productId=Pc` still lists the point because it is the exact store (the documented difference, S19).
   3. `[POST …/restore → catalog.product_restored]` → both list it again; the offer carries `quantity 4` (the pickup stock was never touched).
   4. `[a stale delivery of the earlier product_updated after the restore (replay, AS-19)]` never changes the final state (version guard).

---

### User Story 4 — An offline store device sells stock and every copy follows (Priority: P1)

A till sells units while the shop is online or after it reconnects. Each sale lowers the marketplace stock once, search availability follows, the pickup count is changed only by the seller's own pickup action, other devices see the change, and Shopify's inventory is lowered to the same number without echoing back.

**Why this priority**: it is the return leg and the reason the chain exists: one stock number, many copies.

**Independent Test**: sync push/pull routes, product routes, search, near-me, and the Shopify double's log.

**Acceptance Scenarios**:

1. **AS-10** (a sale reaches search and Shopify) — **Given** AS-05 (`Ps` at quantity 10, link base 10) and the consumer `integrations-stock-push` at `lag: 0`:
   1. `[POST /shops/SH/sync/push by D1: {type: stock.adjust, opId: <uuidv7>, hlc, productId: Ps, delta: −3, reason: sold} → catalog-sync (S09) claims the op, R1 catalog.applyStockDelta(operationId sync:SH:<opId>) → catalog writes quantity 7, version +1 and one catalog.product_updated (changedFields [quantity]) in one transaction → 200 results[0] {status applied, replayed false, quantityAfter 7, productVersion}]` (H9). catalog-sync wrote no product row and no product event.
   2. `[catalog.product_updated → integrations-stock-push → conditional write "set 7, expected 10" to SD]` → observable: `SD` stock is 7 and its write log holds exactly `[{V1, set 7, expected 10}]` (H11).
   3. `[SD's own inventory update (webhook or next pull) → S08 merge: remote 7 = base 7 = local 7]` → after a run of job `catalog-sync.sync-all` (and H13) the write log still holds one entry, the product's `version` is unchanged by the echo and no `product_updated` was produced (no ping-pong).
   4. `[product_updated → search-product-index]` → search still shows `Ps` with `inStock: true` (7 left) (H10).
2. **AS-11** (the same operation again, then sell out) — **Given** AS-10:
   1. `[D1 resends the same push, same opId (the till retries after a timeout) → S09 returns the stored outcome]` → `results[0] {status applied, replayed true, quantityAfter 7}`; the catalog `version` and quantity are unchanged and `SD`'s write log still has one entry. The same `opId` with a different delta answers `rejected op_id_reused`, changing nothing.
   2. `[D1 pushes delta −7, a new opId → catalog quantity 0 → product_updated]` → search shows `inStock: false` for `Ps` within H10 and still finds the product by title; `SD` stock becomes 0 (H11, write log now two entries, the second `{set 0, expected 7}`).
3. **AS-12** (a CSV product: no Shopify write, pickup count independent) — **Given** AS-08 (`Pc` catalog quantity 5, pickup stock at `PP1` 4):
   1. `[D1 pushes delta −1 for Pc → catalog quantity 4 → product_updated]` → search keeps `inStock: true` (H10); `SD`'s write log gains **no** entry (the product has no link) once `integrations-stock-push` is at `lag: 0`.
   2. The near-me offer for `Pc` still shows `quantity 4`: a catalog stock change does not change pickup stock (S19 contract); `GET /shops/SH/pickup-points/PP1/stock` agrees.
   3. `[the seller's till integration lowers the shelf count: POST …/pickup-points/PP1/stock/Pc/adjustments {delta: −1} with Idempotency-Key k2 → fulfilment → outbox pickup.stock_changed]` → near-me shows `quantity 3` (H7); the same request with `k2` again returns the stored body with `Idempotency-Replayed: true` and the count stays 3; `k2` with `{delta: −2}` answers `422`.
4. **AS-13** (another device sees the sale) — **Given** AS-10 and device `D2` that pulled at cursor `C0` before the sale: **When** `D2` calls `GET /shops/SH/sync/pull?cursor=C0` (header `X-Device-Id`), **Then** `[catalog.product_updated → offline-sync-feed → change log]` → within H12 it contains one entry for `Ps` with `data.quantity` 7 (then a later entry 0 after AS-11), `seq` strictly increasing and gap-free, and the product written by `D1` is not duplicated by an import or Shopify write of the same product.

---

### User Story 5 — Both sides sell, the provider is down: stock converges and nothing is lost (Priority: P2)

Stock is sold in the store and at Shopify at the same time, or Shopify cannot be reached when the till sells. The marketplace never oversells silently and never loses a sale.

**Why this priority**: concurrent writers on a shared counter are where cross-system sync breaks.

**Independent Test**: the Shopify double with scripted stock and failures; sync push; the control surface for consumers and jobs.

**Acceptance Scenarios**:

1. **AS-14** (both sold, either order) — **Given** a Shopify-origin product `Pd` with catalog quantity 10 = Shopify stock 10 = link base 10, **When** `D1` sells 2 (`delta −2`) and, before the push consumer writes, `SD` sells 3 on its own (stock 7), **Then** `[push consumer's conditional write "set 8, expected 10" is refused by SD (it holds 7) → S08 abandons it and merges from the fresh remote state: local 8 + remote 7 − base 10 = 5 → applies delta −3 to the catalog through applyStockDelta (operationId sync:<I>:…) and writes "set 5, expected 7" to SD]`; observable: the catalog quantity, search availability and `SD` stock all read **5**, `SD`'s accepted write log ends with one `{set 5}`, and `GET …/integrations/<id>/conflicts` is empty (H11, H13). The run is repeated with the pull applied first; the end state is the same.
2. **AS-15** (oversold: clamp both sides, ask a human) — **Given** `Pe` at catalog 3 = Shopify 3 = base 3, **When** `D1` sells 3 and `SD` sells 2 in the same window, **Then** `[merge result would be −2 → both sides set to 0 and one stock conflict opened (catalog_sync.stock_conflict_opened)]`; observable: catalog quantity 0, `SD` stock 0, search `inStock: false`, and `GET /shops/SH/integrations/<id>/conflicts?status=OPEN` returns one `oversold` conflict `{base 3, local 0, remote 1, merged −2, resolvedTo 0}`; a second run of the same merge opens no second conflict; dismissing it changes no stock. Operator-visible: the integration's `openConflicts` is 1.
3. **AS-16** (Shopify down: compensation by the next trigger) — **Given** `Ps`-like linked product `Pf` at 10 and `SD` answering `503` to inventory writes, **When** `D1` sells 2 (catalog 8, accepted, `quantityAfter 8`), **Then** the sale is **not** held back by Shopify: the push response and the catalog show 8 at once and search stays correct (H9, H10); `[integrations-stock-push → conditional write fails 3 times with backoff → retried by the queue, not in a loop]`; observable: `SD` stock is still 10, `GET …/integrations/<id>` shows a visible difference (`lastError`, `lagSeconds` growing, breaker state if opened). **When** `SD` recovers and the operator runs `catalog-sync.sync-all` (or the next product event arrives), **Then** `SD` stock becomes 8 (H11) with exactly one accepted write, the catalog is untouched by the repair, and `lastError` clears. The sale was never reversed (no compensating stock increase).

---

### User Story 6 — A consumer that is down, duplicate and out-of-order deliveries (Priority: P2)

A projector is stopped while sales happen. When it returns it catches up to the same state a never-stopped consumer reaches, whatever the order or number of deliveries.

**Why this priority**: constitution IV.5 and IX.7 R3 stand on it; this proves it across real consumers.

**Independent Test**: the control surface (pause, resume, replay), sync push, search, Shopify double.

**Acceptance Scenarios**:

1. **AS-17** (search consumer down, then catch-up) — **Given** `search-product-index` paused and a fresh Shopify-origin product `Pg` at 4 in stock, **When** `D1` sells all 4, **Then** the catalog says 0 at once (H9) and `SD` is lowered (H11, a different consumer), while public search still shows `Pg` `inStock: true` after the search consumer reports `lag > 0` and the H10 maximum has passed (eventual consistency is visible, not hidden). **When** the consumer is resumed, **Then** `lag` reaches 0 (H15) and search shows `inStock: false`; `projectionLagSeconds` returns to normal.
2. **AS-18** (push consumer down: a burst becomes one write) — **Given** `integrations-stock-push` paused and linked `Ph` at 10, **When** `D1` sells 1, 1 and 2 (three pushes, three product events, catalog 6), **Then** nothing is written to `SD` while paused (its log has no entry for `Ph`); **When** resumed, **Then** after H15 and H11 `SD`'s log holds **one** accepted write `{set 6, expected 10}` (coalescing by product, newest version wins) and `SD` stock is 6.
3. **AS-19** (replay: duplicates and old versions after new) — **Given** AS-01 to AS-18 complete with recorded observables (search results for the run token, near-me results, `SD` stock and write-log length, catalog quantities and versions, pull feed), **When** the operator replays, through the control surface, `products.events`, `pickup.events` and `tenancy.events` from the time the journey started for the groups `search-product-index`, `pickup-availability`, `offline-sync-feed`, `integrations-stock-push`, `product-cache-invalidator`, and each reports `lag: 0` again, **Then** every recorded observable is identical (old versions arrive after new and are ignored; events are delivered twice and have one effect), `SD`'s write log has the same length (replaying product events never pushes a stale quantity), and no catalog `version` changed.

---

### User Story 7 — The boundaries hold: shop lifecycle, tenant isolation, one writer (Priority: P2)

The catalog is changed only by the catalog, only for the shop that owns the product, and a shop that stops being active disappears from every buyer-facing surface and stops syncing.

**Why this priority**: these are the cross-domain invariants that production incidents come from (cross-tenant writes, zombie sync, double writers).

**Independent Test**: admin suspend/reinstate, second shop's token, product `version` reads.

**Acceptance Scenarios**:

1. **AS-20** (a suspended shop stops everything) — **Given** AS-01 to AS-08 done and a new import `I3` (a copy of `F1` with fresh SKUs) uploaded and completed for `SH` but not yet processed, **When** the admin calls `POST /admin/shops/SH/suspend`, **Then** `[tenancy.shop_status_changed (SUSPENDED) → search-product-index, pickup-availability, integrations-stock-push]` → search and near-me show none of `SH`'s products within H14; a running or later import ends `FAILED` with `failure.code shop_not_active`, nothing from the refused batch is written; a device push answers the shop-status problem (`409`) and writes nothing; `catalog-sync.sync-all` skips the integration (no `SD` call is made, the log does not grow). **When** the admin reinstates the shop, **Then** search and near-me list the products again within H14 (a repaired state, not a rebuild), and the integration pulls again on the next run, applying the change `SD` accumulated meanwhile once.
2. **AS-21** (no cross-tenant reach) — **Given** `O2` (owner of `SH2`) and `O`'s ids, **When** `O2` calls `GET /shops/SH/imports/I`, `POST /shops/SH/imports`, `GET /shops/SH/integrations`, `POST /shops/SH/sync/push`, or `PUT /shops/SH2/pickup-points/<SH2 point>/stock/Pc` (a product of `SH`), **Then** each answers `404` or `403` with no body detail that names the other shop's resource, and no event, task, stock row or `SD` write results; `O`'s own reads are unaffected.
3. **AS-22** (one writer per product, one version per change) — **Given** a product written in turn by an import (F2 row), a Shopify pull, a till push and a seller `PATCH`, **When** each completes, **Then** the product's `version` increases by exactly one per accepted change in this order (never by two for one change, never by zero for a real change), search and the pickup copy settle on the last version, and the device feed has one entry per change (observable through reads only). A change that changes nothing (a repeated import row, an echo) leaves `version` unchanged.

---

### User Story 8 — Operators and engineers can see progress (Priority: P3)

An operator, and the journey test itself, can tell where a change is: uploaded, imported, indexed, written to Shopify.

**Why this priority**: eventual consistency without observability is unsupportable, and tests wait on observables, not sleeps.

**Independent Test**: the status and lag reads named below.

**Acceptance Scenarios**:

1. **AS-23** (every hop shows its progress) — **Given** a running AS-01, AS-05 and AS-10, **Then** the test can see, only through public reads: the import's `status`, counters and `bytesProcessed` and its SSE `progress` then terminal event (S07); the integration's `status`, `linkedProducts`, `lagSeconds`, `lastSyncAt`, `openConflicts` (S08); each canonical consumer group's `state` and `lag` (S53); the search projection's `projectionLagSeconds` (S32); the job status of control-surface jobs (S49). A non-admin user cannot read the consumer or job endpoints (`403`); a removed shop member loses the SSE import stream (`import:{importId}` policy).

---

### Edge Cases

- An import and a Shopify pull write the same shop concurrently: they write different products (`externalSku` spaces never collide) and each product's `version` stays consistent (AS-22); the catalog serialises per product.
- The search index is rebuilt (`search.reindex`) while products change: the swap loses nothing because the rebuild replays `products.events` and the old index keeps receiving writes (S32); the journey asserts the end state only (`search.reindex` allow-listed; the scenario is S32's AS-40s and is referenced, not re-run).
- A `catalog.product_deleted` (shop deletion) removes the pickup stock rows and index entries; its journey is S03's offboarding, not J04.
- A payload that fails its schema, or an unknown event type, is dead-lettered by each consumer without effect (VII.4); the journey does not inject poison messages (no public way); the per-consumer proof is in the capability plans.
- The journey assumes the relay publishes the typed envelope in both relay modes (J01 gap).
- Two imports of one shop at once, the scanner down, a stalled worker, a lost queue message and the recovery job (`catalog-sync.recover-stalled-imports`): S07's job-level behaviours (AS-23 to AS-25, AS-36, AS-40), referenced, not re-run.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Every product change caused by import, Shopify, device or seller MUST reach the catalog through the catalog's exported commands (`upsertFromExternal`, `applyStockDelta`, `ProductCommandService`), and the catalog alone MUST write `catalog.product_*` events in the same transaction (AS-01, AS-10, AS-22).
- **FR-002**: Each change MUST increase `productVersion` by exactly one and emit exactly one event; a change that changes nothing MUST emit none (AS-02, AS-10 step 3, AS-22).
- **FR-003**: Public search MUST show an imported or synced product, and every later price, title, availability and visibility change, within H3/H10 of the commit (AS-01, AS-03, AS-05, AS-10, AS-11).
- **FR-004**: The near-me index MUST follow pickup stock changes (H7) and catalog product changes (H8) and MUST show only visible products of active shops (AS-08, AS-09, AS-20).
- **FR-005**: Pickup stock MUST NOT be changed by a catalog stock change, and a catalog stock change MUST NOT be hidden by pickup stock; both are changed by their own owner's routes (AS-12).
- **FR-006**: A sale pushed by a device MUST be applied exactly once per `(shopId, opId)`, and a replay MUST return the stored outcome without a second catalog effect or Shopify write (AS-11).
- **FR-007**: A stock change on a Shopify-linked product, from any writer, MUST be written to Shopify within H11 as a conditional absolute write; a change on an unlinked product MUST NOT call Shopify (AS-10, AS-12).
- **FR-008**: A Shopify echo of the marketplace's own write MUST cause no catalog change, no event and no second write (AS-10 step 3).
- **FR-009**: When both sides changed stock, the merge MUST equal `local + remote − base`, never below zero; an impossible merge MUST clamp to zero on both sides and open one conflict (AS-14, AS-15).
- **FR-010**: A sale MUST be accepted by the catalog independently of Shopify's availability, and the difference MUST be repaired by the next trigger without reversing the sale (AS-16).
- **FR-011**: Every consumer in the chain MUST be idempotent and version-guarded; a replay of any topic from the journey start MUST reproduce the same observable state and cause no provider write (AS-17 to AS-19).
- **FR-012**: A paused consumer MUST leave the other consumers unaffected and MUST catch up to `lag: 0` after resume (AS-17, AS-18).
- **FR-013**: A retried request with the same `Idempotency-Key` MUST return the stored result with one effect: import start, pickup adjustment (AS-02, AS-12); a duplicate webhook delivery and a duplicate OAuth callback MUST have one effect (AS-05, AS-06).
- **FR-014**: A shop that is not active MUST disappear from search and near-me, MUST stop imports, pushes and pulls, and MUST reappear on reinstatement, all through events and R1 status checks (AS-20).
- **FR-015**: No route of one shop MUST reach another shop's import, integration, device sync or product (AS-21).
- **FR-016**: Progress of every asynchronous hop MUST be observable through a public read (AS-23); the SSE import terminal event MUST be replayable.
- **FR-017**: The journey MUST drive and observe only through public APIs, the provider doubles and the control surface, MUST restore the clock and resume consumers even when it fails, and MUST never use a fixed sleep.
- **FR-018**: No stub or double MAY exist in production configuration: `allowedProviderHosts`, the scanner double and the control surface refuse to start in production (checked by a startup test of the composition).

### Key Entities *(include if feature involves data)*

- **Journey fixtures**: shops `SH`/`SH2`, owners, devices `D1`/`D2`, files `F1`–`F3`, Shopify double `SD`, pickup point `PP1`, products `Pc`, `Ps`, `Pd`, `Pe`, `Pf`, `Pg`, `Ph`.
- **Import job** (S07), **Integration, link, sync run, stock conflict** (S08), **Sync operation, change feed** (S09), **Product** (S05), **Index document** (S32), **Pickup point, pickup stock, product copy** (S19): owned by those capabilities and never read directly by the journey.
- **Event**: envelope `{eventId, type, version, occurredAt, aggregateId}` on `products.events`, `pickup.events`, `tenancy.events`, `catalog-sync.events`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A 60-product file is fully visible to shoppers within 60 seconds of the seller finishing the upload on the local stack, and importing it again changes nothing visible.
- **SC-002**: A connected Shopify store's active variants are visible to shoppers within 60 seconds of the seller returning from the install screen.
- **SC-003**: After a till sale, shoppers see the correct availability within 10 seconds and Shopify holds the same stock within 10 seconds, with exactly one write per sale.
- **SC-004**: A product put on a pickup shelf is findable nearby within 10 seconds, and follows title, price and archive changes within 10 seconds.
- **SC-005**: Across 100 replays of a sale (same operation ID) and 100 duplicate webhook deliveries, the marketplace stock and Shopify stock change exactly once.
- **SC-006**: When both sides sell the same unit, 100% of cases end with identical non-negative stock on both sides and, if clamped, one open conflict for a human.
- **SC-007**: A consumer stopped for any period and resumed reaches the same state as one never stopped, with zero lost and zero duplicated effects.
- **SC-008**: A suspended shop's products vanish from search and near-me within 10 seconds and its imports and syncs stop; no other shop is affected.
- **SC-009**: Every waiting step in the journey ends on an observable condition or a documented deadline, with zero fixed sleeps.

## Assumptions

Defaults chosen unattended (each also in `questions.md`):

- The journey starts from a verified, active shop and a member holding `products.write`, `products.read` and `integrations.manage`; J02's fixture, or a seeded equivalent, provides them.
- "Available near me" is the S19 near-me endpoint family fed by **pickup stock**, which the seller sets through S19's routes. Catalog stock and pickup stock are independent (S19 contract); the journey proves the independence rather than coupling them.
- The Shopify side is a test-owned double reached through a local-profile host allow-list; real Shopify is never called.
- The local-stack hop maxima in the table are the contract the owners must meet; they are tighter than production staleness numbers and are checked only on the local stack.
- Only Shopify is journeyed; WooCommerce shares the port and hand-offs and stays with S08.
- Products are found in the catalog by listing and matching `externalSku`/title (no new filter is required of S05); search by the unique token `j04<run>`.
- The device sale on a Shopify product is the device-to-Shopify leg; a sale through checkout (S10) uses the same catalog stock command and the same consumers and is proven by J01/S08 AS-36, not here.
- Consumer group names are contract (J02 convention); renaming existing projectors is accepted.
- The malware scanner stays mandatory; the stack runs a double that speaks the real protocol.
- Test data volume is small (60 rows, 7 variants); throughput, memory and batch boundaries are S07/S08 proofs.

## Cross-capability contracts

Searched before writing: `grep -rl` over `specs/domains specs/web specs/journeys` for `J04` and `journeys`. Contracts the earlier specs require from this journey, and how they are honoured:

- **S05** (spec:33): cross-domain journeys J02 and J04 (honoured: AS-10, AS-22 prove the single-writer rule across import, Shopify, device, seller).
- **S07** (questions CONTRACT): "J04 treats `DONE` (or `catalog_sync.import_finished`) as the trigger and waits for the search projection" (honoured: AS-01, H1, H3).
- **S08** (questions CONTRACT): "J04 ('the stock change syncs back to Shopify') is proved by AS-36 for every stock writer" (honoured: AS-10 to AS-18 use the device writer; S08 AS-36 covers the writers' equivalence).
- **S09** (questions CONTRACT, FR-015): "step 'an offline store device sells stock' is proven by AS-01 (push) and AS-52 (stock only through the catalog), then S05's event reaches S32, S19 and S08 → journeys read only HTTP and events" (honoured: AS-10 to AS-13). **Differs in one word**: the event reaches S19 only as a **product copy**; pickup stock is unchanged (S19's contract). `[CONTRACT]` in `questions.md`.
- **S19** (questions CONTRACT): J04 sets and reads pickup stock through S19's HTTP endpoints; an offline sale does not change pickup stock (honoured: AS-08, AS-12).
- **S32** (spec:377): imported products become searchable through S05's events and S32 owns the staleness bound (honoured: H3, H10; the local-stack 10 s equals S32's p95).
- **J02** (spec:301): `GET /products/search` shape `{searchId, mode, items[{id, shopId, …}], total, nextCursor, degraded}`; assertions use `items[].id|shopId|priceMinor|inStock` (honoured the same way).

**Provides** (J04 has no runtime exports; it provides tests, fixtures and a timing contract):

- `packages/backend/test/journeys/catalog-sync-to-search.journey-spec.ts` (top-level `describe` "Journey J04: catalog sync to search").
- `packages/backend/test/journeys/support/` additions to J01/J02's kit: `catalogFixture` (`F1`–`F3` builders, multipart upload helper that PUTs presigned parts), `shopifyDouble` (HTTPS server: OAuth, products, inventory, webhook signer, write log, scripted failures, own sales), `scannerDouble` (streaming protocol, EICAR), `pickupFixture` (point, stock, location), `deviceClient` (HLC, UUIDv7 `opId`, push/pull), and `waitForContract(hop, probe)` rows H1–H16.
- **The hop table** (H1–H16) and **the canonical consumer-group names** in this spec. Owners must not exceed the maxima.

**Requires** (owner and exact shape assumed):

- **S07 (catalog-sync, import)**: `POST /shops/:shopId/imports` (`Idempotency-Key` required) → `201 {importId, status, partSize, partCount, parts[{partNumber,url}], uploadExpiresAt}`; `POST …/:importId/complete {parts[{partNumber,etag}]}` → `202`/`200`; `GET …/:importId` → `importJobSchema` (`status` in `PENDING_UPLOAD|UPLOADED|SCANNING|PROCESSING|DONE|FAILED|CANCELLED|EXPIRED`, `rowsProcessed|Created|Updated|Unchanged|Failed`, `failure {code}`); `GET /shops/:shopId/imports`; SSE `GET /streams?topics=import:<importId>` (`progress`, `done`, `failed`, `cancelled`; terminal replayable); event `catalog_sync.import_finished` v1 `{importId, shopId, status, failureCode?, rows…}` on `catalog-sync.events` keyed `importId`; job `catalog-sync.recover-stalled-imports`; scanner mandatory.
- **S08 (catalog-sync, integrations)**: `POST /shops/:shopId/integrations/shopify/install {shopDomain}` → `200 {authorizeUrl, expiresAt}`; `GET /integrations/shopify/callback` → `302 …?connected=<id>` | `400 invalid_oauth_callback`; `POST /integrations/:id/webhooks` → `200` | `401`; `GET /shops/:shopId/integrations/:id` → `integrationSchema {status, linkedProducts, lastSyncAt, lagSeconds, lastError, openQuarantine, openConflicts, breakerOpenUntil}`; `GET …/conflicts?status` → `conflictPageSchema`; consumer group **`integrations-stock-push`** on `products.events` and `tenancy.events` (version-guarded, coalescing by product, ignores unlinked, sandbox and echo, conditional write); SQS `integration-backfill` and `integration-sync`; job `catalog-sync.sync-all` (allow-listed); `allowedProviderHosts` local-profile setting; permission `integrations.manage`; deterministic `externalSku` `shopify:<integrationId>:<productId>:<variantId>`.
- **S09 (catalog-sync, offline)**: `POST /shops/:shopId/sync/push` (`X-Device-Id`) → `200 {results[{index, opId, status, replayed, code?, quantityAfter?, productVersion?}], serverHlc}`; `GET /shops/:shopId/sync/pull?cursor&limit` → `{changes[{seq, entity, id, version, deleted, data}], cursor, hasMore}`; consumer group **`offline-sync-feed`** on `products.events`; stock only through `applyStockDelta` with `operationId sync:<shopId>:<opId>`.
- **S05 (catalog)**: the routes of S05's Provides (`POST/GET/PATCH …/products`, `archive`, `restore`; list `?status&category&inStock&limit&cursor`; member view with `externalSku`, `quantity`, `status`, `version`, `priceMinor`); R1 `ProductImportService.upsertFromExternal`, `ProductStockService.applyStockDelta`, `getProductsByIds(ids, {shopId})`; events `catalog.product_created|updated|archived|restored|deleted` on `products.events` keyed `productId`, `productVersion` strictly +1 per change, snapshot payload with `quantity`, `inStock`, `status`, `isSandbox`, `externalSku`, `changedFields`; every stock writer emits (including checkout writers); consumer group **`product-cache-invalidator`**.
- **S32 (discovery)**: `GET /products/search` → `productSearchResponseSchema` (`items[].id|shopId|title|priceMinor|currency|inStock`, `total {value, exact}`); consumer group **`search-product-index`** on `products.events` and `tenancy.events`; hides archived, sandbox and non-active-shop products; index refresh ≤ 1 s on the local profile; `GET /admin/search/index` with `projectionLagSeconds`; job `search.reindex`.
- **S19 (fulfilment)**: `POST /shops/:shopId/pickup-points`; `PUT …/pickup-points/:pointId/stock/:productId {quantity, expectedVersion?}`; `POST …/stock/:productId/adjustments {delta}` (`Idempotency-Key`, replay header `Idempotency-Replayed: true`); `GET /shops/:shopId/pickup-points/:pointId/stock`; public `GET /search/near` → `{items[{productId, title, category, priceMinor, currency, nearest{pickupPointId, name, distanceM, quantity}}], nextCursor}`; `GET /pickup-points/near?productId` (exact); events `pickup.stock_changed` / `pickup.point_changed` on `pickup.events`; consumer group **`pickup-availability`** (stock, point, product and shop events, version-guarded, product copy built from `catalog.product_*`); `404 product_not_found` for a product of another shop.
- **S03 (tenancy)**: `POST /admin/shops/:shopId/suspend|reinstate`; `tenancy.shop_status_changed {shopId, from, to, shopVersion}` on `tenancy.events` keyed `shopId`; `ShopQueryService.getShopsByIds` (R1); permissions `products.read|write`, `integrations.manage`; the status gate (`409`) for writes of a non-active shop.
- **S49 / S53 / S54 / J01**: the control surface (jobs allow-list gains `catalog-sync.sync-all`, `catalog-sync.reconcile-all`, `catalog-sync.recover-stalled-imports`, `search.reindex`; consumer `pause|resume|replay` and `lag`; clock); the outbox relay publishing the same typed envelope in every mode; topics `products.events`, `pickup.events`, `tenancy.events`, `catalog-sync.events` created explicitly.
- **S51**: SSE `GET /api/streams?topics=import:<importId>` with the member policy of S07.
- **Local stack (apps)**: a deployment that hosts core, worker, projector, realtime gateway and the scanner/storage/search/Shopify-double wiring, and refuses all doubles in production.
