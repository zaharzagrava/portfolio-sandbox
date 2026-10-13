---

description: "Task list for S19 — Pickup points, local stock, available near me, map clustering"
---

# Tasks: S19 — Pickup Points, Local Stock, "Available Near Me", Map Clustering

**Input**: `specs/domains/S19-pickup-near-me/` (spec.md, plan.md, test-plan.md, gaps.md, questions.md defaults, research.md, data-model.md, contracts/pickup-api.md, quickstart.md); constitution v3.1.0.

**Tests**: Required (test-plan.md, VII.8). Test-first: for every test-plan.md row the failing test task comes before the code task that makes it pass. L-003: no "A or B" assertions. L-005/L-006: each test creates its own data (stock through `createIsolatedProduct`). L-017: scenarios, not files, must survive.

**Path shorthand**: `F` = `packages/backend/libs/domains/fulfilment`; `K` = `packages/contracts/src/fulfilment/pickup.ts`. Backend commands run from `packages/backend`; e2e through `/opt/sdd/repo/scripts/sdd/test-spec.sh <pattern>`. After 5 failed fixes of the same test: stop and write the blocker into `questions.md`.

**Rules for every task**: no `git checkout/restore/reset/stash/clean` (undo by hand); no new `sequelize.transaction` (use `TransactionRunner.run`); never create/edit `*.reviewed.json`; do not edit sibling specs (use gaps.md "Sibling-spec follow-ups"); the `dispatch.service.ts` `// S54 T037 audit` site is S20's, leave it.

## Format: `- [ ] Tnnn [P?] [USn] Description with file path`

---

## Phase 1: Setup

- [X] T001 Living spec first (rule 0): write `docs/spec/capabilities/S19-pickup-near-me.md` with rules R-nn and `[proof: S19 AS-nn]` / `[code: …]` anchors for the 45 scenarios; run `python3 scripts/livespec/check.py`; create no `*.reviewed.json`. **Page written; `check.py` run: 0 errors.**
- [X] T002 Run `pnpm --dir packages/backend check:table-ownership` and compare its `fulfilment` lines with gaps.md §C; record differences in gaps.md §C (gaps §D step 1; `.ownership.baseline` = 1).
- [X] T003 Read the real S05 `catalog.product_*` payloads (`product-events.ts`/contracts), the compacted-topic tombstone shape and S03 `tenancy.shop_*` payloads; write exact field names into `specs/domains/S19-pickup-near-me/research.md` R-3/R-4 before coding handlers (plan risks a, b).
- [X] T004 Skeleton the five failing e2e files in `F/` with the `describe` names of test-plan.md: `pickup-points.e2e-spec.ts`, `pickup-stock.e2e-spec.ts`, `pickup-search.e2e-spec.ts`, `pickup-clusters.e2e-spec.ts`, `pickup-availability-projector.e2e-spec.ts`; add shared fixtures `F/testing/pickup-fixtures.ts` (users U1/V1/U2, shops S1/S2, products A/B/C/X via exported services and fixtures, points KREUZBERG/SPANDAU/MITTE, frozen clock, consumer runner over outbox rows). No `ProductModel`/`ShopModel` import (D-7, A21). Confirm A1 (cross-tenant stock write) fails first. Keep old `F/pickup.e2e-spec.ts` until T067.

---

## Phase 2: Foundational (blocks all stories)

### Contracts, policies, errors, metrics

- [X] T005 Extend `K` with zod schemas (A24, FR-028): point create body (name trimmed 1–120, address trimmed 1–300, lat/lng ranges, `openingHours`, strict: unknown field refused) and patch body (≥ 1 key; `lat`/`lng`/`shopId` refused), point response, stock set body (`quantity` int 0…1000000, `expectedVersion` int ≥ 0 optional), adjustment body (`delta` int ≠ 0, ±100000), stock responses, `pickupPointsNearResponseSchema` (`{items, nextCursor}`, `quantity` only with `productId`), search-near response (`priceMinor`, `currency`, `nearest{pickupPointId,name,distanceM,quantity}`), cluster response (`{cells{cellId,offers,pickupPoints,lat,lng,pickupPointId?}, truncated}`), strict query schemas (`limit` 1–50, `radiusKm` 0.1–50, `zoom` 0–20, `bbox`), event payload schemas for `pickup.stock_changed` / `pickup.point_changed` v1.
- [X] T006 [P] Add problem+json error classes with stable codes in `F/domain/pickup-errors.ts` extending the platform `DomainError`: `PickupPointNotFoundError` (404 `pickup_point_not_found`), `ProductNotFoundError` (404 `product_not_found`), `PickupPointInactiveError` (409 `pickup_point_inactive`), `PickupPointLimitReachedError` (409 `pickup_point_limit_reached`), `StockVersionConflictError` (409 `stock_version_conflict`, `currentVersion`), `InsufficientPickupStockError` (409 `insufficient_pickup_stock`, `available`), `StockLimitExceededError` (409 `stock_limit_exceeded`), `InvalidAvailabilityRequestError`, `SearchUnavailableError` (503 `search_unavailable`, `Retry-After`), `ServiceUnavailableError` (503 `service_unavailable`); 5xx `detail` generic (A14, FR-051).
- [X] T007 [P] Declare `fulfilment.near-search` (120/min per user or client address, fail open) and `fulfilment.map-clusters` (300/min per client address, fail open) with `definePolicies('fulfilment', …)` in `F/rate-limit-policies.ts`, registered by `RateLimitModule.forFeature` (A12, S50 follow-up).
- [X] T008 [P] Define `pickup_*` metrics with fixed-enum labels in `F/infra/pickup-metrics.ts`: `pickup_search_duration_seconds` by outcome, `pickup_index_lag_seconds`, DLQ count, stock changes by kind, rate-limit fallback counter (A20, FR-052).

### Pure domain (each unit spec fails first, then the code makes it green: `pnpm jest libs/domains/fulfilment/domain/<name>`)

- [X] T009 [P] Unit spec `F/domain/opening-hours.spec.ts` (`it.each`): timezone, day names, `HH:mm`, order, overlap, ≤ 3 intervals, default `{}` (A5, AS-11).
- [X] T010 Implement `F/domain/opening-hours.ts` (pure) until T009 is green.
- [X] T011 [P] Unit spec `F/domain/stock-rules.spec.ts`: set no-op when equal (AS-17), `expectedVersion` guard table (AS-19), adjust within `0…1000000`; `fast-check` property: quantity never leaves `0…max` for any delta sequence (AS-21) (A6).
- [X] T012 Implement `F/domain/stock-rules.ts` until T011 is green.
- [X] T013 [P] Unit spec `F/domain/offer-visibility.spec.ts`: `isOfferVisible` over every combination of stock, point active, shop status, product status, sandbox (AS-06, FR-023, A8/A9).
- [X] T014 Implement `F/domain/offer-visibility.ts`: visible ⇔ `quantity > 0 ∧ point.active ∧ shopStatus = ACTIVE ∧ productStatus ≠ ARCHIVED ∧ ¬isSandbox`.
- [X] T015 [P] Unit spec `F/domain/geo-input.spec.ts`: coordinates, radius 0.1–50, limit 1–50, blank `q` = absent, bbox (count, ranges, `top ≤ bottom`, `left > right` allowed), zoom 0–20 (AS-04, AS-35, AS-37; A10, A11).
- [X] T016 Implement `F/domain/geo-input.ts` until T015 is green.
- [X] T017 [P] Unit spec `F/domain/search-cursor.spec.ts`: encode/decode round trip, tamper, query-hash mismatch (AS-05).
- [X] T018 Implement `F/domain/search-cursor.ts` until T017 is green.
- [X] T019 [P] Unit spec `F/domain/cluster-cap.spec.ts`: sort offers desc then `cellId`, cap 500, `truncated` (AS-38).
- [X] T020 Implement `F/domain/cluster-cap.ts` until T019 is green.
- [X] T021 [P] Implement `F/domain/offer-document.ts`: pure build of the index document from stock + point + product copy + shop copy (`_id = <pointId>:<productId>`, `docVersion` = sum of the four versions); proven by AS-24/AS-31.

### Schema and ownership

- [X] T022 Expand migration `packages/backend/migrations/2026101x…-pickup-s19-expand.js` (own file, not run at app start, `lock_timeout`): `PickupPoint.version INTEGER NOT NULL DEFAULT 1`; `CHECK (quantity <= 1000000)` on `PickupStock`; table `PickupProductCopy` (`productId` UUID PK, `shopId` UUID NOT NULL, `title`/`category` TEXT NOT NULL, `priceMinor` BIGINT NOT NULL, `currency` CHAR(3) NOT NULL, `status` TEXT NOT NULL `ACTIVE|ARCHIVED`, `isSandbox` BOOLEAN NOT NULL, `version` BIGINT NOT NULL, `updatedAt`; index `(shopId)`); table `PickupShopCopy` (`shopId` UUID PK, `status` TEXT NOT NULL incl. `DELETED`, `version` BIGINT NOT NULL, `updatedAt`); keyset index `("shopId","createdAt","id")` replacing `PickupPoint_shop_idx` (A2, A25).
- [X] T023 Register `PickupProductCopy` and `PickupShopCopy` as `domain:fulfilment` in `packages/backend/db/ownership.ts` (A26); idempotency rows stay with `infrastructure:idempotency`.
- [X] T024 Contract migration `packages/backend/migrations/2026101x…-pickup-s19-contract.js` (own file, applied after the code stops relying on cascade): drop FK `PickupPoint.shopId → Shop` and `PickupStock.productId → Product` (A25, §C DDL lines); update the Sequelize models in `F/` so they declare no association to `Shop`/`Product`.

### Ports, adapters, events, modules

- [X] T025 Define ports and tokens in `F/domain/pickup-ports.ts`: `PickupPointRepository`, `PickupStockRepository`, `PickupBrowseReader`, `PickupAvailabilityIndex`, `ProductCopyStore`, `ShopCopyStore`, `CatalogProductReader` (A22, D-6).
- [X] T026 Implement `F/infra/pickup-point.repository.ts` and `F/infra/pickup-stock.repository.ts`: shop in every predicate (III.4), named replacements, fixed ORDER BY, conditional `UPDATE … WHERE version = :v`, `quantity + :delta BETWEEN 0 AND 1000000`, per-shop 100-point cap under `pg_advisory_xact_lock` (research R-5), keyset `createdAt desc, id desc`; transactions only through `TransactionRunner.run`.
- [X] T027 [P] Implement `F/infra/product-copy.store.ts` and `F/infra/shop-copy.store.ts`: version-guarded upserts (only when `version` is greater), delete on product deletion/tombstone.
- [X] T028 [P] Implement `F/infra/catalog-product.reader.ts`: ACL over `ProductQueryService.getProductsByIds(ids, {shopId})`, 500 ms budget, DTO → port type (R1, D-7).
- [X] T029 [P] Define `F/application/events/pickup-events.ts` with `defineEvent`: `pickup.stock_changed` v1 (aggregate `<pointId>:<productId>`, `{pickupPointId, productId, shopId, quantity, stockVersion, lat, lng}`) and `pickup.point_changed` v1 (aggregate `pointId`, `{pickupPointId, shopId, name, address, lat, lng, active, pointVersion}`), `carries: 'state'`, topic `pickup.events`, retention `full-history`; envelope version 1, the row version never in the envelope (A18).
- [X] T030 Implement `F/infra/availability-index.ts` on `SearchEngineClient` only (`search`, `bulk`, `indexExists`, `createIndex`; per-call `timeoutMs`, `maxRetries: 0` for reads, 5 s bulk): private index `pickup_availability` v2 mapping from data-model.md (`refresh_interval: 2s`, `index.gc_deletes: 1h`), no `getClient()`, no shared index or filter; mapping bootstrap throws (readiness fails) when the engine is unreachable (A13, A19, D-16).
- [X] T031 Create `F/pickup.module.ts` (`PickupModule`: controllers, services, port bindings, policies, `IdempotencyModule`) and `F/pickup-projector.module.ts` (`PickupProjectorModule`); rewrite `F/index.ts` to export only `PickupModule`, `PickupProjectorModule`, `PickupAvailabilityService`, DTO and event types (D-8, A23); `tsc --noEmit` passes.

**Checkpoint**: units green, migrations apply on a fresh stack, `tsc --noEmit` passes.

---

## Phase 3: User Story 2 — Seller manages pickup points and local stock (P1) 🎯 MVP

**Goal**: sellers create, edit, (de)activate points, set and adjust local stock, list both; every write is atomic with its event. Built first: the other stories need its data.

**Independent Test**: `test-spec.sh fulfilment/pickup-points` and `fulfilment/pickup-stock` green (AS-32/33 wait for US4).

### Tests first (must fail)

- [X] T032 [US2] In `F/pickup-points.e2e-spec.ts` write AS-10 (201 parsed with the contract schema, location round trip ≤ 1 m, one `pickup.point_changed` row `pointVersion: 1`) and AS-11 (`it.each` over name, address, coordinates, hours, unknown field, bad `shopId`: no row, no outbox; trimming; default `{}`).
- [X] T033 [US2] In `F/pickup-points.e2e-spec.ts` write AS-12 (`it.each` over the six shop-scoped endpoints × no token 401, other-shop member 404, viewer write 403, viewer read 200, suspended 403, cross-shop point 404) and AS-13 (99 points, two parallel creates via `Promise.all` → one 201, one 409, exactly 100 rows, inactive counted).
- [X] T034 [US2] In `F/pickup-points.e2e-spec.ts` write AS-14 (PATCH → version +1 + event; `lat`/`lng`/`shopId`/empty body 400), AS-15 (deactivate; repeat is a no-op without version or event; stock write → 409 `pickup_point_inactive`; reactivate keeps old stock), AS-23 (45 + 3 points paged by `createdAt desc, id desc`, inactive included, own shop only; stock listing paged), AS-44 (`pg_constraint` shows no FK from pickup tables to other tables).
- [X] T035 [US2] In `F/pickup-stock.e2e-spec.ts` write AS-16 (set: body, row, one `pickup.stock_changed` with `stockVersion`, second set → version 2), AS-17 (same quantity twice → no version change, no event), AS-18 (quantity classes 400; product of S2 and unknown → 404 `product_not_found`, no row; foreign point 404; archived product accepted; A1 cross-tenant write refused).
- [X] T036 [US2] In `F/pickup-stock.e2e-spec.ts` write AS-19 (stale `expectedVersion` → 409 with `currentVersion`; two parallel PUTs same version → one 200, one 409; `expectedVersion: 0` creates; increasing versions without it) and AS-20 (first call applies; replay returns stored body + `Idempotency-Replayed`; different body 422; in-flight 409 with a latch; missing key 422; TTL after clock advance; delta classes 400).
- [X] T037 [US2] In `F/pickup-stock.e2e-spec.ts` write AS-21 (stock 5, ten parallel −1 with distinct keys → five 200, five 409, final 0, versions 2…6, five events; overflow → 409 `stock_limit_exceeded`) and AS-22 (forced outbox failure → row unchanged, no event, generic 503, retry with the same key succeeds once).

### Implementation

- [X] T038 [US2] Implement `F/application/pickup-points.service.ts`: create (limit 100, event), update and (de)activate (version +1 and event, no-op when unchanged), keyset list; ports only, no SQL; one `TransactionRunner.run` per write (A2, A4, A5).
- [X] T039 [US2] Implement `F/application/pickup-stock.service.ts`: product ownership through `CatalogProductReader` before the transaction opens (no network I/O inside it), seed `PickupProductCopy` from that read, set (no-op, `expectedVersion`), adjust (`@Idempotent` 24 h, conditional SQL), list, inactive-point conflict, event with `stockVersion` in the same transaction (A1, A3, A6, A7).
- [X] T040 [US2] Implement `F/api/pickup-points.controller.ts` (six seller endpoints, `ShopScoped`, `products.write`/`products.read`, zod parse pipe, one service call per method, `Idempotency-Key` required on adjustments) and `F/api/pickup.dto.ts` built from `K` schemas (A7, A14, A22; II.1).
- [X] T041 [US2] Run the contract migration of T024 after T038–T040 stop relying on cascade; make AS-10…AS-23 and AS-44 green: `test-spec.sh fulfilment/pickup-points`, then `fulfilment/pickup-stock`.

**Checkpoint**: seller story works independently.

---

## Phase 4: User Story 3 — Search results follow the exact store, in order, within a bounded delay (P1)

**Goal**: four S53 `Projector` consumers keep two copy tables and one index document per (point, product); replay in any order rebuilds identical documents.

**Independent Test**: `test-spec.sh fulfilment/pickup-availability-projector` green.

### Tests first

- [X] T042 [US3] In `F/pickup-availability-projector.e2e-spec.ts` write AS-24 (set 4 → offer with current product fields; 0 → gone; 2 → back), AS-25 (v2 then late v1, both orders, repeated → equals exact store), AS-27 (30 edits in one batch → one index write via bulk-call spy at the client edge, final = last), AS-28 (name/address/inactive propagate; lower `pointVersion` ignored; late stock event for an inactive point stays hidden).
- [X] T043 [US3] In the same file write AS-26 per handler (stock, point, product, shop): duplicate delivery → one effect; invalid payload, unknown type, unsupported version → dead-lettered with reason, no side effect; AS-29 (title/price update, older `productVersion` ignored, archive/sandbox/restore, delete removes rows and emits quantity-0 events, untracked product ignored with no write); AS-30 (suspend hides, reinstate shows, old `shopVersion` ignored, `shop_deleted` deactivates every point with one event each, repeat changes nothing).
- [X] T044 [US3] In the same file write AS-31 (empty the index, replay all events shuffled and twice → documents equal the live ones) and AS-45 (metrics registry holds the named series; index lag against the frozen clock; log lines carry `requestId` and hold no coordinates, address or body).

### Implementation

- [X] T045 [US3] Implement `F/application/pickup-projection.service.ts`: apply stock/point/product/shop messages (copy-table version guards, document via `offer-document.ts` and `isOfferVisible`, versioned delete when invisible, product-deletion fan-out removing stock rows with one `pickup.stock_changed {quantity: 0}` each at `stockVersion = last + 1`, shop-deletion fan-out `active = false`, version +1, one `pickup.point_changed` each).
- [X] T046 [US3] Implement the four S53 `Projector` consumers in `F/infra/`: `pickup-stock.projector.ts`, `pickup-point.projector.ts`, `pickup-product.projector.ts` (`catalog.product_created|updated|archived|restored|deleted` and the tombstone state; never `catalog.product_changed`, never reads `Product`), `pickup-shop.projector.ts` (`tenancy.shop_created|shop_status_changed|shop_deleted`; requires `shopId`, uses `shopVersion` when present): own consumer groups, `coalesce`, zod-validated payloads, `DeadLetterWriter` with reason, batch ≤ 500 (A15, A16, FR-030–FR-034).
- [X] T047 [US3] Wire the consumers into `PickupProjectorModule`; projector readiness fails while the index mapping is missing or the engine unreachable (A19); record `pickup_index_lag_seconds` = now − `occurredAt` of the newest applied event; delete `F/infra/pickup-availability.projector.ts` and its `Product` model import (§C `fulfilment → catalog.Product`).
- [X] T048 [US3] Make `fulfilment/pickup-availability-projector` green (AS-24…AS-31, AS-45).

**Checkpoint**: seller writes reach the index; replay is identical.

---

## Phase 5: User Story 1 — Shopper finds a product available for pickup nearby (P1)

**Goal**: `GET /search/near` reads only the index (800 ms bound), one hit per product with its nearest point, cursor pagination, strict validation.

**Independent Test**: AS-01…AS-09 in `pickup-search.e2e-spec.ts` green.

### Tests first

- [X] T049 [US1] In `F/pickup-search.e2e-spec.ts` write AS-01 (A at KREUZBERG qty 4 and SPANDAU qty 0; radius 5 → one item, `distanceM > 2000`; radius 2 → none; radius 20 → one), AS-02 (two points for A, nearest wins; relevance then distance; typo match; no `q` → distance then `productId`), AS-03 (two points 120 m apart across a cell edge; 1 km finds both, 0.1 km one).
- [X] T050 [US1] In the same file write AS-04 (`it.each` over every invalid parameter class → 400 `validation_failed` with field, index not called; blank `q`; defaults), AS-05 (45 products, pages 20/20/5, equal distances, same order as unpaged; cursor with another `q` → 400), AS-06 (archived, sandbox, inactive point, suspended shop invisible in search, browse and clusters; reappear after restore/reactivate/reinstate), AS-07 (anonymous 200 on all three reads; schema parse; `priceMinor`/`currency`; no extra fields).
- [X] T051 [US1] In the same file write AS-08 (121st request → 429 + `Retry-After`; limiter store off → allowed, fallback counted) and AS-09 (closed port and 1 s delay → 503 `search_unavailable`, generic detail, metric, exact store not queried via query counter).

### Implementation

- [X] T052 [US1] Extend `F/infra/availability-index.ts` with the search query: geo-distance filter on `quantity > 0`, text match on `title` with typo tolerance, one hit per `productId` with its nearest point, sort relevance → distance → `productId` (without `q`: distance → `productId`), `search_after` from the cursor, 800 ms timeout, `maxRetries: 0`; failure → `SearchUnavailableError` (A9, A13).
- [X] T053 [US1] Implement `searchNear` in `F/application/pickup-search.service.ts` (cursor via `search-cursor.ts`, defaults, blank `q`) and `GET /search/near` in `F/api/pickup-public.controller.ts` (`Firewall({anonymous})`, strict zod query pipe refusing unknown params, `@RateLimit('fulfilment.near-search')` replacing `search.query`, problem+json) (A8, A11, A12).
- [X] T054 [US1] Make AS-01…AS-09 green: `test-spec.sh fulfilment/pickup-search`.

**Checkpoint**: shopper search works end to end (MVP complete).

---

## Phase 6: User Story 4 — Reservation-time exact check (P2)

**Goal**: `PickupAvailabilityService.checkAvailability` answers from the exact store in one statement and is never stale.

**Independent Test**: AS-32, AS-33 in `pickup-stock.e2e-spec.ts`.

- [X] T055 [US4] In `F/pickup-stock.e2e-spec.ts` write AS-32 (change to 0 committed, consumers not run → search still shows the offer, `checkAvailability` reports the shortage) and AS-33 (shortage shapes, inactive point `reason`, unknown point error, one statement via query counter, 51 lines / bad quantity / duplicates → `InvalidAvailabilityRequestError`).
- [X] T056 [US4] Implement `F/application/pickup-availability.service.ts` `checkAvailability(pickupPointId, lines[1..50] unique)` → `{available, reason?, shortages[]}` through the ports in one SQL statement; export it from the barrel (A17, R1).
- [X] T057 [US4] Make AS-32/AS-33 and the whole `fulfilment/pickup-stock` file green.

---

## Phase 7: User Story 5 — Map clusters (P2)

**Goal**: `GET /pickup-points/clusters` returns zoom-dependent cells over the index, ≤ 500, cacheable 30 s.

**Independent Test**: `test-spec.sh fulfilment/pickup-clusters` green.

- [X] T058 [US5] In `F/pickup-clusters.e2e-spec.ts` write AS-34 (three in-stock points, out-of-stock ignored, `offers`, `pickupPoints`, centroid, outside box excluded), AS-35 (zoom 3, 8, 14 → cell count non-decreasing, total offers constant, nesting; zoom outside 0–20 → 400), AS-36 (`productId` filter; single-point cell has `pickupPointId`, multi-point none), AS-37 (invalid bbox classes → 400 naming `bbox`; antimeridian counts both sides).
- [X] T059 [US5] In the same file write AS-38 (> 500 cells → 500 highest, ties by `cellId`, `truncated: true`) and AS-39 (`Cache-Control: public, s-maxage=30` and no cookies on 200; 429 and 503 carry `no-store`; limiter off → fail open; index failure → 503).
- [X] T060 [US5] Extend `F/infra/availability-index.ts` with the `geotile_grid` cluster aggregation (explicit `size` capped at 501 to detect truncation, `cardinality` with `precision_threshold: 1000` for `pickupPoints`, centroid, optional `productId`, antimeridian bbox), 800 ms timeout (A10, A13).
- [X] T061 [US5] Implement `clusters` in `F/application/pickup-search.service.ts` (uses `cluster-cap.ts`) and `GET /pickup-points/clusters` in `F/api/pickup-public.controller.ts` (strict bbox/zoom parse, `@RateLimit('fulfilment.map-clusters')` replacing `skipThrottle`, `Cache-Control` rules, `cellId` replaces `tile`).
- [X] T062 [US5] Make `fulfilment/pickup-clusters` green (AS-34…AS-39).

---

## Phase 8: User Story 6 — Exact browse of points around the shopper (P2)

**Goal**: `GET /pickup-points/near` reads PostGIS with a 2 s statement limit and keyset pagination.

**Independent Test**: AS-40…AS-43 in `pickup-search.e2e-spec.ts`.

- [X] T063 [US6] In `F/pickup-search.e2e-spec.ts` write AS-40 (points at 0.5/3/4.95/5.05/12 km: order, `distanceM` within 1 m, boundary exclusion, tie on `id`, inactive and suspended-shop excluded), AS-41 (`productId` returns only stocked points with `quantity`; no `quantity` without it; bad UUID 400), AS-42 (60 points, pages 50 and 10, validation classes, anonymous, rate limit), AS-43 (statement beyond lowered limit via `pg_sleep` → generic 503 `service_unavailable`, statement cancelled in the store, activity view empty).
- [X] T064 [US6] Implement `F/infra/pickup-browse.reader.ts`: PostGIS `ST_DWithin` + exact `ST_Distance`, visibility mirrored from `isOfferVisible` against the shop copy (SQL checked against the function table), `SET LOCAL statement_timeout = 2000` inside a read transaction, keyset cursor, `quantity` only with `productId`; timeout → `ServiceUnavailableError` (A8, A13).
- [X] T065 [US6] Implement `browse` in `F/application/pickup-search.service.ts` and `GET /pickup-points/near` in `F/api/pickup-public.controller.ts` (`fulfilment.near-search` policy, strict query, `{items, nextCursor}`); delete old `F/application/pickup.service.ts`, `F/api/pickup.controller.ts` and `NearQueryDto`/`clampRadius`.
- [X] T066 [US6] Make AS-40…AS-43 and the whole `fulfilment/pickup-search` file green.

---

## Phase 9: User Story 7 — Data stays inside its domain; operable (P3)

**Goal**: no cross-domain coupling, wiring is real, gates pass.

**Independent Test**: static gates and the real application start.

- [X] T067 [US7] Remove old `F/pickup.e2e-spec.ts` only after AS-01/AS-16/AS-24 (set stock → searchable, zero removes, near radius) are proven by the new files (L-017).
- [X] T068 [US7] Update `apps/projector/src/projector.module.ts` to import `PickupProjectorModule` instead of `PickupAvailabilityProjector` (A23); confirm `apps/core/src/core.module.ts` imports `PickupModule`.
- [X] T069 [US7] In `packages/contracts/src/bff/upstream.ts` replace `pickupPageSchema` by a re-export of `pickupPointsNearResponseSchema`, keeping the exported name (S48 follow-up); run the BFF suite so it stays green.
- [X] T070 [US7] Adapt in-repo callers of the old shapes (bare arrays, `price`, `tile`) at compile level (web product page/pickup components in `packages/web/`, BFF stub); if pickup steps of `packages/web/tests/storefront-discovery.spec.ts` break, adapt only those (path is `tests/`, not `e2e/`).
- [X] T071 [US7] Run `pnpm --dir packages/backend check:table-ownership --strict` (zero pickup lines, AS-44, SC-009) and `pnpm check:boundaries`.
- [ ] T072 [US7] Start the real applications on an empty stack (L-015, L-004, L-012) with `scripts/qa/fresh-run.sh`: `apps/core` and `apps/projector` boot; projector logs the index mapping as created or present; seller creates a point (201) and sets stock (200); `GET /api/search/near` returns the product; `GET /api/pickup-points/clusters` returns a cell with `Cache-Control: public, s-maxage=30`; `GET /api/pickup-points/near?…&productId=` returns the point with `quantity`. Confirm tables and queues exist with the doctor (L-011, L-002). **Not done as written: `fresh-run.sh` refuses while the dev stack (`payment_system_*`) is up and a long-running server needed an approval. Done instead: `apps/core/src/pickup-wiring.e2e-spec.ts` boots the real `CoreModule` and serves the three reads; `apps/projector/src/pickup-wiring.e2e-spec.ts` boots the pickup consumers composed as `ProjectorModule` composes them (the whole `ProjectorModule` fails on S28, see gaps.md); `check:module-graph` resolves every app. Run `scripts/qa/fresh-run.sh` after stopping the dev stack.**

---

## Phase 10: Polish & cross-cutting

- [X] T073 Update `docs/showcase/sections/SD-13-pickup-near-me.md` Steps to `/search/near` and `/pickup-points/clusters` (A27); set pattern P0328 status in `docs/work/architecture/pattern-map.md` to `spec'd` only once S19 is approved (otherwise leave and say so in the report).
- [X] T074 Confirm `specs/UNVERIFIED.md` rows for SC-001, SC-002, SC-006 (present, status `not run`) match quickstart.md "Ops artifacts"; never describe them as verified.
- [X] T075 Update `specs/domains/S19-pickup-near-me/gaps.md`: mark A1–A27, D-6, D-7, D-8, D-12, D-16 and the §C lines as resolved with the task that did it; keep "Sibling-spec follow-ups" (S10, S48, W02, S05, S03, S50, S20) and "Spec changes" current; edit no sibling spec.
- [X] T076 Re-run `python3 scripts/livespec/check.py`; fix any unresolved `[proof:]`/`[code:]` anchor; touch no `*.reviewed.json`. **Run: 0 errors, 502 warnings (term-link style warnings; 23 lines concern the S19 page, all warnings, not errors).**
- [X] T077 Gates: `pnpm exec tsc --noEmit` (backend, contracts), ESLint, `pnpm check:boundaries`, `check:table-ownership --strict`; confirm direct `sequelize.transaction` sites in the fulfilment domain did not rise (baseline 1 = S20's `dispatch.service.ts`).
- [X] T078 Whole capability suite once: each of the five e2e files in its own fresh process plus `pnpm jest libs/domains/fulfilment/domain`; every batch prints its summary line (L-008); record the green run. The final report mentions every follow-up from S05, S10, S32, S48, S50 and W02.

---

## Dependencies & Execution Order

- Phase 1 → Phase 2 (blocks all) → stories. Within Phase 2: contracts/errors/policies/metrics first; each unit spec before its implementation; expand migration before repositories; modules and barrel last.
- US2 first (produces data and events). US3 depends on US2 events. US1 and US5 depend on US3 documents. US4 depends on US2 only. US6 depends on US2 and the shop copy from US3. US7 closes.
- MVP: Phases 1–2 + US2 + US3 + US1.
- Within a story: failing tests → services → controller → green run.

## Parallel Opportunities

- Phase 2: T006–T009, T011, T013, T015, T017, T019, T021, T027–T029 (different files).
- US2 tests (points file vs stock file) and US4 tests; `pickup-clusters` (US5) and `pickup-search` (US1/US6) e2e files once US3 is done. Tasks sharing one e2e file or `availability-index.ts` are sequential.

## Implementation Strategy

1. Setup and Foundational; units green; migrations apply on a fresh stack.
2. US2 → US3 → US1 (MVP) → US4 → US5 → US6 → US7 → Polish.
3. Narrowest `test-spec.sh` after each task; whole suite once at the end.
