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
