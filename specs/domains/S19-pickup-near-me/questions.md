# Questions and defaults: S19 — Pickup near me (domain `fulfilment`)

Decided without asking (decision policy: most production-grade option the notes and the constitution support). Sorted by impact; review BREAKING and CONTRACT first.

## BREAKING

- [BREAKING] `PickupPoint.shopId → Shop` and `PickupStock.productId → Product` are foreign keys (migration `20261001210000-pickup-points.js:15,29`, with `ON DELETE CASCADE`) → drop both by an expand/contract migration (plain ID columns); product deletion and shop deletion are handled by events (`catalog.product_deleted` removes stock rows, `tenancy.shop_deleted` deactivates points) → IX.4 forbids cross-domain FKs; IX.9 extractability.
- [BREAKING] The projector reads the catalog's `Product` table through `ProductModel` (`infra/pickup-availability.projector.ts:4,24,33`) → it builds a fulfilment-owned product copy from `catalog.product_*` snapshot events (version-guarded) and `setStock` seeds it from `ProductQueryService.getProductsByIds` → IX.4, IX.7 R1+R3, IX.8; D-7. The e2e spec stops importing `ProductModel`/`ShopModel` (`pickup.e2e-spec.ts:10,12`) and seeds through shared fixtures.
- [BREAKING] `setStock` never checks that the product belongs to the shop, so a member of shop A can put stock of shop B's product (cross-tenant write, `pickup.service.ts:42-62`) → `404 product_not_found` via the catalog's shop-filtered batch read → III.4, V.4 (IDOR); mandatory VII.3 case.
- [BREAKING] Response shapes: `GET /search/near` and `GET /pickup-points/near` return bare arrays, `price` as a number; clusters return `[{tile, offers, lat, lng}]` → `{items, nextCursor}` envelopes, `priceMinor` + `currency`, clusters `{cells: [{cellId, offers, pickupPoints, lat, lng, pickupPointId?}], truncated}` → III.8 (integer money), III.10 (cursor pagination), V.2 (contracts schemas), counting points (what a map shows) not only offers. Web and BFF callers and tests update.
- [BREAKING] Parameters are silently clamped and unvalidated (`radiusKm` has no type check, `clampRadius` hides bad input; `bbox` and `zoom` are parsed by hand, `zoom` unbounded; `limit` fixed 20/50, no cursor, `pickup.controller.ts:21-78`) → strict validation with `400 validation_failed` (radius 0.1–50, zoom integer 0–20, limit 1–50, unknown params refused, antimeridian boxes allowed) → V.3, II.2 (global `ValidationPipe`).
- [BREAKING] Rate limiting reuses `search.query` (60/min) for the shopper endpoints and `skipThrottle` on clusters (`pickup.controller.ts:57,65,71`) → dedicated policies `fulfilment.near-search` (120/min) and `fulfilment.map-clusters` (300/min, fail open) → an unthrottled public aggregation is an abuse path; policies belong in S50's registry.
- [BREAKING] Search index failure surfaces as an unhandled error (500) → `503 search_unavailable` after an 800 ms timeout, no fallback to the exact store → IV.6 (timeouts), V.3 (no upstream message), notes: "search reads never hit PostGIS"; fallback would melt the primary at 20k RPS.
- [BREAKING] Errors are Nest default exceptions (`NotFoundException('Pickup point not found')`, `pickup.service.ts:48`) → problem+json with stable `code`s (`pickup_point_not_found`, `product_not_found`, `pickup_point_inactive`, `pickup_point_limit_reached`, `stock_version_conflict`, `insufficient_pickup_stock`, `stock_limit_exceeded`, `search_unavailable`) → V.3.
- [BREAKING] `PUT …/stock/:productId` bumps `version` and emits an event even when the quantity is unchanged (`pickup.service.ts:51-59`) → no-op replay (same version, no event) and optional `expectedVersion` → idempotent replays do not create events; optimistic concurrency for two editors.
- [BREAKING] Stock can be written to an inactive point (the SELECT filters `active` but nothing can deactivate a point) → points get `PATCH` (active, name, address, hours); stock writes to inactive points answer `409 pickup_point_inactive` → "illegal state transitions" and a missing lifecycle; the `active` column was dead.
- [BREAKING] `CreatePickupPointDto` has no `openingHours` but the service accepts it (`pickup.controller.ts:10-15`, `pickup.service.ts:32`), so a client can never set it under `forbidNonWhitelisted` → accepted and validated (timezone + weekly intervals).
- [BREAKING] Event `pickup.stock_changed` carries the row version as the envelope version and no `stockVersion` in the payload (`pickup-events.ts:5`) → payload `stockVersion`; envelope `version: 1` as IV.4 requires; new `pickup.point_changed`; topic `pickup.events` → IV.4, IX.8 (version for read-model guards).
- [BREAKING] The barrel exports `AvailabilityIndex`, `PickupAvailabilityProjector`, `PickupModule` internals (`index.ts:9-12`) → export `PickupModule`, `PickupProjectorModule`, `PickupAvailabilityService`, DTO types and event contracts only → X.4, D-8.
- [BREAKING] `PickupService` runs raw SQL in `application/` and `AvailabilityIndex` (an infra class) is injected by the controller (`pickup.controller.ts:8`, `pickup.service.ts:33-86`) → repository and search-index ports in `domain/`, adapters in `infra/` → I.2, D-6.
- [BREAKING] Point and stock writes have no principal-aware reads beyond the `shopId` on a few statements; `near()` ignores shop status → shop is in every predicate; points of non-`ACTIVE` shops, archived and sandbox products are invisible → III.4; shops suspended must not sell.

## CONTRACT

- [CONTRACT] S10 lists S19 as consumer of `order.paid` ("→ dispatch") and of `OrderFulfilmentService.apply` → S19 consumes neither; dispatch is S20's, and pickup collection is not modelled because S10 carries no pickup choice → S10 should list only S20; if a pickup checkout is added later, S10 calls `PickupAvailabilityService.checkAvailability` (R1).
- [CONTRACT] S05 expects S19 to consume `catalog.product_*` events and to stop reading `Product` → honoured: events with `productVersion`, `status`, `isSandbox`, `priceMinor`, `currency`, `category`, `title`; `catalog.product_deleted` also removes stock; S19 additionally asks `getProductsByIds(ids, {shopId})` at stock write (needs the `{shopId}` filter and `version` in the DTO).
- [CONTRACT] S09 FR-015 and J04 say an offline sale "reaches pickup" through the catalog's event → pickup stock is per point and independent of the catalog `quantity`; catalog stock changes do not change pickup stock; J04 must set and read stock through S19's HTTP endpoints → conflating the two would make a store's per-point counts depend on a global counter.
- [CONTRACT] S03 → events `tenancy.shop_status_changed` and `tenancy.shop_deleted` with `shopVersion`; S19 asks nothing else of S03 beyond `ShopScoped('products.read' | 'products.write')` and the status gate → keeps pickup offers of suspended shops invisible.
- [CONTRACT] S50 → registers `fulfilment.near-search` and `fulfilment.map-clusters`.
- [CONTRACT] S53 → the consumer framework must support per-key coalescing (30 edits → 1 write) and a version-guard mechanism for consumers; S54 → idempotency facility for the adjustments endpoint with 24 h TTL.
- [CONTRACT] S48/W02 → the product page's "pickup near me" section calls `GET /pickup-points/near?productId=` (exact) and the map uses `/pickup-points/clusters`; both are public and cacheable only for clusters.
- [CONTRACT] S32 → S19 does not use S32's index and S32 does not use S19's; "available near me" is a separate endpoint family, not a filter of `GET /products/search`.
- [CONTRACT] S20 (same domain) → `domain/geohash.ts` and the realtime topic module stay with S20; S19 uses no geohash code (the search index does the cell maths).

## LOCAL

- [LOCAL] Spatial cells for clusters → the index's tile grid (zoom 0–20), cell id = tile key → notes show geohash and tile grids; the notes' implementation record uses tiles.
- [LOCAL] Offers per cell vs. points per cell → both; points exact up to 1 000 per cell → a map pin is a place, not an offer.
- [LOCAL] Max 100 points per shop, stock 0–1 000 000, delta ±100 000 → bounds for validation and abuse.
- [LOCAL] Idempotency TTL for adjustments → 24 h.
- [LOCAL] Search timeout 800 ms, exact store statement limit 2 s.
- [LOCAL] Location immutable → moving a store changes every offer document and its history; a new point is simpler and auditable.
- [LOCAL] "Open now" filter → not built; opening hours are stored and returned.
- [LOCAL] Product copy table and shop visibility copy → fulfilment-owned tables (R3 "a table owned by A"), registered in `db/ownership.ts`.
- [LOCAL] Exact stock quantity shown to shoppers → yes.
- [LOCAL] Exact browse reads the exact store → the only shopper read that does; capped by rate limit, limit and statement timeout.
- [LOCAL] No reconcile job → replay (AS-31) is the repair path.
- [LOCAL] Cursor encodes the last sort tuple and a hash of the query → opaque, tamper-evident.
