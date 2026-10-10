# Gaps: S34 — current `discovery` recommendations code versus the spec

The implementation agent's to-do list. Paths are under `packages/backend/libs/domains/discovery/` unless stated; line numbers are those read on 2026-10-05. Choices behind each row are in [`questions.md`](questions.md); scenario IDs refer to [`spec.md`](spec.md).

What exists: `api/recommendations.controller.ts` (one route), `application/recommendations.service.ts` (read: one list read, 2-hop pipeline, hydration), `infra/co-occurrence.jobs.ts` (nightly build, cosine, buckets, staging + rename), `infra/order-baskets.projector.ts` (`order.paid` → ClickHouse), `infra/recommendation-keys.ts`, `recommendations.module.ts`, `recommendations-worker.module.ts`, `clickhouse/040_order_baskets.sql`, and one e2e spec (2 tests). The core idea is sound and is kept: cosine normalisation, bucketed pair counting, staging key swapped by rename, depth-2 expansion over the top 5 seeds in one pipeline, decay 0.5, best path wins.

## A. Code versus spec

| # | Gap | Where | Spec |
|---|---|---|---|
| A1 | Response is a bare array; `price` is a float; no `type`, no `currency` | `application/recommendations.service.ts:8-15,66` | FR-003, AS-01 |
| A2 | No request validation: `limit` clamped silently, NaN → 8, no DTO, no `type`, unknown parameters accepted | `api/recommendations.controller.ts:19-21` | FR-002, AS-03–AS-05 |
| A3 | Unknown, archived, sandbox, suspended-shop product answers `200 []`; the requested product is never checked | `application/recommendations.service.ts:33-67` | FR-004, AS-06 |
| A4 | Visibility is `quantity > 0` on the catalog table; archived, sandbox and suspended-shop products pass | `application/recommendations.service.ts:56-60` | FR-009, AS-10, AS-12 |
| A5 | Candidate pool is `limit × 2` and cut before the visibility check, so hidden products shrink the rail | `application/recommendations.service.ts:34,57` | FR-009, AS-10 |
| A6 | Ranking mixes direct and indirect by raw score; direct-over-indirect rule missing; ties use `localeCompare` (locale dependent) rather than byte order of the ID | `application/recommendations.service.ts:51` | FR-007, AS-02, AS-18 |
| A7 | Expansion reads each seed's list with only `limit - 1` entries instead of the full list of 20, so second-hop candidates are cut by the caller's `limit` rather than by score | `application/recommendations.service.ts:40-48` | FR-006, AS-17 |
| A8 | Stored entries are trusted (`Number(score)`, any member string); no skip and no metric | `application/recommendations.service.ts:73-77` | FR-008, AS-21 |
| A9 | Redis or hydration failure is an unhandled `500`; no timeouts anywhere on the read path | `application/recommendations.service.ts:34,43,56` | FR-012, AS-45, AS-46 |
| A10 | Rate limit reuses `search.query`; cache header is static, errors are not marked `no-store` | `api/recommendations.controller.ts:15-17` | FR-010, FR-011, AS-08, AS-09 |
| A11 | Build payload is untyped; `days = 0` builds an empty graph, `buckets = 0` loops zero times, unknown keys accepted | `infra/co-occurrence.jobs.ts:53-54` | FR-018, AS-42 |
| A12 | Pair threshold counts orders only; no distinct-buyer rule (baskets have no buyer) | `infra/co-occurrence.jobs.ts:15,73-76`, `clickhouse/040_order_baskets.sql` | FR-019, AS-24 |
| A13 | Products that lost all edges keep their old list until the TTL; no removal pass | `infra/co-occurrence.jobs.ts:100` | FR-024, AS-38 |
| A14 | Empty source is reported as success; no `skipped_empty` outcome, no metric | `infra/co-occurrence.jobs.ts:56-99` | FR-024, AS-39 |
| A15 | No mutual exclusion beyond the job lease; two direct invocations run in parallel; no `skipped_locked` | `infra/co-occurrence.jobs.ts:53` | FR-025, AS-41 |
| A16 | Result lacks `removed` and `outcome`; no metrics, no last-success timestamp, no alert; `Logger.log` only | `infra/co-occurrence.jobs.ts:56-102` | FR-026, AS-47, SC-009 |
| A17 | Window and thresholds are constants in the file; no startup validation | `infra/co-occurrence.jobs.ts:15-16`, `infra/recommendation-keys.ts:5` | FR-029, AS-51 |
| A18 | Projector does not validate the payload, does not dead-letter, silently drops other types, uses `occurredAt` (envelope time) rather than `paidAt`, has no `buyerId` or `orderVersion`, and no basket counters | `infra/order-baskets.projector.ts:23-30` | FR-013–FR-015, AS-29–AS-34 |
| A19 | Basket row identity is `order_id` with no version guard (redelivery relies on `ReplacingMergeTree` + `FINAL`) | `clickhouse/040_order_baskets.sql` | FR-014, AS-30, AS-34 |
| A20 | No replay proof, no test of basket size limits, redelivery, invalid payload (VII.4 pair is missing) | `recommendations.e2e-spec.ts` | AS-30–AS-35 |
| A21 | Existing e2e has two tests that call the job and the endpoint; no 401/IDOR-style, validation, limit, 404, rate-limit, concurrency, failure-injection, TTL or schema-parse cases; it seeds products directly in the catalog tables | `recommendations.e2e-spec.ts:21-95` | VII.2, VII.3, VII.6 |
| A22 | No contract schema in `packages/contracts` for the request or response | `packages/contracts` | FR-003, V.2 |
| A23 | Web, BFF and GraphQL consume the old shape and `price` | `packages/web/lib/api/catalog.ts:38-45,66-68`, `packages/web/app/products/[slug]/page.tsx:26-29,121-127`, `libs/composition/bff/product-page.service.ts:14,40,68`, `libs/composition/bff/graphql/product.resolver.ts:36-38` | FR-030, AS-48, AS-49 |
| A24 | Barrel exports `OrderBasketsProjector`; `apps/projector` wires it directly | `index.ts:15`, `apps/projector/src/projector.module.ts:3` | FR-027, AS-50 |
| A25 | No Playwright journey for the rail; no BFF composition test for 503, 404 and invalid body | `packages/web/tests/` | AS-48, AS-49 |

## B. Open rows of `docs/architecture/debt-register.md` that name `discovery` or S34

| Debt | What | Where (this capability) | Replaced by |
|---|---|---|---|
| D-6 (I.2) | `application/` imports `infra/` classes and injects the model directly | `application/recommendations.service.ts:4-6,30` (model, `infra/recommendation-keys`) | Ports in `domain/` (`NeighbourListReader`, `BasketStore`, `NeighbourListWriter`, `BuildLock`) with `infra/` adapters; `application/` uses `@Inject(TOKEN)` only |
| D-7 (IX.4) | `ProductModel` imported and injected from `catalog` | `application/recommendations.service.ts:4,30`, `recommendations.module.ts:3,10` | **R1**: `ProductQueryService.getProductsByIds` (S05) and `ShopQueryService.getShopsByIds` (S03); the `forFeature([Product])` registration is deleted |
| D-8 (X.4) | Barrel exports infrastructure internals | `index.ts:15` (`OrderBasketsProjector`) | The projector moves behind `RecommendationsProjectorModule`; apps import that module; `CoOccurrenceJobs` is not exported |
| D-12 (IX.4) | Raw SQL on a table of another owner; "Discovery reads catalog's `Product` with no tables of their own" | `application/recommendations.service.ts:56-60` (`findAll` on `Product`) | **R1** for product and shop facts (above); the order data comes through **R3** (`orders.events` → basket store owned by discovery), never `BisOrder*` tables |
| D-15 (X.5) | catalog → discovery cycle through `SearchQueryLogger` | not this capability (S05 / S32) | After this capability, `discovery` imports `catalog` and `tenancy` only through entry points (R1) and `orders` only through event contracts; no import points back, so the recommendations files add no edge to the cycle |
| D-16 (X.3, X.7) | `libs/infrastructure/elasticsearch` is a product-index adapter | not this capability (S32) | n/a |

## C. `pnpm --dir packages/backend check:table-ownership` lines for `discovery` (run 2026-10-05)

Seven lines for the domain; two files and one module of them belong to this capability.

| Kind | Where | Table or model | Belongs to | Replacement |
|---|---|---|---|---|
| MODEL | `application/recommendations.service.ts` | `ProductModel` (catalog) | **S34** | R1 `getProductsByIds` (S05) |
| MODEL | `recommendations.module.ts` | `ProductModel` (catalog) | **S34** | Remove `forFeature([Product])`; the module imports the product and tenancy modules that export the R1 services |
| SQL | `application/shop-product-search.service.ts` | `Product` (catalog) | S32 | Not this capability |
| SQL | `application/trending.service.ts` | `Product` (catalog) | S35 | Not this capability |
| MODEL | `application/search-reindex.service.ts` | `ProductModel` (catalog) | S32 | Not this capability |
| MODEL | `search-admin.module.ts` | `ProductModel` (catalog) | S32 | Not this capability |
| MODEL | `search-reindex-worker.module.ts` | `ProductModel` (catalog) | S32 | Not this capability |

Target: `check:table-ownership --strict` reports zero lines for the recommendations files. The projector's import `OrderPaid` from `@app/domains/orders` (`infra/order-baskets.projector.ts:6`) is an event contract through the entry point and is allowed; after S10 lands it is replaced by the `orderEventSchemas` zod schema from `packages/contracts` so that the domain has no import of `orders` at all.

## D. Work order suggested

1. Contracts and DDL (expand): `recommendationsQuerySchema`, `recommendationsResponseSchema`; `order_baskets` gains nullable `buyer_id`, `order_version`; ports in `domain/`.
2. Projector: schema validation, version-guarded upsert, size rule, counters; `RecommendationsProjectorModule`; replay the topic to backfill buyers.
3. Build: params validation, buyer threshold, removal pass, empty-source guard, lock, outcome and metrics, atomic publish kept.
4. Read: validation, requested-product check, bounded pool, R1 lookups, direct-before-indirect ranking, entry sanitising, time budgets, 503, headers, rate-limit policy.
5. Consumers: web, BFF composition and GraphQL adopt the new shape; Playwright journey.
6. Contract step: make `buyer_id` and `order_version` mandatory once the replay is done, delete `forFeature([Product])`, tighten the barrel; run `check:boundaries` and `check:table-ownership --strict`.

## Sibling-spec follow-ups

- **W02**: adopt the new response shape in `packages/web/lib/api/catalog.ts` (`Recommendation`, `recommendationToCard`) and `packages/web/app/products/[slug]/page.tsx` (envelope `{type, items}`, money from `priceMinor`/`currency`, section hidden on empty/404/429/503); add the Playwright journey `packages/web/tests/product-recommendations.spec.ts` (AS-48, A25). S34 only keeps the in-repo callers compiling.
- **S48**: `libs/composition/bff/product-page.service.ts` and `bff/graphql/product.resolver.ts` adopt `recommendationsResponseSchema` (validate the body; `recommendations: null` plus a partial-error entry on timeout/503/404/invalid body), and `bff.e2e-spec.ts` gains the AS-49 cases (A25).
- **S50**: policy `discovery.recommendations` (600/min per address, fail open) is declared in `discovery/rate-limit-policies.ts`; it replaces the `search.query` reuse and must appear in the registry listing.
- **S49**: `recommendations.build-bought-together` now declares a strict payload contract, `fleetConcurrency: 1`, and `leaseMs`/`maxRuntimeMs` of 1 h; nothing further to adopt.
