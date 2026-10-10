# Implementation Plan: S34 — "Bought Together" Recommendations

**Branch**: `S34-recommendations` (working branch `sdd/auto`) | **Date**: 2026-10-10 | **Spec**: [spec.md](spec.md)

**Input**: `spec.md` (AS-01–AS-51), `test-plan.md`, `gaps.md` (A1–A25, D-6/D-7/D-8/D-12, ownership lines), `questions.md` (defaults accepted as written), the constitution, and the follow-ups left by S05, S10 and S49 (below).

## Summary

Rebuild the recommendations slice of `discovery` around three runtime paths that share ports in `domain/`:

1. **Read** `GET /api/products/:productId/recommendations` → one application service: strict query parse, one Redis read of the product's list, a bounded depth-2 expansion (top 5 seeds, one batched read of their full 20-entry lists), one `getProductsByIds` and one `getShopsByIds` call over the whole pool (≤ 121 products), pure ranking (direct before indirect, score desc, id asc), `200` / `404` / `503` with the headers of FR-010. Response and query schemas live in `packages/contracts`.
2. **Capture** `order.paid` (topic `orders.events`) → `RecommendationsProjectorModule` → a version-guarded upsert of one basket per `orderId` into a new ClickHouse table, with the size rule, counters, and dead-lettering of invalid payloads.
3. **Build** `recommendations.build-bought-together` (cron `17 3 * * *`) → bucketed cosine counting with the distinct-buyer rule, per-list atomic publish (staging key + `RENAME`, 3-day TTL), removal pass after a complete build, empty-source guard, build lock, typed outcome and metrics.

All I/O crosses `domain/` ports with `infra/` adapters (D-6). Product and shop facts come only through the R1 services (D-7, D-12); the module exports only the three Nest modules (D-8).

## Technical Context

**Language/Version**: TypeScript (strict), NestJS; Zod schemas in `packages/contracts`
**Primary Dependencies**: `RedisService` (ioredis), `ClickHouseService`, `JobsService` / `declareJobType` / `@JobHandler`, `ProjectionsModule` projector framework, `@app/infrastructure/rate-limit`, `MetricsRegistry`, `ApiConfigService` (joi keys), `ProductQueryService` (S05), `ShopQueryService` (S03), `orderEventSchemas` (S10, contracts); `fast-check` already used by sibling specs
**Storage**: ClickHouse `recommendation_baskets` (new, owned by discovery); Redis `rec:bought:{productId}` ZSETs (3-day TTL) and the build lock; no Postgres table
**Testing**: jest e2e through `/opt/sdd/repo/scripts/sdd/test-spec.sh` (five files in `test-plan.md`, keys R N B J P), unit specs U1–U6 beside `domain/`
**Target Platform**: Linux; `apps/core` (HTTP), `apps/worker` (build), `apps/projector` (baskets)
**Project Type**: backend domain module; web/BFF consumers owned by W02 / S48
**Performance Goals**: rail ≤ 300 ms p99 uncached (SC-001, ops artifact); build < 60 min at 1B lines (SC-007, ops artifact)
**Constraints**: store 100 ms, product lookup 100 ms, shop lookup 50 ms; no retry inside a request; pool ≤ 121 ids (R1 limit 500)
**Scale/Scope**: top 20 per product, 5 seeds, decay 0.5, 16 buckets by default

**Maximum staleness accepted (IX.7 R3)**: a paid order influences the lists after the next nightly build (≤ 24 h + build duration); a product or shop state change is reflected at origin immediately and at the CDN within 300 s (`s-maxage`). A list never outlives 3 days without a build.

**Connection arithmetic (III.12)**: not applicable, no Postgres connection is opened by this capability (R1 services use their own pools).

## Constitution Check

| Gate | Status | How |
|---|---|---|
| 1 Boundaries (I.1–I.3, X, no `forwardRef`, no `Scope.REQUEST`) | PASS after work | ports + tokens in `domain/` (`NeighbourListReader`, `NeighbourListWriter`, `BasketStore`, `BuildLock`, `CatalogFacts`, `Clock`); `api/` and `application/` import no `infra/`; pure rules take `now`/data as parameters; barrel exports modules only (D-8) |
| 2 Controllers (II.1) | PASS | one call to `RecommendationsService`; strict Zod parse, problem+json from the global filter; `no-store` default replaced only on success (same device as S33) |
| 3 Data access (III) | PASS / N/A | no Postgres; no `sequelize.transaction` in the touched files (baseline 0), none added; money is integer `priceMinor`; Redis keys all have a TTL; `SCAN` (never `KEYS`) in the removal pass; no principal-scoped records (public data, AS-06/AS-07) |
| 4 Migrations (III.11) | PASS | ClickHouse expand/contract: new table, replay, then a drop step (research R-3); no Postgres migration |
| 5 Messaging (IV.4–IV.6) | PASS after work | consumer validates with the `orderEventSchemas` schema, version-guarded upsert documented as `versionGuard`, poison → dead letter; explicit timeouts on Redis reads and both R1 calls; no retry in the request |
| 6 Contracts (V) | PASS after work | `recommendationsQuerySchema`, `recommendationsResponseSchema` in `packages/contracts/src/search/recommendations.ts`; codes `validation_failed`, `product_not_found`, `rate_limited`, `recommendations_unavailable`; `GET` changes no state |
| 7 Web (VI) | N/A here | W02 owns rendering (gaps.md follow-ups); BFF is S48's |
| 8 Tests (VII) | PASS after work | all 51 scenarios mapped in `test-plan.md`; consumer pair AS-30/AS-31; fallbacks forced (AS-39–AS-41, AS-43, AS-45, AS-46); contract parse in every `200` test |
| 9 Operational (VIII) | PASS after work | `recommendations_*` metrics with bounded labels, structured logs without buyer data, build single-run and idempotent (`fleetConcurrency: 1` + Redis lock), config validated at startup |
| 10 DB isolation (IX) | PASS after work | `ProductModel` and `forFeature([Product])` removed; facts via R1; orders via R3 topic; `check:table-ownership --strict` must show zero lines for the recommendations files (baseline 4 lines for the domain, 2 files + 1 module are ours) |
| 11 Monorepo (X) | PASS after work | domain code only; `apps/*` import `RecommendationsModule`, `RecommendationsWorkerModule`, `RecommendationsProjectorModule`; contracts in `packages/contracts` |

Post-design re-check: still PASS. Risks: the S10 `userId`/`orderVersion` fields must stay (they are in `orderEventSchemas` today); the web/BFF consumers still use the old shape until W02/S48 adopt it, but this plan updates the in-repo callers that would otherwise fail to compile (Technical tasks, step 5).

## Follow-ups from built sibling specs (treated as requirements)

1. **S05 → S34**: no `JOIN "Product"` / `ProductModel`; facts through `ProductQueryService.getProductsByIds(ids)` (one batch per request, no `shopId` option: public data). `forFeature([Product])` deleted. `ProductService.search` is not used here.
2. **S10 → S34**: `order-baskets.projector.ts` is replaced by a projector built on the new `order.paid` shape. Fields used: `orderId`, `userId`, `paidAt`, `lines[].productId`, `orderVersion` (all in `orderEventSchemas['order.paid']`); the renamed money fields (`totalMinor`, `unitPriceMinor`, …) are ignored. Basket e2e payloads are built from the new shape; `order.reserved`, `order.cancelled`, `order.refunded`, `order.fulfilment_changed` are ignored without dead-letter (AS-32).
3. **S49 → S34**: (a) `declareJobType` contract made strict (`days`/`buckets` bounds, unknown keys rejected), next to the `JobPayloads` augmentation; (b) `upsertSchedule` wrapped to catch `InvalidScheduleError` (not a generic `Error`); (c) no `JobsService.cancel` caller in this capability (grep-verified 2026-10-10); (d) `fleetConcurrency: 1`; (e) `maxRuntimeMs: 3_600_000` with `leaseMs: 3_600_000` (`handler-options.ts` requires `maxRuntimeMs ≥ leaseMs`, default 15 min), test that the handler options resolve.
4. **gaps.md items**: every row A1–A25, D-6, D-7, D-8, D-12 and the two ownership lines are in the technical tasks below; A23/A25 are consumer code owned by W02/S48 and appear under "Sibling-spec follow-ups" in `gaps.md`, but the in-repo compile-breaking callers are adapted here.

## Project Structure

### Documentation

```text
specs/domains/S34-recommendations/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/recommendations-api.md
└── tasks.md   # /speckit-tasks
```

### Source code (`packages/backend/libs/domains/discovery/`; contracts in `packages/contracts/src/search/`)

```text
packages/contracts/src/search/recommendations.ts   # query/response schemas, item type (A1, A22); export from search/index.ts
packages/backend/clickhouse/
├── 041_recommendation_baskets.sql                 # new table, ReplacingMergeTree(order_version) (A12, A19)
└── 042_drop_order_baskets.sql                     # contract step, applied after the replay (research R-3)
packages/backend/libs/common/config/recommendations-config.ts  # validated settings (A17, AS-51); registered in api-config.service.ts
discovery/
├── api/recommendations.controller.ts              # strict parse, @RateLimit('discovery.recommendations'), no-store default (A2, A10)
├── application/
│   ├── recommendations.service.ts                 # read use case: lists → expansion → R1 batch → rank (A3–A9)
│   ├── basket-capture.service.ts                  # projector use case: size rule, version guard, counters (A18, A19)
│   └── co-occurrence-build.service.ts             # build use case: lock, buckets, publish, removal, outcome (A11–A16)
├── domain/
│   ├── recommendation-ports.ts                    # NeighbourListReader/Writer, BasketStore, BuildLock, CatalogFacts + tokens (D-6)
│   ├── recommendation-ranking.ts (+spec U1)       # order, tie-break, cut
│   ├── two-hop-blend.ts (+spec U2)                # decay, best path, direct precedence, no self
│   ├── neighbour-entry.ts (+spec U3)              # sanitise stored entries
│   ├── cosine-score.ts (+spec U4)                 # co / sqrt(na·nb), 4-decimal rounding for the response
│   ├── basket.ts (+spec U5)                       # distinct, sorted, size bounds, reasons
│   ├── build-params.ts (+spec U6)                 # days/buckets validation and defaults
│   └── recommendation-events.ts                   # OrderPaid event definition (envelope + stricter payload schema)
├── infra/
│   ├── co-occurrence.jobs.ts                      # thin @JobHandler + schedule registration (fleetConcurrency 1, maxRuntimeMs 1 h)
│   ├── projectors/order-baskets.projector.ts      # moved from infra/order-baskets.projector.ts (D-8)
│   ├── redis-neighbour-lists.adapter.ts           # reader + writer: ZREVRANGE batch, staging+RENAME, SCAN removal
│   ├── clickhouse-basket-store.adapter.ts         # version lookup, insert, bucket query with buyers
│   ├── redis-build-lock.adapter.ts                # SET NX PX 1 h, owner token, compare-and-delete release
│   ├── catalog-facts.adapter.ts                   # ProductQueryService + ShopQueryService with timeouts (ACL, IV.8)
│   ├── recommendation-keys.ts                     # kept (keys, TTL), no longer imported by application/
│   ├── recommendations-config.ts                  # RecommendationsSettings from ApiConfigService
│   └── recommendations-metrics.ts                 # recommendations_* series
├── recommendations.module.ts                      # imports ProductModule/TenancyModule exports; no forFeature
├── recommendations-worker.module.ts
├── recommendations-projector.module.ts            # static projectors list for apps/projector
├── rate-limit-policies.ts                         # add discovery.recommendations (600/min, ip, fail open)
├── index.ts                                       # export the three modules only; drop OrderBasketsProjector
└── recommendations-{read,cold-start,baskets,build,platform}.e2e-spec.ts + recommendations.fixtures.ts  # replace recommendations.e2e-spec.ts
apps/projector/src/projector.module.ts             # import RecommendationsProjectorModule, list its projectors
```

In-repo callers adapted to the new response shape (compile and `bff.e2e-spec.ts`/web tests stay green): `libs/composition/bff/product-page.service.ts`, `libs/composition/bff/graphql/product.resolver.ts`, `packages/web/lib/api/catalog.ts`, `packages/web/app/products/[slug]/page.tsx`. The Playwright journey and BFF composition tests (A25) are W02/S48's and recorded in `gaps.md`.

**Structure Decision**: stay inside `discovery` with the standard layers; the old `RecommendationsService`/`CoOccurrenceJobs` classes keep their names so the module graph stays small, but each depends on ports. A new deployable app is not needed (I.6).

## Technical tasks by gap (input for `/speckit-tasks`)

Order follows `gaps.md` §D, test-first within each step.

1. **Contracts and DDL**: A22 (schemas), A12/A19 (new table), ports (D-6), config keys (A17, AS-51), metrics (A16).
2. **Projector**: A18, A19, A20, A24 (`RecommendationsProjectorModule`, move projector, apps wiring), then replay.
3. **Build**: A11, A12, A13, A14, A15, A16 (+ S49 follow-ups 3a–3e).
4. **Read**: A1–A10, D-7, D-12 (R1 adapter), rate-limit policy.
5. **Consumers in repo**: adapt BFF/GraphQL/web types (A23); Playwright/BFF composition tests are sibling follow-ups (A25).
6. **Contract step**: barrel (D-8), `forFeature([Product])` removal, `042_drop_order_baskets.sql`, `check:boundaries`, `check:table-ownership --strict`, `tsc --noEmit`, whole capability suite once.

## Complexity Tracking

None. (The new ClickHouse table instead of in-place `ALTER` is a technical necessity of changing a `ReplacingMergeTree` version column, not a rule exception; see research R-3.)
