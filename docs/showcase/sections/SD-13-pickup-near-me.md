# SD-13 — "Available Near Me" (Proximity search for pickup points & local stock)

Status: ☑ done (typechecked; spec written, not run) · Phase 3 · Depends on: F-02 (PostGIS), F-05, SD-02 · Extends README #16 (ES facets)

## Marketplace adaptation
Shops register **physical stores & pickup points** with local stock. Buyers search "AirPods Pro available for pickup within 5 km" or browse pickup points on a map.

## Patterns showcased
| Pattern | Lesson |
|---|---|
| **PostGIS** `geography(Point)` + GiST index, `ST_DWithin` for exact radius (source of truth for locations) | 10/05 #13, 03/01 §2 |
| **ES `geo_point`** on product docs (nested `pickupLocations`) → one query combining text relevance + filters + `geo_distance` + sort by distance — via F-05 projection | 10/05 #13, 10/09 #37 |
| **Geohash** precision buckets for map clustering (aggregation `geohash_grid`) | 10/05 #13 |
| Edge cases: radius across cell boundaries handled by ES/PostGIS (no manual 9-cell trick needed — documented) | 10/05 #13 |
| Local stock freshness via inventory events (eventual; exact check at reservation) | 10/09 #37 |

## Steps
- [x] Migration: `PickupPoint(shopId, name, location geography, openingHours jsonb)`, `PickupStock(pickupPointId, productId, quantity)`; GiST index.
- [x] ES mapping update (nested pickup locations + stock flag) and projector.
- [x] `GET /search/near?q=&lat=&lng=&radiusKm=` (S19) and `GET /pickup-points/clusters?bbox=&zoom=` (geotile_grid clusters), plus the exact `GET /pickup-points/near`.
- [x] e2e: product with stock at a point 3 km away appears for radius 5 km, not for 2 km; zero-stock point excluded.

## Scale
- Target: 20k RPS geo searches.
- Hot path: ES only (search reads never hit PostGIS); PostGIS for writes/admin and exact verification at reservation.
- First bottleneck & fix: nested docs reindex on stock changes → separate `pickup_stock` index joined by productId with terms lookup, or debounce stock updates (1 s coalescing in projector).
- Capacity model: ES geo_distance filter cached per tile; 3 data nodes × ~5k QPS.
- Proof: k6 geo search; p99 < 80 ms.

## Implementation notes (2026-10-01)
- Migration `20261001210000-pickup-points`: `PickupPoint` (`geography(Point,4326)` + GiST), `PickupStock` (version per row, partial index on in-stock).
- `PickupService` (PostGIS truth): create points, `setStock` (upsert + version bump + `pickup.stock_changed` outbox event in one tx), `near()` (`ST_DWithin` on geography in meters + KNN `<->` ordering + exact `ST_Distance`), `availableAt()` exact check for reservations.
- `AvailabilityIndex` (ES `pickup_availability`, one doc per product × point with stock): `searchNear` = fuzzy title match + `geo_distance` filter + **collapse on productId** with nearest-point inner hit; `clusters` = `geotile_grid` + `geo_centroid` over the viewport. `gc_deletes = 1h` so versioned deletes keep their tombstone long enough.
- `PickupAvailabilityProjector` (apps/projector): coalesced per (point, product), external_gte versions, quantity 0 → versioned delete.
- Endpoints: `POST /api/shops/:shopId/pickup-points`, `PUT .../pickup-points/:pointId/stock/:productId`, `GET /api/search/near?q=&lat=&lng=&radiusKm=`, `GET /api/pickup-points/near`, `GET /api/pickup-points/clusters?bbox=&zoom=`.
- Spec `pickup/pickup.e2e-spec.ts` (radius correctness, ordering, out-of-order safety).

## Rebuilt by S19 (2026-10-13)
Specified in `specs/domains/S19-pickup-near-me`, behavior in `docs/spec/capabilities/S19-pickup-near-me.md`. What changed against the notes above:
- Seller API with limits, optimistic versions and idempotent adjustments; points and stock carry their own `version`; `pickup.stock_changed` and `pickup.point_changed` are state events of topic `pickup.events`.
- The index `pickup_availability_v2` is private to the capability and built from four consumers (stock, point, product, shop) over a pure function of the exact store and two copy tables, so a replay in any order gives the same documents.
- Search pages with `search_after`; the engine refuses `collapse` together with it, so the one-item-per-product rule is applied by reading documents in sort order and keeping each product's first one.
- Responses are `{items, nextCursor}` with `priceMinor` + `currency`; clusters are `{cells, truncated}` with `cellId`; the old bare arrays and `tile` are gone.
- No foreign key leaves the pickup tables; the catalog is read through `ProductQueryService` and its events.
