# Tasks: S34 — "Bought Together" Recommendations

**Input**: `plan.md`, `spec.md`, `test-plan.md`, `gaps.md`, `questions.md` (defaults accepted), `data-model.md`, `research.md`, `contracts/recommendations-api.md`, `quickstart.md`
**Order rule**: for every test-plan row the failing test task comes before the code task. Backend commands run from `packages/backend`; e2e through `/opt/sdd/repo/scripts/sdd/test-spec.sh <pattern>`; run the narrowest test per task and the whole capability suite once in the last phase.
**Paths**: `D/` = `packages/backend/libs/domains/discovery/`; `C/` = `packages/contracts/src/search/`.
**Rules for every task**: no `git checkout/restore/reset/stash/clean`; no new `sequelize.transaction` (baseline 0); other capabilities' specs are never edited, only listed in `gaps.md` § Sibling-spec follow-ups; fixture/seed code uses the real services, not direct table inserts into another domain.

## Phase 1: Setup

- [ ] T001 [P] Add `packages/backend/libs/common/config/recommendations-config.ts` with joi keys and defaults `REC_MIN_CO_ORDERS` 3 (≥1), `REC_MIN_BUYERS` 3 (≥1), `REC_TOP_N` 20 (1–20), `REC_WINDOW_DAYS` 180 (1–390), `REC_BUCKETS` 16 (1–256), `REC_TTL_SECONDS` 259200 (≥1), `REC_EXPAND_SEEDS` 5 (1–20), `REC_HOP_DECAY` 0.5 ((0,1) exclusive), `REC_STORE_BUDGET_MS` 100, `REC_PRODUCT_BUDGET_MS` 100, `REC_SHOP_BUDGET_MS` 50 (each ≥1), `REC_BASKET_MIN` 2, `REC_BASKET_MAX` 30; register in `api-config.service.ts`; invalid value fails startup naming the key (A17, FR-029, AS-51)
- [ ] T002 [P] Add `C/recommendations.ts`: `recommendationsQuerySchema` (strict; `limit` integer 1–20 default 8; `type` only `bought-together` default `bought-together`; unknown keys rejected) and `recommendationsResponseSchema` (`{type:'bought-together', items:[{productId uuid, title string, priceMinor integer ≥0, currency 3 letters, score in (0,1] with 4 decimals, hops 1|2}]}`); export from `C/index.ts` (A1, A22, FR-002, FR-003)
- [ ] T003 [P] Create `packages/backend/clickhouse/041_recommendation_baskets.sql`: `recommendation_baskets (order_id String, buyer_id String, products Array(String), paid_at DateTime64(3,'UTC'), order_version UInt32, inserted_at DateTime64(3,'UTC') DEFAULT now64(3))`, `ENGINE ReplacingMergeTree(order_version)`, `PARTITION BY toYYYYMM(paid_at)`, `ORDER BY order_id`, `TTL toDateTime(paid_at) + INTERVAL 13 MONTH` (A12, A19, research R-3); do not touch `040_order_baskets.sql`
- [ ] T004 [P] Add `D/infra/recommendations-metrics.ts` through `MetricsRegistry`: `recommendations_requests_total{result}`, `_hops_total{hops}`, `_bad_entries_total`, `_basket_skipped_total{reason}`, `_baskets_total{outcome}`, `_build_duration_seconds`, `_build_products`, `_build_edges`, `_build_last_success_timestamp`, `_build_skipped_total{reason}`; labels are fixed enums, never ids (A16, R-15, FR-028)

## Phase 2: Foundational (blocks all stories)

- [ ] T005 Add `D/domain/recommendation-ports.ts`: interfaces and injection tokens `NeighbourListReader`, `NeighbourListWriter`, `BasketStore`, `BuildLock`, `CatalogFacts`, `Clock`; no import from `infra/` (D-6, I.2)
- [ ] T006 [P] Write `D/infra/recommendations-config.ts` building `RecommendationsSettings` from `ApiConfigService` (T001); provide it as a token consumed by `application/`
- [ ] T007 [P] Write the shared test fixture `D/recommendations.fixtures.ts`: dataset D (products incl. hub `P` and cold product `S`, baskets, buyers), helpers to boot `RecommendationsModule`/`RecommendationsWorkerModule`/`RecommendationsProjectorModule` with the real `ProductModule` and `TenancyModule`, frozen clock, counting Redis wrapper, failure/delay injectors for Redis, ClickHouse and the R1 services, `clean()`, `TRUNCATE recommendation_baskets`, list-keyspace flush, problem+json and response schema parse helpers (test-plan intro)
- [ ] T008 [P] Add `D/infra/recommendation-keys.ts` update: keep keys and TTL helpers (`rec:bought:{id}`, `:next` staging, `rec:build:lock`, `rec:build:{runId}`), TTL taken from settings; `application/` no longer imports it
- [ ] T009 [P] Add `withBudget(promise, ms)` helper (race against a timer, timer cleared, no retry) in `D/infra/with-budget.ts` (R-10)
- [ ] T010 Add `D/rate-limit-policies.ts` entry `discovery.recommendations` (sliding window, 600/min, key `ip`, fail open) and remove the `search.query` reuse (A10, R-12, FR-011)

**Checkpoint**: contracts, DDL, ports, config, fixtures ready.

## Phase 3: US1 — See what other buyers bought with this product (P1) 🎯 MVP

**Goal**: anonymous endpoint with strict parse, ordered response, headers, 404.
**Independent test**: `recommendations-read` e2e green on dataset D built through the real job.

### Tests first (all in `D/recommendations-read.e2e-spec.ts`, top-level `describe('Bought-together recommendations API')`; must fail first)
- [ ] T011 [P] [US1] Unit `D/domain/recommendation-ranking.spec.ts` (U1, AS-02): `it.each` ties by `productId` byte order, identical output on replay, `fast-check` property: order independent of input order
- [ ] T012 [P] [US1] Unit `D/domain/neighbour-entry.spec.ts` (U3, AS-21): non-UUID, self, NaN, negative, >1, missing score are skipped
- [ ] T013 [P] [US1] Unit `D/domain/cosine-score.spec.ts` (U4, AS-22): `it.each` over dataset D pairs, 4-decimal rounding only at response, property symmetric / in (0,1] / 1 only for identical baskets
- [ ] T014 [US1] e2e AS-01: happy path, `Cache-Control: public, max-age=60, s-maxage=300`, no `Set-Cookie`, no state change, body parsed with `recommendationsResponseSchema`
- [ ] T015 [US1] e2e AS-03, AS-04, AS-05: `limit` default/bounds/invalid, `type` accepted/rejected, `validation_failed` problem+json shape with `errors:[{field,message}]`, unknown parameter, non-UUID id
- [ ] T016 [US1] e2e AS-06: unknown / archived / sandbox / non-active-shop requested product → identical `404 product_not_found`
- [ ] T017 [US1] e2e AS-07: same body for every caller, invalid token ignored, no cookie, log and metric label content has no buyer data
- [ ] T018 [US1] e2e AS-08: 429 `rate_limited` with `Retry-After` ≥ 1 and fail-open when the limiter store is down
- [ ] T019 [US1] e2e AS-09: 400, 404, 429 answers carry `Cache-Control: no-store`

### Implementation
- [ ] T020 [P] [US1] Implement `D/domain/neighbour-entry.ts` (sanitise stored entries; UUID member, not self, finite score in (0,1]) to pass T012
- [ ] T021 [P] [US1] Implement `D/domain/cosine-score.ts` (`co / sqrt(na·nb)`, 4-decimal rounding helper for the response) to pass T013
- [ ] T022 [P] [US1] Implement `D/domain/recommendation-ranking.ts` (direct before indirect, score desc, `productId` asc by byte order not `localeCompare`, cut to `limit`) to pass T011 (A6)
- [ ] T023 [US1] Implement `D/infra/redis-neighbour-lists.adapter.ts` reader half: `ZREVRANGE WITHSCORES` single and batched, budgeted by `REC_STORE_BUDGET_MS`
- [ ] T024 [US1] Implement `D/infra/catalog-facts.adapter.ts`: `ProductQueryService.getProductsByIds(ids)` (one batch, fields `id,title,priceMinor,currency,status,isSandbox,inStock,shopId`, no `shopId` option) then `ShopQueryService.getShopsByIds` for the shop ids, budgets 100/50 ms, no `ProductModel` (D-7, D-12, S05 follow-up)
- [ ] T025 [US1] Rewrite `D/application/recommendations.service.ts` (ports via `@Inject(TOKEN)` only, no `infra/` import): read list, sanitise, pool, one product batch + one shop batch, visibility (product `ACTIVE`, not sandbox, `inStock`, shop `ACTIVE`), requested-product check → typed not-found, rank, cut, map to `{productId,title,priceMinor,currency,score,hops}` (A1, A3–A6, A8, D-6)
- [ ] T026 [US1] Rewrite `D/api/recommendations.controller.ts`: single call to the service, strict parse with the T002 schemas, `@RateLimit('discovery.recommendations')`, `@Firewall({anonymous:true})`, set `no-store` first and replace with `public, max-age=60, s-maxage=300` only on success (A2, A10, R-11)
- [ ] T027 [US1] Rewrite `D/recommendations.module.ts`: import `ProductModule`/`TenancyModule` exports, bind tokens to adapters, delete `forFeature([Product])` (D-7); run T011–T019 until green

## Phase 4: US2 — Only products I can buy right now (P1)

**Independent test**: hidden candidates never appear; pool is checked in one batch.

- [ ] T028 [US2] e2e AS-10 in `D/recommendations-read.e2e-spec.ts`: hidden candidates dropped and replaced from the pool, exactly one `getProductsByIds` and one `getShopsByIds` call (spies)
- [ ] T029 [US2] e2e AS-11 and AS-12: fewer than asked / none visible → `200` with fewer or empty `items`; stock change visible at origin immediately
- [ ] T030 [US2] Fix any gap found by T028–T029 in `D/application/recommendations.service.ts` (pool is the whole bounded list, not `limit×2`; A4, A5)

## Phase 5: US3 — Cold-start 2-hop rail (P1)

**Independent test**: `recommendations-cold-start` e2e green.

- [ ] T031 [P] [US3] Unit `D/domain/two-hop-blend.spec.ts` (U2, AS-17, AS-18): table of graphs, best path wins, direct stays direct, no self, direct before indirect despite lower score; `fast-check` property: adding a path never lowers a score
- [ ] T032 [US3] e2e AS-13, AS-14 in `D/recommendations-cold-start.e2e-spec.ts` (`describe('Bought-together 2-hop cold start')`): cold product `S` and hub `P` of dataset D
- [ ] T033 [US3] e2e AS-15, AS-16, AS-20 (counting Redis wrapper): top 5 seeds, one batched read of full 20-entry lists, no third hop; 8 direct with limit 8 → 1 read; no edges → 1 read
- [ ] T034 [US3] e2e AS-19: hidden seed still bridges
- [ ] T035 [US3] Implement `D/domain/two-hop-blend.ts` (decay `REC_HOP_DECAY`, best path, direct precedence, no self) to pass T031
- [ ] T036 [US3] Add expansion to `D/application/recommendations.service.ts`: runs when valid stored direct entries < `limit` (R-2), top `REC_EXPAND_SEEDS` seeds, seeds' lists read in full (A7), one batched read; run T032–T034 green

## Phase 6: US5 — Every paid order feeds the graph exactly once (P1)

**Independent test**: `recommendations-baskets` e2e green.

- [ ] T037 [P] [US5] Unit `D/domain/basket.spec.ts` (U5, AS-33): distinct, sorted, 1/2/30/31 distinct products, repeated lines, skip reasons
- [ ] T038 [US5] e2e `D/recommendations-baskets.e2e-spec.ts` (`describe('Order basket projection')`): AS-29 one basket (distinct, sorted, buyer, version), AS-30 duplicate and concurrent delivery → one basket (VII.4 pair), AS-31 invalid payloads dead-lettered with reason and stream continues, AS-32 `order.reserved/cancelled/refunded/fulfilment_changed` ignored without dead letter, AS-34 late/reordered/stale-window/version-guarded redelivery, AS-35 topic replay rebuilds identical baskets and lists; payloads built from the new S10 `orderEventSchemas` shape
- [ ] T039 [P] [US5] Implement `D/domain/basket.ts` (distinct, sorted, size `REC_BASKET_MIN`–`REC_BASKET_MAX`, reasons) to pass T037
- [ ] T040 [P] [US5] Implement `D/domain/recommendation-events.ts`: `order.paid` definition from `orderEventSchemas['order.paid']` extended with `lines: min(1)` and UUID `productId`; no import of `@app/domains/orders` (R-5)
- [ ] T041 [US5] Implement `D/infra/clickhouse-basket-store.adapter.ts` (`BasketStore`): batch lookup of stored `max(order_version)`, insert, read with `FINAL` (R-4)
- [ ] T042 [US5] Implement `D/application/basket-capture.service.ts`: size rule, version guard (insert only strictly higher; equal → `duplicate`, lower → `stale`), counters `recommendations_baskets_total`/`_basket_skipped_total` (A18, A19, FR-013–FR-015)
- [ ] T043 [US5] Move projector to `D/infra/projectors/order-baskets.projector.ts` (consumer `discovery-order-baskets`, topic `orders.events`, `versionGuard` on `orderVersion`, uses `paidAt`, `userId` as buyer); delete `D/infra/order-baskets.projector.ts` (A18, D-8)
- [ ] T044 [US5] Add `D/recommendations-projector.module.ts` with the static projectors list; wire into `apps/projector/src/projector.module.ts` replacing the direct `OrderBasketsProjector` import (A24); replace `D/index.ts` export of `OrderBasketsProjector` with the three modules only; run T038 green
- [ ] T045 [US5] Update `D/infra/order-baskets` replacements: grep in-repo importers of the old projector or `order_baskets` table and adapt them; record any other capability's spec dependency in `gaps.md` § Sibling-spec follow-ups

## Phase 7: US4 + US6 — Hub normalisation and a safe nightly build (P1)

**Independent test**: `recommendations-build` e2e green (time frozen).

- [ ] T046 [P] [US6] Unit `D/domain/build-params.spec.ts` (U6, AS-42): `days` 1–390 default 180, `buckets` 1–256 default 16, unknown keys rejected, non-integers rejected
- [ ] T047 [US6] e2e `D/recommendations-build.e2e-spec.ts` (`describe('Co-occurrence nightly build')`), driven through the real handler `recommendations.build-bought-together` and real job table, part 1 (US4 scoring): AS-23 noise threshold ≥3 co-orders, AS-24 distinct-buyer threshold (manufactured single-account edge), AS-25 symmetry, AS-26 window boundary with `n` counts, AS-27 top-20 cap and deterministic ties, AS-28 identical result for 1, 4, 16 buckets
- [ ] T048 [US6] e2e same file part 2: AS-36 idempotent rerun, AS-37 atomic replacement with 50 concurrent readers repeated, AS-38 product that lost all edges loses its list and failed build removes nothing, AS-39 empty source → `skipped_empty` nothing written/removed, AS-40 failure injected on the 3rd bucket query leaves valid lists, no deletion, no success timestamp
- [ ] T049 [US6] e2e same file part 3: AS-41 two `Promise.all` invocations → one works, one `skipped_locked`, lock expires by lease; AS-43 lists carry 3-day TTL (value asserted) and expired list → empty answer; AS-44 schedule registered exactly once across two worker modules and a restart; handler options resolve with `fleetConcurrency: 1`, `maxRuntimeMs: 3_600_000`, `leaseMs: 3_600_000` (S49 follow-up e)
- [ ] T050 [P] [US6] Implement `D/domain/build-params.ts` to pass T046
- [ ] T051 [P] [US6] Implement `D/infra/redis-build-lock.adapter.ts`: `SET rec:build:lock <token> NX PX 3_600_000`, compare-and-delete Lua release (R-8, A15)
- [ ] T052 [US6] Extend `D/infra/redis-neighbour-lists.adapter.ts` with the writer half: per list `DEL staging; ZADD; EXPIRE ttl; RENAME` in one pipeline, build marker set `rec:build:{runId}` (TTL 2 h), `SCAN` (never `KEYS`) removal pass skipping `:next` keys with batched `SMISMEMBER` (R-7, A13)
- [ ] T053 [US6] Extend `D/infra/clickhouse-basket-store.adapter.ts` with the bucket query: `recommendation_baskets FINAL WHERE paid_at >= {since}`, double `ARRAY JOIN`, `cityHash64(a) % buckets`, `HAVING co >= minCo AND uniqExact(buyer_id) >= minBuyers`, `n(p)` over all eligible baskets, `LIMIT k BY a`, order `a, score DESC, b ASC`; plus the empty-source `count() … LIMIT 1` probe (R-6, R-9, A12)
- [ ] T054 [US6] Implement `D/application/co-occurrence-build.service.ts`: lock, empty guard, buckets, publish, removal only after a complete build, typed result `{outcome:'completed'|'skipped_empty'|'skipped_locked', products, edges, removed}`, metrics and `_build_last_success_timestamp` only on success (A11, A13–A16)
- [ ] T055 [US6] Rewrite `D/infra/co-occurrence.jobs.ts` as a thin `@JobHandler('recommendations.build-bought-together')` plus schedule `17 3 * * *` with `fleetConcurrency: 1`, `leaseMs` and `maxRuntimeMs` 3_600_000; `declareJobType` with a strict payload contract (`days`/`buckets` bounds, unknown keys rejected) next to the `JobPayloads` augmentation; wrap `upsertSchedule` to catch `InvalidScheduleError`; no `JobsService.cancel` caller (S49 follow-ups a–e)
- [ ] T056 [US6] Update `D/recommendations-worker.module.ts` bindings (lock, lists, store ports); run T047–T049 green

## Phase 8: US7 — Degradation, metrics, boundary (P2)

**Independent test**: `recommendations-platform` e2e green.

- [ ] T057 [US7] e2e `D/recommendations-platform.e2e-spec.ts` (`describe('Recommendations degradation, metrics and boundary')`): AS-45 store down and slow → `503 recommendations_unavailable`, `Retry-After: 5`, `no-store`, no leak, no in-request retry; AS-46 product or shop lookup failure/timeout → same 503, never an unfiltered list; AS-47 metrics set and log content (no buyer ids); AS-50 module exports only the three modules and ownership registry check; AS-51 invalid config fails startup naming the key
- [ ] T058 [US7] Add typed `RecommendationsUnavailableError` (503, `Retry-After: 5`) in `D/domain/` mapped by the global filter; wrap store and R1 calls with `withBudget` in the service and adapters; increment `recommendations_requests_total{result}`, `_hops_total`, `_bad_entries_total`; run T057 green
- [ ] T059 [US7] Tighten `D/index.ts` barrel to `RecommendationsModule`, `RecommendationsWorkerModule`, `RecommendationsProjectorModule` only; `CoOccurrenceJobs` not exported (D-8)

## Phase 9: US8 — In-repo consumers of the new shape (P2; W02/S48 own the rest)

- [ ] T060 [US8] Adapt `packages/backend/libs/composition/bff/product-page.service.ts` and `libs/composition/bff/graphql/product.resolver.ts` to the `{type, items}` envelope and `priceMinor`/`currency` (parse with `recommendationsResponseSchema`) so they compile and `bff.e2e-spec.ts` stays green (A23)
- [ ] T061 [P] [US8] Adapt `packages/web/lib/api/catalog.ts` (`Recommendation`, `recommendationToCard`) and `packages/web/app/products/[slug]/page.tsx` to the new shape so `tsc` and web tests pass; hide section on empty/404/429/503 (A23, FR-030)
- [ ] T062 [US8] Add `## Sibling-spec follow-ups` bullets in `gaps.md` (verify existing W02, S48, S50, S49 bullets; add **S10**: keep `userId` and `orderVersion` on `order.paid`) covering A23, A25 consumer work (Playwright `packages/web/tests/product-recommendations.spec.ts`, BFF AS-48/AS-49 cases)

## Phase 10: Contract step, gaps, ops, polish

- [ ] T063 Add `packages/backend/clickhouse/042_drop_order_baskets.sql` (contract step, applied only after replay of `orders.events`; document as operator step) (R-3)
- [ ] T064 Delete the old `D/recommendations.e2e-spec.ts` once its two cases are covered by R/J files (A20, A21)
- [ ] T065 Verify `// S54 T037 audit` / `sequelize.transaction` count in S34 files is still 0 (`.tx.baseline`) and nothing is added (R-14)
- [ ] T066 Verify the S05, S10, S49 follow-ups: no `ProductModel`/`JOIN "Product"` left in recommendations files; `order.paid` consumed with `userId`, `orderVersion` only; `declareJobType` / `fleetConcurrency: 1` / `maxRuntimeMs` ≥ lease present; mention each in the final report
- [ ] T067 Confirm `quickstart.md` "Ops artifacts" lists SC-001, SC-007, SC-009, edge-cache check and replay step, and `specs/UNVERIFIED.md` rows for S34 SC-001/SC-007/SC-009 exist with status "not run" (already present; do not mark verified)
- [ ] T068 Run gates from `packages/backend`: `pnpm check:boundaries`, `pnpm check:table-ownership --strict` (zero lines for recommendations files), `pnpm exec tsc --noEmit` (backend, contracts, web), ESLint on touched packages
- [ ] T069 Run the whole capability suite once: `/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/discovery/domain` and `recommendations-` e2e files (read, cold-start, baskets, build, platform) plus `bff.e2e-spec.ts`; if a test still fails after 5 fix attempts, stop and write the blocker, attempts and hypothesis to `questions.md`

## Gap coverage

| Gap | Tasks | Gap | Tasks |
|---|---|---|---|
| A1 | T002, T025 | A14 | T048, T054 |
| A2 | T002, T015, T026 | A15 | T049, T051, T054 |
| A3 | T016, T025 | A16 | T004, T054, T057 |
| A4, A5 | T028, T030 | A17 | T001, T057 |
| A6 | T011, T022 | A18 | T040, T042, T043 |
| A7 | T033, T036 | A19 | T003, T041, T042 |
| A8 | T012, T020 | A20 | T038, T064 |
| A9 | T057, T058 | A21 | T014–T019, T064 |
| A10 | T010, T018, T019, T026 | A22 | T002 |
| A11 | T046, T050, T055 | A23 | T060, T061 |
| A12 | T003, T047, T053 | A24 | T044 |
| A13 | T048, T052 | A25 | T062 (sibling follow-up) |
| D-6 | T005, T025 | D-7, D-12 | T024, T027 |
| D-8 | T043, T044, T059 | Ownership lines | T027, T068 |

## Dependencies

- Phase 1 → Phase 2 → stories. US1 (Phase 3) is the MVP and needs T005–T010. US2 and US3 extend the US1 service. US5 (baskets) and US6/US4 (build) are independent of US1 apart from the shared fixtures; the read e2e (T014) builds dataset D through the build job, so T050–T056 must land before T014 can pass in full.
- US7 needs US1, US5, US6. US8 needs T002 and T025. Phase 10 last.
- Parallel: T001–T004; T011–T013; T020–T022; T039–T040; T050–T051.

## Strategy

MVP = Phases 1–3 plus the build (Phase 7) so dataset D exists; then US2, US3, US5, US7, US8; finish with the contract step and the single full-suite run.
