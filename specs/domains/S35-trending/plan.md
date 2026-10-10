# Implementation Plan: S35 — Trending Products

**Branch**: `S35-trending` (working branch `sdd/auto`) | **Date**: 2026-10-10 | **Spec**: [spec.md](spec.md)

**Input**: `spec.md` (AS-01–AS-42), `test-plan.md`, `gaps.md` (T01–T57, D-6/D-7/D-8/D-12, ownership line), `questions.md` (defaults accepted as written), the constitution, and the follow-ups left by S05 and S50 (below).

## Summary

Rebuild the trending slice of `discovery` as two runtime paths that share ports in `domain/`:

1. **Count** (`apps/projector`, `TrendingProjectorModule`): a purpose-built consumer of `analytics.events` (group `discovery-trending-topk`) validates every message with `storedAnalyticsEventSchema`, normalises it (event time = earlier of `ts` / `received_at`, weight, category validity), applies the per-visitor and `event_id` caps, and keeps per-**partition** tumbling-window state (a Count-Min Sketch + min-heap per tracked category and `all`). A closed window is merged into the shared Redis aggregate by **one atomic, idempotent script** keyed by (partition, window, covered offsets). Offsets are committed only up to the **commit floor** (earliest offset of any unmerged window). Late events take a correction merge inside the 60-minute horizon. Idle partitions advance by the wall clock. Readiness reflects "subscribed"; a dead loop ends the process; shutdown merges and commits.
2. **Serve** (`apps/core`, `TrendingModule`): `GET /api/trending?category=&limit=` → strict query parse, rate limit `discovery.trending`, ranking of the last 60 closed windows (cached 30 s, single flight), one `getProductsByIds` and one `getShopsByIds` over the candidate pool (`min(3 × limit, 60)`), pure visibility + category filter and ranking, `200` envelope or problem+json (`400` / `429` / `503`).

Why a custom consumer and not the S53 `Projector` framework: the framework owns offsets and demands an event envelope; trending must hold the commit floor behind open windows and consumes the raw S39 analytics message (research R-1). It still reuses the S53 `DeadLetterWriter`, `ReadinessService`, `ShutdownRegistry`, `MetricsRegistry`, `CLOCK`.

All I/O crosses `domain/` ports with `infra/` adapters (D-6). Product and shop facts only through the R1 services (D-7, D-12). The barrel exports `TrendingModule` and `TrendingProjectorModule` only (D-8).

## Technical Context

**Language/Version**: TypeScript (strict), NestJS; Zod schemas in `packages/contracts`
**Primary Dependencies**: kafkajs via `createKafka` (`infrastructure/kafka`), `RedisService` (ioredis, Lua), `CacheModule.getOrLoad`, `DeadLetterWriter`, `ReadinessService`, `ShutdownRegistry`, `@app/infrastructure/rate-limit`, `MetricsRegistry`, `CLOCK`, `ApiConfigService` (joi keys), `ProductQueryService` (S05), `ShopQueryService` (S03), `storedAnalyticsEventSchema` (S39, contracts), `fast-check`
**Storage**: Redis only: `trending:{category}:{windowStartMs}` ZSET aggregates (3 h max TTL), `trending:merge:*` merge records, `trending:seen:*` correction dedupe keys. No Postgres table, no ClickHouse table (ownership registry unchanged)
**Testing**: jest e2e through `/opt/sdd/repo/scripts/sdd/test-spec.sh` (R, S, P in `test-plan.md`), unit specs U1–U8 beside `domain/`
**Target Platform**: Linux; `apps/core` (HTTP), `apps/projector` (consumer)
**Project Type**: backend domain module; web/BFF consumers owned by W02 / S48 (in-repo callers adapted so the build stays green)
**Performance Goals**: uncached p99 < 200 ms at 500 rps (SC-007, ops artifact); 30k events/s per consumer, lag < 60 s (SC-009, ops artifact)
**Constraints**: aggregate read 100 ms, product lookup 100 ms, shop lookup 50 ms, merge command 100 ms; no retry inside a request; merge retry: 3 attempts, backoff with full jitter, one layer
**Scale/Scope**: K = 50, window 60 s, lateness 2 min, idle 30 s, `all` sketch 2^16 × 4, category sketch 2^14 × 4, 100 categories per partition-window, memory budget 512 MB

**Maximum staleness accepted (IX.7 R3)**: an interaction is visible after at most window (1 min) + lateness (2 min) + idle timeout (30 s) + merge cycle ≈ 4 min, plus the 30-second ranking cache and the 30-second CDN copy; a product state change (stock, status, price, shop) is reflected at origin immediately and at the edge within 30 s (`s-maxage`).

**Connection arithmetic (III.12)**: not applicable, no Postgres connection is opened by this capability (R1 services use their own pools). Kafka: one consumer per projector instance; Redis: the shared client.

## Constitution Check

| Gate | Status | How |
|---|---|---|
| 1 Boundaries (I.1–I.3, X, no `forwardRef`, no `Scope.REQUEST`) | PASS after work | ports + tokens in `domain/` (`TrendingAggregateReader`, `TrendingAggregateWriter`, `TrendingCatalogFacts`, `CorrectionDedupe`); `api/` and `application/` import no `infra/` (T12); pure code takes `now` as a parameter (FR-028); the key helper, constants and Redis client live in `infra/` |
| 2 Controllers (II.1) | PASS | one call to `TrendingService`; strict Zod parse; headers set `no-store` first and replaced only on a body (S33/S34 device); problem+json from the global filter |
| 3 Data access (III) | PASS / N/A | no Postgres; `.tx.baseline` = 0, no `sequelize.transaction` in the touched files, none added (T05 removes the injected `Sequelize`); money is integer `priceMinor`; every Redis key has a TTL; no `KEYS`/`SCAN`, keys are computed |
| 4 Migrations (III.11) | N/A | no schema; key-space change is rolling (new keys `trending:{cat}:{ms}` unchanged in name, new `trending:merge:*` added; old 2 h aggregates age out) |
| 5 Messaging (IV.4–IV.6) | PASS after work | zod validation of every message, poison → `discovery-trending-topk.dlq` with a reason, idempotency declared (event cap + idempotent merge), at-least-once with the commit floor, explicit timeouts on connect, subscribe, Redis, both R1 calls, retry in one layer |
| 6 Contracts (V) | PASS after work | `trendingQuerySchema`, `trendingResponseSchema` in `packages/contracts/src/search/trending.ts`; codes `validation_failed`, `rate_limited`, `trending_unavailable`; `GET` changes no state; additive envelope |
| 7 Web (VI) | N/A here | W02 owns rendering and the Playwright journey; the in-repo page is adapted to the envelope only |
| 8 Tests (VII) | PASS after work | all 42 scenarios mapped in `test-plan.md`; consumer pair AS-29/AS-30; every fallback forced (AS-14, AS-15, AS-19, AS-21, AS-35, AS-40); `Math.random` gone from unit tests |
| 9 Operational (VIII) | PASS after work | `trending_*` metrics with fixed-enum labels; no visitor/buyer ids in logs; readiness = subscribed; shutdown merges and commits; config validated at startup |
| 10 DB isolation (IX) | PASS after work | raw SQL on `Product` and the injected `Sequelize` removed (D-12); `check:table-ownership --strict` shows zero trending lines (baseline: 1 of 7 is ours) |
| 11 Monorepo (X) | PASS after work | barrel exports the two modules only (D-8); `apps/*` import those; contracts in `packages/contracts` |

Post-design re-check: still PASS. Risks: (a) `storedAnalyticsEventSchema` is S39's; until S39 lands it is added to `packages/contracts` here exactly as `spec.md` "Requires" states, and S39 is told in `gaps.md`; (b) the cache's behaviour when Redis is down must be proven to throw rather than return empty (T10) — T-task checks `getOrLoad` first and wraps with a budget regardless; (c) the merge script touches several keys, which is fine on the single-node client used today and is documented as a constraint if Redis Cluster is ever adopted (research R-3).

## Follow-ups from built sibling specs (treated as requirements)

1. **S05 → S35**: no `JOIN "Product"` / `ProductModel` / raw SQL; facts through `ProductQueryService.getProductsByIds(ids)` (one batch per request, no `shopId` option: public data) plus `ShopQueryService.getShopsByIds` (S03). `Sequelize` injection and `application/` SQL deleted. `ProductService.search` is not used here.
2. **S50 → S35**: `discovery.trending` (300/min, key `ip`, fail open) is added to `discoveryRatePolicies` (the domain already registers the table through `RateLimitModule.forFeature`) and `@RateLimit('discovery.trending')` replaces `skipThrottle`. G-35 lists no mis-used policy at a trending call site (the trending controller used none, grep-verified 2026-10-10), so there is nothing to rename; `search.query` call sites of other domains are theirs.
3. **S32 A29 / D-8**: `TrendingConsumer`, `TrendingService` and `TrendingConsumerModule` leave the barrel; `apps/projector` imports `TrendingProjectorModule`.
4. **S54 toolkit**: no transaction in the trending files (baseline 0), so nothing to migrate and nothing to add.
5. **gaps.md items**: every row T01–T57, D-6, D-7, D-8, D-12 and the ownership line is in the technical tasks below; T53–T56 are consumer code owned by S48 / W02 / W03 / S39 and appear under "Sibling-spec follow-ups" in `gaps.md`, but the in-repo callers that would not compile or whose tests would fail are adapted here.

## Project Structure

### Documentation

```text
specs/domains/S35-trending/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/trending-api.md
└── tasks.md   # /speckit-tasks
```

### Source code (`packages/backend/libs/domains/discovery/`; contracts in `packages/contracts/src/search/`)

```text
packages/contracts/src/search/trending.ts          # trendingQuerySchema, trendingResponseSchema, item type (T03); exported from search/index.ts
packages/contracts/src/analytics/stored-event.ts   # storedAnalyticsEventSchema (S39 shape) if S39 has not added it (T20)
packages/backend/libs/common/config/trending-config.ts  # joi keys + defaults (T31, AS-37); registered in api-config.service.ts
discovery/
├── api/trending.controller.ts                     # strict parse, @RateLimit('discovery.trending'), no-store default (T02, T09, T14)
├── application/
│   ├── trending.service.ts                        # read use case: ranking (cached) → R1 facts → visibility → rank (T01-T14)
│   └── trending-ingest.service.ts                 # stream use case: normalise, caps, windows, merge, commit floor, metrics (T20-T35)
├── domain/
│   ├── trending-ports.ts                          # aggregate reader/writer, catalog facts, correction dedupe + tokens (D-6)
│   ├── count-min-sketch.ts (+spec U1)             # saturating add, merge, fixed memory
│   ├── top-k.ts (+spec U2)                        # min-heap, in-place update, code-unit tie order (split out of count-min-sketch.ts)
│   ├── tumbling-windows.ts (+spec U3)             # per-partition state, watermark, idle advance, classification open|late|correction|dropped
│   ├── trending-event.ts (+spec U5)               # normalisation, weights, event time, category validity
│   ├── visitor-cap.ts (+spec U7)                  # Bloom-style membership, per window
│   ├── trending-ranking.ts (+spec U4)             # serving window arithmetic, order, tie-break, pool size, visibility filter
│   ├── trending-config.ts (+spec U6)              # pure validation of settings
│   ├── commit-floor.ts (+spec in U3 file)         # earliest unmerged offset per partition
│   ├── trending-accuracy.spec.ts (U8)             # seeded stream, precision vs exact top-K
│   └── trending-errors.ts                         # TrendingUnavailableError (503 + Retry-After 5)
├── infra/
│   ├── trending.consumer.ts                       # kafkajs loop (rewritten): batches → ingest service, floor commit, readiness, exit on dead loop
│   ├── redis-trending-aggregate.adapter.ts        # reader (ZUNION over computed keys, budgets) + writer (atomic idempotent merge script)
│   ├── redis-correction-dedupe.adapter.ts         # SET NX EX for late-event ids
│   ├── trending-catalog-facts.adapter.ts          # ProductQueryService + ShopQueryService under budgets (ACL, IV.8)
│   ├── trending-keys.ts                           # sole owner of the key space (AS-39)
│   ├── trending-config.ts                         # TrendingSettings from ApiConfigService
│   └── trending-metrics.ts                        # trending_* series
├── trending.module.ts                             # TrendingModule (core) and TrendingProjectorModule (projector)
├── rate-limit-policies.ts                         # add discovery.trending (300/min, ip, fail open)
├── index.ts                                       # export TrendingModule, TrendingProjectorModule only (D-8)
└── trending-{read,stream,platform}.e2e-spec.ts + trending.fixtures.ts
libs/domains/marketing/ads.e2e-spec.ts             # trending case and its imports removed by hand (T52, T57)
apps/projector/src/projector.module.ts             # import TrendingProjectorModule (T50)
apps/core/src/core.module.ts                       # TrendingModule stays; confirm ProductModule/TenancyModule loaded
```

In-repo callers adapted to the new envelope: `libs/composition/bff/product-page.service.ts`, `libs/composition/bff/bff.e2e-spec.ts` (stub becomes the envelope), `packages/web/app/page.tsx` (type from contracts, `priceMinor`/`currency`, implementation note removed). The BFF composition test of AS-42, the Playwright journey (AS-41) and the event emitters (T55) are S48 / W02 / W03 / S39's and recorded in `gaps.md`.

**Structure Decision**: stay inside `discovery`; the old `TrendingService`/`TrendingConsumer` classes keep their names so the module graph stays small, but each depends on ports. No new deployable (I.6).

## Technical tasks by gap (input for `/speckit-tasks`)

Order follows `gaps.md` §D, test-first within each step.

1. **Contracts, config, policy**: T03 (schemas), `storedAnalyticsEventSchema`, T31/AS-37 (config keys + pure validation U6), T09 policy declaration, metrics (T35), ports (D-6, T12).
2. **Pure logic (unit, seeded)**: T40 (saturation), T41/T43 (heap order, seeded generator), T42 (merge), T44/T13/T22/T23/T24 (windows: event time, idle, classification), T28 (visitor cap), T08/T07 (pool, order), AS-16/AS-20 (event normalisation), commit floor. Gate: U1–U8 green.
3. **Stream**: T20–T21, T25–T27, T29–T30, T32–T34 (consumer rewrite, per-partition sketches, idempotent merge script, correction path, retention T34, backpressure, readiness, shutdown) with `trending-stream.e2e-spec.ts`; move the ads case out (T52, T57).
4. **Read**: T01, T02, T04–T06, T08, T10, T11, T13, T14, D-7, D-12 (R1 adapter), rate limit; `trending-read.e2e-spec.ts`.
5. **Platform**: T50, T51, D-8 barrel and app modules; `trending-platform.e2e-spec.ts` (metrics, config boot failure, boundary, retention, readiness).
6. **Callers in repo**: BFF service + stub, web home page (T53, T54 compile-level); T55/T56 and AS-41/AS-42 tests are sibling follow-ups.
7. **Gates**: `pnpm check:boundaries`, `pnpm check:table-ownership --strict`, `pnpm exec tsc --noEmit`, ESLint, then the whole capability suite once (VII.9); ops artifacts into `specs/UNVERIFIED.md`.

## Complexity Tracking

None. The custom consumer loop instead of the S53 `Projector` framework is a technical necessity (commit floor, raw non-envelope message), not a rule exception; see research R-1.
