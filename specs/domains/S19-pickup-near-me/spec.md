# Feature Specification: S19 — Pickup Points, Local Stock, "Available Near Me" Search, Map Clustering (domain `fulfilment`)

**Feature Branch**: `S19-pickup-near-me` (spec directory `specs/domains/S19-pickup-near-me`)

**Created**: 2026-10-05

**Status**: Draft

**Input**: User description: "Pickup points, local stock, 'available near me' search, map clustering (domain `fulfilment`)". Sources: `docs/showcase/sections/SD-13-pickup-near-me.md`, note 10-System-Design/05-social-and-content.md §13 (proximity search), pattern P0328 of `docs/architecture/pattern-map.md`. Constitution v3.1.0.

## Scope

Shops register physical stores and pickup points and keep a local stock count per product at each point. Shoppers ask "AirPods Pro available for pickup within 5 km", browse pickup points around them, and pan a map that shows clusters of points with stock. The exact store (the source of truth) holds points and stock; the shopper-facing search and the map read only from a search index that follows the exact store with a small, bounded delay; a reservation-time check reads the exact store.

In scope:

- **Pickup points**: a shop creates, edits, deactivates and reactivates points (name, address, location, opening hours), lists its own points, and is limited to 100 points.
- **Local stock**: absolute stock set per (point, product) with optimistic versioning, relative adjustments that never go below zero and are safe to retry, a stock listing per point.
- **"Available near me" search**: text relevance + distance filter + in-stock filter, one result per product with its nearest point, cursor pagination.
- **Exact point browse**: pickup points within a radius, ordered by exact distance, optionally only those holding a product.
- **Map clustering**: in-stock offers grouped into zoom-dependent cells inside a viewport.
- **Freshness**: changes to stock, points, products and shops reach the search index in order, idempotently, replayably, within a stated delay.
- **Reservation-time exact check**: an exported service other capabilities call to confirm stock before holding it.

Out of scope (owners named):

- Product data, prices, product stock of the catalog → **S05** (`catalog`). Pickup stock is separate from the catalog's own `quantity`.
- Shops, roles, permissions, shop status → **S03**. Authentication → **S01**.
- Product text search, autocomplete, facets → **S32**/**S33**. This capability only answers "which products are in stock near this location".
- Same-day courier dispatch, delivery state machine, courier positions, `order.paid` consumption → **S20** (same domain, separate capability).
- Placing, paying for, reserving or collecting a pickup order: orders carry no pickup point in this release (S10 models no shipping or pickup choice). The exact-check service is provided so a later checkout flow can use it.
- Screens (product page "pickup near me", map page, seller stock screens) → **W02** and the seller web capabilities; the product page composes this capability's answers with product data in the BFF (**S48**, IX.7 R2).
- Rate limiter, jobs, outbox, consumers, idempotency facility, metrics, problem+json filter → **S50**, **S49**, **S53**, **S54**.
- Courier tracking, Redis GEO, GPS history → **S20**.

## User Scenarios & Testing *(mandatory)*

Notation: Berlin coordinates. `ALEX` is the shopper's location (Alexanderplatz). `KREUZBERG` is a point about 3 km from `ALEX`, `SPANDAU` about 12 km, `MITTE` about 0.5 km. `S1`, `S2` are shops; `U1` is a member of `S1` with role `STAFF`, `V1` a `VIEWER` of `S1`, `U2` a member of `S2` only. `A`, `B`, `C` are products of `S1`; `X` is a product of `S2`. "The index has caught up" means the test has run the consumers over the outbox rows the transaction wrote and waited for the index to refresh. "Time is frozen" means tests control the clock. Every error is `application/problem+json` with `type`, `title`, `status`, `detail`, `instance`, `requestId` and a stable `code`. Money is integer minor units.

### User Story 1 — A shopper finds a product available for pickup nearby (Priority: P1)

A shopper types "airpods" and sees which shops hold it in stock within a radius, nearest first, one row per product, with the nearest pickup point and how far it is. Zero-stock points never appear.

**Why this priority**: this is the point of the capability; a wrong "available" costs a wasted trip.

**Independent Test**: stock `A` at `KREUZBERG` (4 units) and `SPANDAU` (0), search from `ALEX` with radius 5 and 2, and 20.

**Acceptance Scenarios**:

1. **AS-01** (radius and stock) — **Given** `A` ("AirPods Pro 3") with stock 4 at `KREUZBERG` and 0 at `SPANDAU`, the index has caught up, **When** `GET /search/near?q=airpods&lat&lng` of `ALEX` with `radiusKm=5`, **Then** `200` with exactly one item: `productId = A`, `nearest = {pickupPointId: KREUZBERG, name, distanceM > 2000, quantity: 4}`; **When** `radiusKm=2`, **Then** `items = []`; **When** `radiusKm=20`, **Then** still exactly one item (`SPANDAU` has no stock and is not listed).
2. **AS-02** (one hit per product, ranking) — **Given** `A` in stock at `KREUZBERG` (3 km) and `MITTE` (0.5 km) and `B` ("AirPods Case") at `KREUZBERG` only, **When** searching `q=airpods` with radius 10, **Then** `A` appears once with `nearest.pickupPointId = MITTE`; items are ordered by text relevance first and distance second; a misspelling `airpdos` still finds `A`; **When** `q` is absent, **Then** items are ordered by the distance of each product's nearest point, then by `productId`.
3. **AS-03** (radius across cell boundaries) — **Given** two points 120 m apart that fall in different map cells at every zoom up to 20 (one on each side of a cell boundary), both with `A` in stock, and a shopper standing on the boundary, **When** searching with radius 1 km, **Then** both points are found (no neighbouring-cell loss), and `nearest` is the closer of the two; **When** the radius is 0.1 km and only one point is within 100 m, **Then** only that point qualifies.
4. **AS-04** (validation classes) — **Given** the endpoint, **When** called with each of: `lat` missing, non-numeric or outside `[-90, 90]`; `lng` missing, non-numeric or outside `[-180, 180]`; `radiusKm` non-numeric, `< 0.1` or `> 50`; `q` longer than 100 characters; `limit` non-integer, `< 1` or `> 50`; a malformed `cursor`; an unknown query parameter, **Then** each answers `400 validation_failed` with the offending field named in `errors[]` and nothing is queried; a blank `q` (spaces only) is treated as absent; defaults are `radiusKm = 5`, `limit = 20`.
5. **AS-05** (cursor pagination) — **Given** 45 products in stock within 3 km at distinct and at equal distances, **When** paging with `limit=20` and the returned `nextCursor` until it is `null`, **Then** three pages of 20, 20 and 5 items arrive, no product appears twice or is missed, the order is the same as one unpaged request, equal distances break on `productId`, and `nextCursor` is opaque (not a number, not base64 of a bare offset); **When** a cursor from `q=a` is reused with `q=b`, **Then** `400 validation_failed` (cursor does not match the query).
6. **AS-06** (visibility rules) — **Given** products and points where: `A` is `ARCHIVED`; `B` is a sandbox product (`isSandbox`); `C` is stocked at an inactive point; `D` belongs to a shop whose status is not `ACTIVE`; `E` is normal, **When** the index has caught up and a shopper searches, browses and loads clusters, **Then** only `E` is visible in all three; **When** `A` is restored, the point is reactivated and the shop is reinstated, **Then** `A`, `C` and `D` reappear after the index has caught up.
7. **AS-07** (anonymous access and response contract) — **Given** no credentials, **When** a shopper calls the three read endpoints, **Then** `200` (no `401`), bodies parse with the contracts schemas, items carry `priceMinor` and `currency` (never a floating-point price), and no field outside the response schema (no shop owner, no internal version, no index metadata) is present.
8. **AS-08** (rate limit) — **Given** the policy `fulfilment.near-search` (120 requests per minute per user or client address, fail open), **When** 121 requests arrive in one minute from one address, **Then** the 121st gets `429 rate_limited` with `Retry-After`; **When** the limiter's store is unavailable (forced), **Then** requests are allowed and the fallback is logged and counted.
9. **AS-09** (search index unavailable or slow) — **Given** the search index is unreachable or answers slower than 800 ms (forced), **When** a shopper searches, **Then** `503 search_unavailable` with `Retry-After`, a generic `detail` (no upstream message), the failure counted in metrics, and the exact store is not queried as a fallback for the search.

---

### User Story 2 — A seller manages pickup points and local stock (Priority: P1)

A shop owner or staff member registers their physical stores, sets how many units of each product sit at each store, and rings up in-store sales as adjustments. Only members of the shop can do it, stock never goes negative, and retries never double count.

**Why this priority**: without trustworthy local stock nothing near-me is trustworthy.

**Independent Test**: create a point, set stock, adjust twice with the same key, run ten concurrent decrements against stock 5.

**Acceptance Scenarios**:

1. **AS-10** (create point) — **Given** `U1` with `products.write` in `S1`, **When** `POST /shops/S1/pickup-points {name, address, lat, lng, openingHours?}`, **Then** `201` with `{id, shopId, name, address, lat, lng, openingHours, active: true, version: 1, createdAt, updatedAt}`; one row exists whose location equals the posted coordinates (round trip within 1 m); one `pickup.point_changed` outbox row exists in the same transaction with `active: true`, `pointVersion: 1`.
2. **AS-11** (create validation classes) — **Given** the endpoint, **When** called with each of: `name` empty, blank after trimming or longer than 120; `address` empty or longer than 300; `lat` or `lng` missing, non-numeric or out of range; `openingHours` malformed (unknown timezone, unknown day, time not `HH:mm`, `close` not after `open`, overlapping intervals, more than 3 intervals a day); an unknown field; `shopId` not a UUID, **Then** each answers `400 validation_failed` naming the field, and no row and no outbox row is written; names and addresses are stored trimmed; `openingHours` omitted is stored as `{}`.
3. **AS-12** (access control and cross-tenant) — **Given** the shop-scoped endpoints (create, update, list points, list stock, set stock, adjust stock), **When** called without credentials, **Then** `401`; **When** `U2` (member of `S2` only) calls any with `S1`'s ID or a point of `S1`, **Then** `404 shop_not_found` and nothing changes; **When** `V1` (viewer) writes, **Then** `403 permission_denied`, and **When** `V1` reads, **Then** `200`; **When** `S1` is suspended, **Then** writes answer `403 shop_suspended` (S03's status gate); **When** `U1` addresses a point that belongs to `S2` through `/shops/S1/…`, **Then** `404 pickup_point_not_found` (the shop is in every predicate).
4. **AS-13** (point limit) — **Given** `S1` has 99 points, **When** two creates run at once (`Promise.all`), **Then** exactly one answers `201` and the other `409 pickup_point_limit_reached`; the shop has exactly 100 points; **When** a deactivated point exists, **Then** it still counts toward the limit.
5. **AS-14** (update point) — **Given** a point, **When** `PATCH /shops/S1/pickup-points/:pointId {name?, address?, openingHours?, active?}`, **Then** `200` with the new state, `version` increased by one, one `pickup.point_changed` outbox row with the new `pointVersion`; **When** the body carries `lat`, `lng` or `shopId`, **Then** `400 validation_failed` (a point never moves; create a new one); **When** the body is empty, **Then** `400`.
6. **AS-15** (active ↔ inactive) — **Given** an active point holding stock, **When** `PATCH {active: false}`, **Then** `200`, `active: false`, one event; the point disappears from search, browse and clusters after the index has caught up; **When** `PATCH {active: false}` again, **Then** `200` unchanged: no version bump, no event; **When** a stock set or adjust targets the inactive point, **Then** `409 pickup_point_inactive` and the stock is unchanged; **When** `PATCH {active: true}`, **Then** it reappears with its old stock.
7. **AS-16** (set stock) — **Given** a point and a product `A` of `S1`, **When** `PUT /shops/S1/pickup-points/:pointId/stock/A {quantity: 4}`, **Then** `200 {pickupPointId, productId, quantity: 4, version: 1}`; the stock row exists; one `pickup.stock_changed` outbox row exists in the same transaction with `quantity: 4`, `stockVersion: 1`; **When** `quantity: 9`, **Then** `version: 2` and a second event.
8. **AS-17** (idempotent set) — **Given** stock `A` = 4 at version 2, **When** the same `PUT {quantity: 4}` is repeated (client retry), **Then** `200` with `version: 2`, no new event, no row change.
9. **AS-18** (stock validation and ownership) — **Given** the stock endpoint, **When** called with `quantity` negative, fractional, missing, a string or above 1 000 000, **Then** `400 validation_failed`; **When** `productId` is a product of `S2` or an unknown ID, **Then** `404 product_not_found` (the catalog is asked with the shop filter; no existence leak across shops) and no row is written; **When** the point ID is unknown or another shop's, **Then** `404 pickup_point_not_found`; **When** an archived product of `S1` is set, **Then** `200` (sellers may prepare stock) but the offer stays invisible (AS-06).
10. **AS-19** (optimistic version) — **Given** stock `A` at version 3, **When** `PUT {quantity: 1, expectedVersion: 2}`, **Then** `409 stock_version_conflict` with `currentVersion: 3` and no change; **When** two `PUT`s with `expectedVersion: 3` and different quantities run at once, **Then** exactly one answers `200` (version 4) and the other `409`; **When** `expectedVersion: 0` is sent for a (point, product) with no row, **Then** the row is created at version 1; without `expectedVersion` the set is last-writer-wins and every accepted write still gets a unique, increasing version.
11. **AS-20** (adjustments and retry safety) — **Given** stock `A` = 5, **When** `POST /shops/S1/pickup-points/:pointId/stock/A/adjustments {delta: -1}` with `Idempotency-Key: k1`, **Then** `200 {quantity: 4, version, applied: true}` and one event; **When** the same request repeats with `k1`, **Then** the stored status and body are returned with `Idempotency-Replayed: true`, stock stays 4 and no second event exists; **When** `k1` is reused with `{delta: -2}`, **Then** `422`; **When** a request with `k1` is still running, **Then** `409`; **When** the header is missing, **Then** `422`; keys live 24 hours; **When** `delta` is `0`, fractional, or beyond ±100 000, **Then** `400 validation_failed`.
12. **AS-21** (never below zero, concurrent) — **Given** stock `A` = 5, **When** ten `adjustments {delta: -1}` with ten different keys run at once, **Then** exactly five answer `200`, five answer `409 insufficient_pickup_stock {available: 0}`, the final quantity is 0, the versions of the five applied changes are the unique values 2…6, and exactly five `pickup.stock_changed` rows exist; **When** a `+1` pushes the quantity above 1 000 000, **Then** `409 stock_limit_exceeded` and nothing changes.
13. **AS-22** (atomic with its event) — **Given** a stock change, **When** the outbox append fails inside the transaction (forced), **Then** the stock row is unchanged, no event exists, the caller gets a generic retryable `503` with no internal message, and a retry with the same idempotency key succeeds once.
14. **AS-23** (seller listings) — **Given** `S1` has 45 points (some inactive, some without stock) and `S2` has 3, **When** `GET /shops/S1/pickup-points?limit=20&cursor=…` is paged, **Then** only `S1`'s 45 points arrive (inactive included, `active` shown), ordered by `createdAt` descending then `id` descending, each exactly once, with an opaque `nextCursor`; `GET /shops/S1/pickup-points/:pointId/stock` lists that point's `{productId, quantity, version, updatedAt}` rows in the same paged form.

---

### User Story 3 — Search results follow the exact store, in order, within a bounded delay (Priority: P1)

Stock, point, product and shop changes reach the search index without being lost, doubled or applied out of order; a burst becomes one write; the index can be rebuilt by replay.

**Why this priority**: eventual consistency is only acceptable when its bounds and its repair are proven.

**Independent Test**: record events, deliver them shuffled and twice, compare the index with the exact store.

**Acceptance Scenarios**:

1. **AS-24** (stock reaches the index) — **Given** a point and product `A` with no offer, **When** stock is set to 4, **Then** after the index has caught up the offer is visible with `quantity: 4` and the product's current title, category, `priceMinor` and `currency`; **When** stock goes to 0, **Then** the offer is gone from search, browse-by-product and clusters; **When** stock goes back to 2, **Then** it is back.
2. **AS-25** (out-of-order stock events) — **Given** stock events `v1` (quantity 5) and `v2` (quantity 0) for one (point, product), **When** `v2` is delivered, then `v1` late, **Then** the index still has no offer; **When** `v1` and `v2` are delivered in either order and more than once, **Then** the final state equals the state of the exact store (`v2`).
3. **AS-26** (duplicate and invalid messages) — **Given** each consumer of this capability (stock, point, product, shop events), **When** the same message is delivered twice, **Then** the index and every table hold exactly one effect; **When** a payload fails its schema, has an unknown `type`, or an unsupported schema version, **Then** it is rejected without side effects, dead-lettered with the reason, and the next message is processed.
4. **AS-27** (burst coalescing) — **Given** 30 stock edits of one (point, product) in one second, **When** the consumer processes the batch, **Then** one index write is issued for that (point, product) and the final index state equals the last accepted version.
5. **AS-28** (point changes) — **Given** an indexed point, **When** `pickup.point_changed` arrives with a new name, address or `active: false`, **Then** every offer of that point shows the new name and address or disappears after the index has caught up; **When** a lower `pointVersion` arrives later, **Then** it is ignored; a stock event that arrives for a point already seen inactive does not make its offers visible.
6. **AS-29** (product changes) — **Given** product copies built from `catalog.product_created|updated|archived|restored|deleted`, **When** `A`'s title and price change (`productVersion` 2), **Then** every offer of `A` shows the new title and `priceMinor` after the index has caught up; **When** an event with `productVersion` 1 arrives later, **Then** it is ignored; **When** `A` is archived, becomes sandbox, then restored, **Then** its offers disappear and reappear; **When** `catalog.product_deleted` arrives, **Then** all stock rows of `A` are removed, one `pickup.stock_changed {quantity: 0}` is emitted per removed row, and the offers are gone; **When** an event arrives for a product with no pickup stock, **Then** it is ignored without any write.
7. **AS-30** (shop changes) — **Given** `S1` with offers, **When** `tenancy.shop_status_changed {to: SUSPENDED}` arrives, **Then** its offers disappear after the index has caught up; **When** a later event reinstates it (`to: ACTIVE`), **Then** they reappear; an older `shopVersion` is ignored; **When** `tenancy.shop_deleted` arrives, **Then** all points of `S1` become inactive (one `pickup.point_changed` each), stock is retained, and nothing of `S1` is visible; repeating it changes nothing.
8. **AS-31** (replay rebuilds the index) — **Given** a populated index and the full set of events, **When** the index is emptied and every event is replayed in a random order (twice), **Then** the index equals the one built live, document for document.
9. **AS-32** (stale search, exact check) — **Given** `A` at `KREUZBERG` with stock 2 indexed and a stock change to 0 committed but not yet consumed, **When** a shopper searches, **Then** the stale offer is still shown (eventual consistency), and **When** `checkAvailability` is called for `KREUZBERG`, **Then** it reports a shortage immediately (see AS-33).

---

### User Story 4 — Reservation-time exact check (Priority: P2)

A later checkout step asks "does this point really hold these quantities right now?" and gets an exact answer, not an index guess.

**Why this priority**: it bounds the damage of the index's staleness; no consumer exists yet, so it follows the shopper and seller stories.

**Independent Test**: call the service for matching, short, unknown and inactive cases.

**Acceptance Scenarios**:

1. **AS-33** (exact batch check, R1) — **Given** `PickupAvailabilityService.checkAvailability(pickupPointId, lines)` and a point with `A` = 3, `B` = 0, **When** called with `[{A, 2}]`, **Then** `{available: true, shortages: []}`; with `[{A, 5}, {B, 1}, {C, 1}]` (`C` has no row), **Then** `{available: false, shortages: [{productId: A, requested: 5, available: 3}, {B, 1, 0}, {C, 1, 0}]}`; for an inactive point, **Then** `{available: false, reason: 'pickup_point_inactive'}`; for an unknown point, **Then** it throws `PickupPointNotFoundError`; one statement is issued for the whole batch; 51 lines, a quantity `< 1`, a non-UUID or duplicate product IDs throw `InvalidAvailabilityRequestError`.

---

### User Story 5 — A shopper pans a map and sees clusters of points with stock (Priority: P2)

The map shows, for the visible area, groups of pickup points that hold stock, sized to the zoom level, so a city view is not 5 000 pins.

**Why this priority**: a visual alternative to the list; the same data and rules.

**Independent Test**: load one viewport at zoom 3, 8 and 14 with the same data and compare totals.

**Acceptance Scenarios**:

1. **AS-34** (viewport clusters) — **Given** in-stock offers at `MITTE`, `KREUZBERG` and `SPANDAU` and out-of-stock offers elsewhere, **When** `GET /pickup-points/clusters?bbox=top,left,bottom,right&zoom=10` covers Berlin, **Then** `200 {cells: [{cellId, offers, pickupPoints, lat, lng}], truncated: false}`; `offers` counts in-stock (point, product) pairs and `pickupPoints` counts distinct points with at least one in-stock offer (exact up to 1 000 per cell); `lat`, `lng` are the centroid of the points in the cell; offers outside the box, out of stock, or invisible by AS-06 are not counted.
2. **AS-35** (zoom) — **Given** the same data, **When** the zoom goes from 3 to 8 to 14, **Then** the number of cells never decreases, the sum of `offers` over all cells is the same at every zoom for the same viewport, a cell at zoom `z` never overlaps two cells of zoom `z − 1`, and `zoom` outside the integers `0…20` answers `400 validation_failed` (`zoom` defaults to 10).
3. **AS-36** (product filter and drill-in) — **Given** `productId = A` is passed, **When** clusters load, **Then** only offers of `A` count; **When** a cell holds exactly one point, **Then** the cell carries `pickupPointId`; with more than one point it is absent.
4. **AS-37** (bbox validation) — **Given** the endpoint, **When** `bbox` is missing, has other than four numbers, has a latitude outside `[-90, 90]` or a longitude outside `[-180, 180]`, or `top ≤ bottom`, **Then** `400 validation_failed` naming `bbox`; **When** `left > right` (a viewport that crosses the antimeridian), **Then** it is accepted and counts offers on both sides of ±180°.
5. **AS-38** (cell cap) — **Given** a viewport and zoom that would produce more than 500 cells, **When** clusters load, **Then** at most 500 cells are returned, those with the highest `offers` (ties by `cellId`), and `truncated: true`; totals of the omitted cells are not invented.
6. **AS-39** (caching, limits, failure) — **Given** a successful response, **Then** it carries `Cache-Control: public, s-maxage=30` and no cookies; **Given** the policy `fulfilment.map-clusters` (300 per minute per client address, fail open), **When** exceeded, **Then** `429 rate_limited` with `Cache-Control: no-store`; **When** the search index fails (forced), **Then** `503 search_unavailable` with `Cache-Control: no-store`.

---

### User Story 6 — A shopper browses the exact list of points around them (Priority: P2)

For a precise "which stores are near me, and which hold this product", the shopper gets points ordered by exact distance from the source of truth, with a hard cap on work.

**Why this priority**: the map and search are approximate by design; this is the exact view.

**Independent Test**: points at 3 km, 4.95 km, 5.05 km and 12 km; radius 5 and 20.

**Acceptance Scenarios**:

1. **AS-40** (exact distance and order) — **Given** points at about 0.5, 3, 4.95, 5.05 and 12 km, **When** `GET /pickup-points/near?lat&lng&radiusKm=5`, **Then** the first three are returned in that order with `distanceM` equal to the spheroid distance within 1 m, the 5.05 km point is excluded, and equal distances break on `id`; inactive points and points of non-`ACTIVE` shops are excluded.
2. **AS-41** (product filter) — **Given** `productId = A` is stocked at two of the three nearby points, **When** browsing with `productId=A`, **Then** only those two return, each with `quantity` (> 0) of `A`; without `productId` no `quantity` field is returned; a `productId` that is not a UUID answers `400`.
3. **AS-42** (limits, pagination, validation) — **Given** 60 points within 5 km, **When** `limit=50` (maximum) and the `nextCursor` are used, **Then** pages of 50 and 10 arrive without gap or repeat; `lat`, `lng`, `radiusKm` (0.1–50), `limit` and `cursor` follow the validation classes of AS-04; the same anonymous access, response contract and rate-limit policy as AS-07 and AS-08 apply.
4. **AS-43** (bounded work) — **Given** the exact store is slow (forced beyond its 2-second statement limit), **When** a shopper browses, **Then** `503 service_unavailable` with a generic `detail`, and the slow statement is cancelled in the store (no leaked work).

---

### User Story 7 — The data stays inside its domain and the system can be operated (Priority: P3)

The domain touches only its own tables, learns about other domains only through approved paths, and explains itself in metrics and logs.

**Why this priority**: it makes the near-me capability extractable and debuggable; users do not see it directly.

**Independent Test**: the static ownership check, a constraint listing, and the metrics endpoint.

**Acceptance Scenarios**:

1. **AS-44** (no cross-domain coupling) — **Given** the finished capability, **Then** `pnpm --dir packages/backend check:table-ownership --strict` reports zero findings for the pickup part of `fulfilment`; no foreign key leaves `PickupPoint` or `PickupStock` toward `Shop` or `Product`; the pickup code imports no model of another domain and issues no query on another domain's table; product and shop data arrive only as R1 calls (AS-18, AS-33) and R3 events (AS-29, AS-30).
2. **AS-45** (observability) — **Given** traffic through every endpoint and consumer, **Then** metrics exist for search and cluster latency by outcome, 429 and 503 counts, index lag in seconds (commit time of the newest applied event versus now), consumer lag, dead-lettered messages, stock changes by kind (set, adjust, rejected) and index write failures; every log line carries `requestId` or `traceId`; no log line holds a full address, coordinates of a shopper, or a request body.

### Edge Cases

- **Radius exactly on the boundary**: a point at exactly `radiusKm` is included (distance `≤` radius).
- **Shopper coordinates in the sea or at a pole**: valid; the result is empty, not an error. Poles and the antimeridian are accepted by validation (AS-37 for the box; search and browse measure along the sphere).
- **Product copy missing when stock arrives**: the offer is not indexed until the copy exists; a stock set seeds the copy from the catalog (FR-031), so this only happens for a product deleted in between, in which case the offer stays absent (AS-29).
- **Two events for different aggregates racing**: a product archive and a stock event for the same product may arrive in either order; the final visibility is the same (AS-29, AS-31).
- **Re-creating a deleted product's ID**: not possible (IDs are never reused); the stock events of a deleted product are ignored.
- **A point with 10 000 stock rows deactivated**: one point event updates all its offers; no per-row event is required.
- **Search index mapping missing at start-up**: it is created idempotently; concurrent starters do not fail.

## Requirements *(mandatory)*

### Functional Requirements

**Pickup points**

- **FR-001**: A shop member with `products.write` MUST be able to create a pickup point with `name` (1–120 chars after trimming), `address` (1–300), `lat`, `lng` and optional `openingHours`, receiving `201` with the full point; the point and one `pickup.point_changed` event are written in one transaction (AS-10).
- **FR-002**: `openingHours` MUST be `{}` or `{timezone: IANA zone, weekly: {mon…sun: [{open: "HH:mm", close: "HH:mm"}] (≤ 3 intervals per day, close after open, no overlap)}}`; anything else is `400` (AS-11).
- **FR-003**: A shop MUST NOT have more than 100 points (active or not); the limit holds under concurrency (AS-13).
- **FR-004**: A point's name, address, opening hours and active flag MUST be editable; its location and shop MUST NOT change; every accepted change bumps `version` by one and emits `pickup.point_changed`; a change that alters nothing is a no-op without event (AS-14, AS-15).
- **FR-005**: Deactivating a point MUST hide all its offers from search, browse and clusters; stock writes to an inactive point MUST be refused with `409 pickup_point_inactive`; reactivating restores visibility with the retained stock (AS-15).
- **FR-006**: A member MUST be able to list the shop's points (cursor-paged, `createdAt` desc, `id` desc, inactive included) and a point's stock rows (AS-23).

**Local stock**

- **FR-010**: `PUT …/stock/:productId {quantity, expectedVersion?}` MUST upsert absolute stock in `0…1 000 000`, bump the row `version` by one only when the quantity changes, and write one `pickup.stock_changed` event in the same transaction (AS-16, AS-17).
- **FR-011**: A set with `expectedVersion` MUST succeed only if it equals the current version (`0` = no row), else `409 stock_version_conflict {currentVersion}`; under concurrent writes every accepted write gets a unique increasing version (AS-19).
- **FR-012**: `POST …/stock/:productId/adjustments {delta}` MUST apply a relative change atomically with a store-level guarantee that quantity stays in `0…1 000 000`; a change that would break it answers `409 insufficient_pickup_stock` or `409 stock_limit_exceeded` and changes nothing; with concurrent decrements exactly as many succeed as stock allows (AS-21).
- **FR-013**: Adjustments MUST require `Idempotency-Key` (V.6): replay returns the stored status and body; in flight `409`; different body `422`; missing `422`; 24-hour TTL (AS-20).
- **FR-014**: The product of a stock write MUST belong to the addressed shop, checked through the catalog with the shop filter; otherwise `404 product_not_found` (AS-18). Archived products accept stock.
- **FR-015**: Every endpoint of this capability that touches a point or a stock row MUST include the shop in the lookup predicate (cross-shop answers `404`) and MUST answer `401` without credentials, `403` for a role without the permission, and the shop-status gate of S03 (AS-12).
- **FR-016**: A stock or point write and its event MUST commit together or not at all; a failure of the event leaves no change (AS-22).

**Search, browse and clusters**

- **FR-020**: `GET /search/near` MUST return products with at least one visible in-stock offer within the radius, one item per product, each with its nearest in-stock point and distance in metres, ordered by relevance then distance (with `q`) or by distance (without), cursor-paged (AS-01, AS-02, AS-05).
- **FR-021**: A point of an offer within the radius MUST be found regardless of which map cell it lies in (AS-03, AS-40).
- **FR-022**: Query parameters MUST be validated strictly: `lat`, `lng`, `radiusKm` (0.1–50, default 5), `q` (≤ 100, blank = absent), `limit` (1–50, default 20), `cursor`, `productId` (UUID), with unknown parameters refused (AS-04, AS-42).
- **FR-023**: An offer is visible only if: stock `> 0`; its point is active; its shop is `ACTIVE`; its product exists, is not `ARCHIVED` and is not sandbox (AS-06). The rule is one pure function used by every read path.
- **FR-024**: Search and clusters MUST be served from the search index only; when it is unavailable or slower than 800 ms they answer `503 search_unavailable` and never fall back to the exact store (AS-09, AS-39).
- **FR-025**: `GET /pickup-points/near` MUST be served from the exact store: points within the radius ordered by exact spheroid distance then `id`, optional `productId` filter returning `quantity`, cursor-paged, `limit ≤ 50`, with a 2-second statement limit (AS-40–AS-43).
- **FR-026**: `GET /pickup-points/clusters` MUST return per-cell `offers`, distinct `pickupPoints`, centroid, `pickupPointId` for single-point cells, optional `productId` filter, zoom `0…20`, at most 500 cells with `truncated`, antimeridian-crossing boxes accepted (AS-34–AS-38).
- **FR-027**: The three read endpoints MUST be anonymous-capable, rate-limited by the policies `fulfilment.near-search` (search and browse) and `fulfilment.map-clusters`, answer `429` over the limit and fail open if the limiter store is down; clusters set `Cache-Control: public, s-maxage=30` on success only (AS-08, AS-39).
- **FR-028**: Responses MUST be explicit DTOs parsed by the contracts schemas; prices are `priceMinor` + `currency`; no model, no internal field (AS-07).

**Freshness and read model (IX.7 R3)**

- **FR-030**: Stock, point, product and shop changes MUST reach the search index idempotently and in version order: a message older than what the index holds is ignored, duplicates have one effect, bursts per (point, product) coalesce into one write (AS-24–AS-30).
- **FR-031**: Product fields shown in results (`title`, `category`, `priceMinor`, `currency`, `status`, `isSandbox`, `productVersion`) MUST come from a copy kept by this domain, built from the catalog's events and seeded from the catalog's batch read when a stock row is first written for a product; the copy is never written back and the domain never reads the catalog's table (AS-29, AS-44).
- **FR-032**: Shop visibility (`ACTIVE` or not) MUST come from a copy built from S03's events; `shop_deleted` deactivates all the shop's points (AS-30).
- **FR-033**: `catalog.product_deleted` MUST remove the product's stock rows with one `pickup.stock_changed {quantity: 0}` per row (AS-29).
- **FR-034**: Every consumer MUST validate its payload with a schema, be idempotent by version guard (documented in the plan), and dead-letter poison messages (AS-26).
- **FR-035**: The index MUST be rebuildable from the events alone, in any order, with the same result (AS-31).
- **FR-036**: Maximum accepted staleness between a committed change and its visibility in search: 95 % within 5 seconds, 99.9 % within 30 seconds; the index lag is measured and exported (AS-45). The exact check and the exact browse are never stale.

**Exact check (IX.7 R1)**

- **FR-040**: The domain MUST export `PickupAvailabilityService.checkAvailability` (shape in Cross-capability contracts) reading the exact store, in one statement for ≤ 50 lines (AS-33).

**Isolation, errors and operations**

- **FR-050**: The domain MUST own only its tables, hold no foreign key to another domain's table, issue no query on another domain's table, import no other domain's model, and use only R1 (catalog batch read, tenancy checks), R3 (events into its own copies) and the outbox service (AS-44).
- **FR-051**: Every error MUST be `application/problem+json` with the stable codes named in the scenarios; for any 5xx the `detail` is generic (AS-09, AS-22, AS-43).
- **FR-052**: The domain MUST export metrics and structured logs as in AS-45 and MUST NOT log coordinates of shoppers, full addresses or bodies.
- **FR-053**: All time reads (idempotency TTL, timestamps, event `occurredAt`, lag) MUST go through the clock so tests can freeze it.

### Key Entities

- **Pickup point**: a physical place of one shop: name, address, location, opening hours, active flag, version, creation and update times.
- **Pickup stock**: units of one product at one point: quantity (0 – 1 000 000), version that increases with every change; identified by (point, product).
- **Stock adjustment record**: an idempotency record for one relative change: key, request fingerprint, stored response, expiry.
- **Availability offer**: one searchable record per (point, product) with stock: product copy, point copy, shop visibility, quantity, location, the versions of each source.
- **Product copy**: the catalog fields this domain shows (title, category, price, currency, status, sandbox flag, product version), keyed by product ID; built from events, never written back.
- **Shop visibility copy**: shop ID, status, shop version; built from events.
- **Map cell**: a zoom-dependent area of the map in a viewport with offers, distinct points and a centroid.

## Cross-capability contracts

**Provides**

- HTTP (all under the global prefix `/api`; error codes as in the scenarios):
  - `POST /shops/:shopId/pickup-points` (201), `GET /shops/:shopId/pickup-points?limit&cursor`, `PATCH /shops/:shopId/pickup-points/:pointId`, `GET /shops/:shopId/pickup-points/:pointId/stock?limit&cursor`, `PUT /shops/:shopId/pickup-points/:pointId/stock/:productId` (body `{quantity, expectedVersion?}`), `POST /shops/:shopId/pickup-points/:pointId/stock/:productId/adjustments` (header `Idempotency-Key`, body `{delta}`). Writes need `ShopScoped('products.write')`, reads `ShopScoped('products.read')`.
  - Public (anonymous allowed): `GET /search/near?lat&lng&radiusKm&q&limit&cursor` → `{items: [{productId, title, category, priceMinor, currency, nearest: {pickupPointId, name, distanceM, quantity}}], nextCursor}`; `GET /pickup-points/near?lat&lng&radiusKm&productId&limit&cursor` → `{items: [{id, shopId, name, address, lat, lng, distanceM, openingHours, quantity?}], nextCursor}`; `GET /pickup-points/clusters?bbox=top,left,bottom,right&zoom&productId` → `{cells: [{cellId, offers, pickupPoints, lat, lng, pickupPointId?}], truncated}`. **Consumers: W02 and the product-page BFF aggregate S48 (`/pickup-points/near?productId=` and `/search/near`, IX.7 R2), J04 (HTTP only).**
- `PickupAvailabilityService` (R1): `checkAvailability(pickupPointId: PickupPointId, lines: { productId: ProductId; quantity: number }[] /* 1–50, quantity ≥ 1, unique products */): Promise<{ available: boolean; reason?: 'pickup_point_inactive'; shortages: { productId: ProductId; requested: number; available: number }[] }>`; throws `PickupPointNotFoundError`, `InvalidAvailabilityRequestError`. Reads the exact store. **Consumers: none today; for a later pickup checkout.**
- Events (outbox → topic `pickup.events`, key = aggregate ID; envelope `{eventId, type, version: 1, occurredAt, aggregateId}`; schemas in `packages/contracts`):
  - `pickup.stock_changed` v1, aggregate `<pickupPointId>:<productId>`: `{pickupPointId, productId, shopId, quantity, stockVersion, lat, lng}`; `stockVersion` is strictly increasing per aggregate. Emitted once per accepted change, including removals (`quantity: 0`).
  - `pickup.point_changed` v1, aggregate `pickupPointId`: `{pickupPointId, shopId, name, address, lat, lng, active, pointVersion}`; strictly increasing `pointVersion`. Emitted on create, every effective update, and shop deletion.
  - **Consumers: this capability's own projector; no other capability depends on them yet.**
- Rate-limit policies (declared in S50's registry): `fulfilment.near-search` 120/minute per user or client address (fail open); `fulfilment.map-clusters` 300/minute per client address (fail open).
- Modules for the apps: `PickupModule` (core: HTTP, `PickupAvailabilityService`), `PickupProjectorModule` (projector: the consumers). Nothing else is exported: no model, repository, `PickupService`, `AvailabilityIndex` or projector class.

**Requires**

- **S05** (`catalog`): `ProductQueryService.getProductsByIds(ids ≤ 500, { shopId })` returning `{id, shopId, title, category, priceMinor, currency, status: 'ACTIVE' | 'ARCHIVED', isSandbox, version}`; unknown or other-shop IDs absent. Events `catalog.product_created|updated|archived|restored` v1 `{productId, shopId, title, category, priceMinor, currency, status, isSandbox, productVersion, …}` and `catalog.product_deleted` v1 `{productId, shopId, productVersion}` on `products.events`, key `productId`.
- **S03** (`tenancy`): `ShopScoped(permission)` with `products.read` and `products.write` and the status gate (`403 shop_suspended`); events `tenancy.shop_status_changed` v1 `{shopId, from, to, reason?, shopVersion}` and `tenancy.shop_deleted` v1 `{shopId}`.
- **S01** (`identity`): `Firewall({ anonymous })`, `@User()`.
- **S53**: `outbox.append(event)` inside the domain's transaction; consumer framework (envelope check, schema validation, coalescing, own consumer group, DLQ, version guard).
- **S50**: the two policies above; **S54**: problem+json filter with `code`, idempotency facility (V.6), clock, metrics registry, request context.
- Search index client (generic, `libs/infrastructure/elasticsearch`): `search`, `bulk`, `indices.create`, with a per-call timeout. The pickup index mapping and queries live in this domain's `infra/` (debt D-16).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 99 % of "available near me" searches and map views answer in under 80 ms server time at 20 000 requests per second.
- **SC-002**: A stock, point, product or shop change is visible to shoppers within 5 seconds for 95 % of changes and within 30 seconds for 99.9 %.
- **SC-003**: Ten concurrent in-store sales against 5 units record exactly 5 sales and never a negative stock, in every run.
- **SC-004**: A retried stock adjustment never counts twice: 100 % of replays with the same key leave stock unchanged.
- **SC-005**: 100 % of attempts to read or change another shop's points or stock are refused without revealing whether the item exists.
- **SC-006**: A shopper sees a product as available only if a seller put it in stock; after the exact check at reservation, at most one out of 1 000 shown offers is found short (staleness bound).
- **SC-007**: A map view of any area returns at most 500 cells, and the offers over all cells match the offers in the viewport.
- **SC-008**: Rebuilding the search index from events yields an index identical to the live one (zero differing documents).
- **SC-009**: The static ownership check reports zero cross-domain findings for the pickup part of the domain.

## Assumptions

- Search and browse locations come from the shopper's device or a typed place resolved by the client; geocoding of addresses is out of scope (the seller supplies coordinates).
- Opening hours are stored and returned but there is no "open now" filter or ranking in this release (the notes name it as optional ranking; it needs a time zone design that belongs with S49/S28's date rules).
- A point never moves (location immutable); changing a store's place means creating a new point.
- Local pickup stock is independent of the catalog's own `quantity`; a catalog stock change (including an offline-store sale, S09) does not change pickup stock. J04 reaches "available near me" through this capability's HTTP stock endpoints.
- Quantity is shown exactly in results; no privacy bucketing.
- Maximum accepted staleness (R3): 30 seconds (99.9 %); stated in `plan.md`.
- `products.write` and `products.read` are the permissions of S03's matrix; no new permission is introduced.
- The exact browse reads the exact store directly and is the only shopper-facing read allowed to do so, protected by the rate limit, `limit ≤ 50`, `radiusKm ≤ 50`, and a 2-second statement limit.
- Search degradation is a clear `503`, not a fallback to the exact store, because the exact store is sized for writes and exact checks, not 20 000 RPS.
- The projector may read this domain's own tables (stock, points) when rebuilding documents; it never reads another domain's.
- Deleting a shop deactivates its points and keeps stock (the purge of the shop's data follows S03's retention rules in a later release).
- Order placement with a pickup point, reservation, and collection are not modelled (S10 has no pickup choice).
