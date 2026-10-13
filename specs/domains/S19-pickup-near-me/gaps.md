# Gaps: S19 — Pickup near me (domain `fulfilment`) versus `spec.md`

The implementation agent's to-do list. Paths are under `packages/backend/libs/domains/fulfilment/` unless stated. References are to the draft code read on 2026-10-05.

## A. What the code gets wrong or lacks

| # | Gap | Where | Spec |
|---|---|---|---|
| A1 | `setStock` does not check that the product belongs to the shop: a member of shop A can write stock for shop B's product (cross-tenant write). | `application/pickup.service.ts:42-62` | FR-014, AS-18 |
| A2 | Nothing deactivates a point: `active` is read in two statements but no endpoint writes it; no `PATCH`, no `pickup.point_changed`, no point version column. | `api/pickup.controller.ts`, `pickup.service.ts:45`, migration `…pickup-points.js:20` | FR-004, FR-005, AS-14, AS-15 |
| A3 | Stock written to an inactive point is not refused as a state conflict (it is a generic not-found). | `pickup.service.ts:45-48` | FR-005, AS-15 |
| A4 | No per-shop limit of points; no concurrency protection. | `pickup.service.ts:32-39` | FR-003, AS-13 |
| A5 | `openingHours` is read by the service but absent from `CreatePickupPointDto`, so it can never be set; no schema, no timezone. | `api/pickup.controller.ts:10-15`, `pickup.service.ts:32` | FR-002, AS-11 |
| A6 | `setStock` bumps the version and emits an event for an unchanged quantity; no `expectedVersion`; no adjustments endpoint, no idempotency, no store-level non-negative guard beyond the column check. | `pickup.service.ts:50-59`, migration `…:30` | FR-010–FR-013, AS-17, AS-19–AS-21 |
| A7 | Seller reads are missing: no point list, no stock list. | `api/pickup.controller.ts` | FR-006, AS-23 |
| A8 | `near()` ignores shop status, product status and sandbox; no cursor; returns a bare array; `limit` is not a parameter; the controller swallows `limit`. | `pickup.service.ts:64-77`, `api/pickup.controller.ts:63-69` | FR-023, FR-025, AS-06, AS-40–AS-42 |
| A9 | `searchNear` has no cursor, fixed size 20, returns `price` as a number, no `name` in `nearest`, no category; hits are not filtered by shop/product status; `fuzziness: 'AUTO'` and `operator: 'and'` are untested. | `infra/availability-index.ts:61-94` | FR-020, FR-023, FR-028, AS-02, AS-05, AS-06 |
| A10 | Clusters: `bbox` and `zoom` hand-parsed, `zoom` unbounded for NaN, no `size` cap on the aggregation, no `pickupPoints` distinct count, no `productId`, no `truncated`, no antimeridian rule; `tile` field name; unthrottled (`skipThrottle`). | `api/pickup.controller.ts:71-78`, `infra/availability-index.ts:97-118` | FR-026, FR-027, AS-34–AS-39 |
| A11 | `NearQueryDto.radiusKm` has no type validation; `clampRadius` hides bad input; unknown params are not refused for `@Query('productId')`. | `api/pickup.controller.ts:21-28`, `:67` | FR-022, AS-04 |
| A12 | Shopper endpoints share the policy `search.query` (60/min); clusters skip throttling. | `api/pickup.controller.ts:57,65,71`; policy at `libs/infrastructure/rate-limit/rate-limit.types.ts:40` | FR-027, AS-08, AS-39 |
| A13 | No timeout and no `503 search_unavailable` for the index; the exact browse has no statement limit mapping. | `infra/availability-index.ts`, `pickup.service.ts:64` | FR-024, FR-025, AS-09, AS-43 |
| A14 | Errors are Nest `NotFoundException`/`BadRequestException` with free text, not problem+json with stable codes. | `pickup.service.ts:48`, `api/pickup.controller.ts:76` | FR-051 |
| A15 | Projector: reads `Product` for title, category, price; has no product, point or shop consumers; price is a `Number(product.price)`; the document has no product status/sandbox, no shop status, no point name/address/active; it can only delete when the product row is missing. | `infra/pickup-availability.projector.ts:28-65` | FR-023, FR-030–FR-033, AS-24–AS-30 |
| A16 | Projector uses `external_gte` versions only on the stock row, so a point or product update has no ordering guard; failure handling throws a plain `Error` (no DLQ semantic, no payload validation of the envelope's schema, no reason). | `infra/pickup-availability.projector.ts:41-64` | FR-030, FR-034, AS-26 |
| A17 | `availableAt` is a one-row boolean, not a batch with shortages, not exported, and unused. | `pickup.service.ts:79-86` | FR-040, AS-33 |
| A18 | Event `PickupStockChanged` puts the row version in the envelope version (`create(aggregateId, stock.version, …)`) and has no `stockVersion`; no `pickup.point_changed`; topic comes from the aggregate type. | `application/events/pickup-events.ts:5` | FR-010, Cross-capability contracts |
| A19 | Index mapping creation swallows errors with a warning; `indices.exists(...).catch(() => true)` hides a down cluster; no `title` keyword/`category` handling needed by the new document (name, address, active, shop status, product status). | `infra/availability-index.ts:36-59` | AS-31, Edge Cases |
| A20 | No metrics: latency by outcome, lag, DLQ, stock changes by kind; no log discipline. | whole domain | FR-052, AS-45 |
| A21 | Tests: one spec covers three scenarios against service methods, not HTTP; it injects `ProductModel`, `ShopModel`, `Outbox`; none of the VII.3 cases (401, IDOR, 400 classes, concurrency, idempotency) exist; no consumer duplicate or invalid-payload tests. | `pickup.e2e-spec.ts:1-102` | all; `test-plan.md` |
| A22 | `PickupService` (application) runs raw SQL and `PickupController` injects `AvailabilityIndex` (infra); repository and index ports are missing (I.2, D-6). | `pickup.service.ts:33-86`, `api/pickup.controller.ts:8,35` | FR-050 |
| A23 | Barrel exports infrastructure internals and the apps wire them directly (D-8). | `index.ts:9-12`; `apps/projector/src/projector.module.ts`, `apps/core/src/core.module.ts` | Cross-capability contracts (Modules) |
| A24 | Contracts: no zod schemas for any pickup request or response in `packages/contracts`. | — | FR-028, VII.6 |
| A25 | Migration: foreign keys to `Shop` and `Product` (with cascade); no `version` on `PickupPoint`; no table for the product copy and the shop visibility copy; no index supporting the seller list keyset (`("shopId", "createdAt", "id")`); the migration has no `lock_timeout`. | `migrations/20261001210000-pickup-points.js:15,29,35,25` | FR-050, AS-44, III.11 |
| A26 | `db/ownership.ts` has `PickupPoint` and `PickupStock` only; the new tables (product copy, shop visibility copy, idempotency records through the S54 facility) must be registered in the same PR. | `db/ownership.ts:92-93` | IX.3 |
| A27 | The spec file in `docs/showcase/sections/SD-13` lists `GET /search?…&near=` and `GET /pickup-points?bbox=` in its Steps but the code serves `/search/near`, `/pickup-points/clusters`; the spec follows the code names. Update the showcase note's Steps to the spec's routes. | `docs/showcase/sections/SD-13-pickup-near-me.md:20,35` | Contracts |

## B. Open debt-register rows naming `fulfilment` or S19

| Row | What | Mechanism that replaces it | Where in this spec |
|---|---|---|---|
| D-6 (open) | `api/` and `application/` import `infra/` (controller injects `AvailabilityIndex`; service injects `Sequelize` and runs SQL) | Repository and search-index ports in `domain/` with tokens, adapters in `infra/` | FR-050, A22 |
| D-7 (open) | Other domains' `*Model` imports: `ProductModel` (projector), `ShopModel` (tests) | R1 `ProductQueryService.getProductsByIds(ids, {shopId})`; tests seed through fixtures and exported services | FR-014, FR-031, AS-18, AS-44 |
| D-8 (open) | Barrel exports `AvailabilityIndex`, `PickupAvailabilityProjector` | `PickupProjectorModule` imported by `apps/projector`; barrel exports the module, `PickupAvailabilityService`, DTO types, event contracts | Cross-capability contracts |
| D-12 (open) | Raw SQL across domains. For pickup there is no JOIN to another owner today; the cross-domain edges are the foreign keys and the projector's `Product` read | FKs dropped; the product read replaced by R3 (catalog events into a fulfilment-owned copy) plus R1 at write time; shop status by R3 (S03 events) | FR-031, FR-032, FR-050 |
| D-16 (open, S32) | `libs/infrastructure/elasticsearch` is a product-index adapter, not a generic client | The pickup index mapping and queries stay in this domain's `infra/` and use only the generic client calls (`search`, `bulk`, `indices.create`) | Cross-capability contracts (Requires) |
| D-11, D-15, D-17 | Not S19 (orders/payments cycle, catalog→discovery, file cycles in other libs) | — | — |

## C. `pnpm --dir packages/backend check:table-ownership` lines for `fulfilment`

The command requires an approval that the unattended run did not have, so the lines below come from a manual read of the same inputs (model imports, `@InjectModel`, raw SQL, migrations) and **must be confirmed by running the check** before the first change; the implementation agent re-runs it with `--strict`.

| Line | Kind | Where | Replacement |
|---|---|---|---|
| `fulfilment → catalog.Product` | MODEL (`@InjectModel(Product)`, `findAll`) | `infra/pickup-availability.projector.ts:4,24,33` | R3 product copy from `catalog.product_*` events; R1 `getProductsByIds` at stock write |
| `fulfilment → tenancy.Shop` | MODEL (test only) | `pickup.e2e-spec.ts:10,54`; `delivery.e2e-spec.ts:10` (S20) | Fixtures and `ShopQueryService`; S20 pays its own line |
| `fulfilment → catalog.Product` | MODEL (test only) | `pickup.e2e-spec.ts:12,20` | Fixtures and `ProductQueryService` |
| FK `PickupPoint.shopId → Shop` | DDL | `migrations/20261001210000-pickup-points.js:15` | Drop by an expand/contract migration; plain ID column; `tenancy.shop_deleted` consumer |
| FK `PickupStock.productId → Product` | DDL | `migrations/20261001210000-pickup-points.js:29` | Drop; `catalog.product_deleted` consumer removes stock |
| Raw SQL on `Delivery`, `Courier` | own tables | `application/dispatch.service.ts:180,211`, `api/realtime-topics.ts:19`, `application/courier.service.ts:43` | Own domain (S20); no change here |
| Raw SQL on `PickupPoint`, `PickupStock` | own tables | `application/pickup.service.ts` | Moves behind repository ports (A22); no cross-domain edge |

## D. Order of work suggested to the implementation agent

1. Confirm the `check:table-ownership` lines; write the failing e2e specs from `test-plan.md` (VII.9: a bug fix includes a test that fails without it, A1 first).
2. Migration (expand): add `version` to `PickupPoint`, the product copy and shop visibility copy tables, the keyset index; register them in `db/ownership.ts`; contract step: drop the two foreign keys after the code stops relying on cascade.
3. Domain: offer visibility, stock rules, cursor, geo input, opening hours (pure, table-driven units); ports; application services; controllers with DTOs and contracts schemas; problem+json codes.
4. Events and consumers: `pickup.stock_changed`/`pickup.point_changed` v1 with versions; product, shop, point and stock handlers; replay; coalescing; DLQ.
5. Rate-limit policies (S50), idempotency (S54), metrics.
6. Barrel and app wiring (D-8); update `docs/showcase/sections/SD-13-pickup-near-me.md` (A27); set pattern P0328's status to `spec'd` once S19 is approved.

## Sibling-spec follow-ups

- **S10**: S19 consumes neither `order.paid` nor `OrderFulfilmentService.apply` / `InvalidOrderTransitionError`; those belong to S20 (delivery). List only S20 as consumer. If a pickup checkout is added later, call `PickupAvailabilityService.checkAvailability`.
- **S48**: `pickupPageSchema` in `packages/contracts/src/bff/upstream.ts` becomes a re-export of S19's `pickupPointsNearResponseSchema` (same exported name; S19 makes the one-line edit to keep the BFF suite green). Add `GET /search/near` and the clusters schema to the BFF if the product page should show them.
- **W02**: the journey file is `packages/web/tests/storefront-discovery.spec.ts` (S19's `test-plan.md` said `e2e/`). Pickup responses change to `{items, nextCursor}` with `priceMinor` + `currency`; clusters to `{cells, truncated}` with `cellId`. The web pages that read the old bare arrays or `tile` must adopt the envelope.
- **S05**: the `{shopId}` filter and `version` of `getProductsByIds` are used as published; `catalog.product_changed` is not consumed by S19.
- **S03**: `tenancy.shop_deleted` carries `{shopId, shopVersion}` (spec text shows `{shopId}`); S19 also consumes `tenancy.shop_created` to start a shop copy (see Spec changes).
- **S50**: `fulfilment.near-search` and `fulfilment.map-clusters` are declared by S19 in `fulfilment/rate-limit-policies.ts`; the pickup call sites listed in G-34/G-35 (`pickup.controller.ts:57,65,71`) are replaced. The `search.query` declaration stays with `catalog`.
- **S20**: the single `// S54 T037 audit` site in `dispatch.service.ts` is S20's; S19 does not touch it.
- **S46** (shopping assistant): the tool `pickup_near_me` injected `AvailabilityIndex` from the `fulfilment` barrel, which S19 no longer exports (D-8). S19 made the minimal code edit to keep the build green: `assistant-tools.ts` now injects the exported `PickupSearchService` and calls `searchNear({q, lat, lng, radiusKm, limit: 5})`; the tool result is `{hits: items}` with `priceMinor` + `currency` instead of `price`, `category`, `nearest.name` added. S46 should adopt the contract (and its own spec/prompt wording) and tell the model the price is minor units.
- **S48** (BFF): `pickupPageSchema` in `packages/contracts/src/bff/upstream.ts` is now `pickupPointsNearResponseSchema` (same exported name). The BFF test fixture `pickupFixture` carried `openingHours: 'Mon-Fri 9-18'` (a string); S19 changed it to a contract-valid `{timezone, weekly}` object so the BFF suite stays green (227 tests pass). A shape drift still shows as `UPSTREAM_INVALID`.
- **W02**: `libs/domains/fulfilment/pickup-contracts.spec.ts` (`W02 B-7`) imported `PickupPointNear` from the deleted `pickup.service.ts` and `NearbyProduct` from the deleted index class; S19 retyped it with the contract types (`PickupPointNear`, `PickupNearItem`, `priceMinor` + `currency`). The web package type-checks unchanged (`tsc --noEmit` clean); no web screen reads the old bare arrays or `tile` today.
- **S28** (notifications): the whole `ProjectorModule` does not start in this environment: `NotificationsCoreModule` cannot resolve `MembershipQueryService` (`RecipientDirectoryAdapter`, index [1]). Not caused by S19 (the pickup consumers are wired and proven in `apps/projector/src/pickup-wiring.e2e-spec.ts` in an app composed the way `ProjectorModule` composes them, and `check:module-graph` lists `projector` as resolved). S28 should import the tenancy module that exports `MembershipQueryService`; until then L-015 cannot be proven for the projector as a whole.
- **S53 / S32**: `SearchEngineClient.getClient()` is no longer used by the pickup code; the index adapter uses only `search`, `bulk`, `indexExists`, `createIndex`, `refresh` and `deleteIndex`.

## Spec changes

- `spec.md` FR-032 / AS-30 clarified by the plan (not edited here): the shop copy also starts from `tenancy.shop_created`, because a shop that was never suspended emits no status event; `shop_deleted` carries `shopVersion`. The decision is in `research.md` R-4.
- `test-plan.md` names the journey `packages/web/e2e/storefront-discovery.spec.ts`; the real path is `packages/web/tests/storefront-discovery.spec.ts`.
- `spec.md` AS-11 lists "`shopId` not a UUID" among the `400 validation_failed` classes. The shop gate of S03 (`ShopScoped`) runs before any pipe and answers `404 shop_not_found` for a path shop id that is not a UUID (it addresses no shop and leaks nothing). S19 does not change S03's gate; `pickup-points.e2e-spec.ts` asserts the `404` and that nothing is written. Recorded in `questions.md`.
- `research.md` R-1 assumed `collapse` with `search_after`; Elasticsearch refuses that pair unless the sort is on the collapse field alone. The search keeps the contract (one item per product with its nearest point, keyset cursor bound to the query) by reading documents in sort order and keeping each product's first one (the index adapter asks the engine, per batch, which document is first for each product). Cluster ties are exact while the viewport holds at most 5 000 cells (the engine is asked for that window and the answer keeps 500).
- The index is `pickup_availability_v2` (the draft's `pickup_availability` keeps its old mapping and is no longer used) with `dynamic: strict` and one shard.
- No `*.reviewed.json` is created or edited; no human-signed content changes. The living-spec page `docs/spec/capabilities/S19-pickup-near-me.md` is written (plan step 0, T001); `python3 scripts/livespec/check.py` needs an approval this run did not have, so its `[proof:]` and `[code:]` anchors were checked by hand (every `S19 AS-nn` of the page has a test title carrying it; every `#Symbol` occurs in its file).

## Resolution (implementation, 2026-10-13)

| Gap | Resolved by |
|---|---|
| A1 cross-tenant stock write | T039; `pickup-stock.e2e-spec.ts` AS-18 (product of S2 and unknown → `404 product_not_found`, no row) |
| A2, A3, A5 point edit, inactive conflict, opening hours | T009/T010, T038, T040; AS-11, AS-14, AS-15 |
| A4 point limit under concurrency | T026 (advisory lock), T038; AS-13 |
| A6, A7 stock rules, idempotent adjustments, seller reads | T011/T012, T039, T040; AS-16…AS-23 |
| A8, A9, A10, A11, A12 reads: visibility, cursor, clusters, strict query, policies | T014, T016, T018, T020, T052…T065; AS-01…AS-09, AS-34…AS-43 |
| A13, A19 index timeouts, `503`, mapping bootstrap | T030, T047; AS-09, AS-39, wiring specs |
| A14 problem+json codes | T006 |
| A15, A16 projector without `Product`, ordering, DLQ | T045…T048; AS-24…AS-31 (invalid messages through the real framework) |
| A17 exact batch check | T056; AS-32, AS-33 |
| A18 events | T029 (`stockVersion`, `pointVersion`, `pickup.point_changed`, envelope version 1) |
| A20 metrics and logs | T008; AS-45 (consumer lag and dead letters are the framework's `consumer_lag` and `dlq_total{consumer}`; the limiter's `rate_limit_store_unavailable_total` counts its outages) |
| A21 tests | five e2e files plus six unit specs; no spec imports `ProductModel` or `ShopModel` |
| A22, D-6 ports | T025, T026, T027, T028; the services talk to ports only; the one `infra/` import left in `application/` is the metrics instruments (`infra/pickup-metrics.ts`, where the plan puts them) and `check:boundaries` is clean |
| A23, D-8 barrel and apps | T031, T068 |
| A24 contracts | T005 |
| A25 migrations | T022 (expand), T024/T041 (contract) |
| A26 ownership | T023 |
| A27 showcase note | T073 |
| D-7, D-12, D-16 | no cross-domain model or table; `SearchEngineClient` only |
| §C ownership lines | `check:table-ownership` (before): `fulfilment → catalog.ProductModel` in the old projector, as predicted; (after, `--strict`): no `fulfilment` line. The two foreign keys are dropped by `20261013120100-pickup-s19-contract.js` (AS-44) |

Direct `sequelize.transaction` sites in the fulfilment domain: 1 (`dispatch.service.ts`, S20's, unchanged); no pickup file opens one.
