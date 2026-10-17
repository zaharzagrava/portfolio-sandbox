# Implementation Plan: S40 — Seller Leaderboards, Live Sales Dashboard, Seller Stats (`seller-insights`)

**Branch**: `S40-leaderboards-dashboard` | **Date**: 2026-10-17 | **Spec**: [spec.md](spec.md)

**Input**: `spec.md`, `test-plan.md`, `gaps.md` (A1–A51, B, C, D), `questions.md` (defaults accepted), the eleven follow-ups listed in the planning request (traced in the table below).

## Summary

The domain already has a thin, partly wrong implementation (board projector on a Redis sorted set, a ticker over `PUBSUB NUMSUB`, snapshots, a ClickHouse `shop_sales` table, a `seller_sales`-based stats service nothing writes). The plan keeps the store choices and rebuilds the behaviour around the spec:

1. **Pure domain core** (`domain/`): periods, ranking key (revenue in the high bits, inverted instant in the low bits, 2^33 revenue ceiling), rank percent, conversion, average order value, event-to-fact mapping. Unit-tested.
2. **Ports in `domain/`, adapters in `infra/`** (D-6): `BoardRepository` (Redis, one Lua script per `(order, period)`), `SnapshotRepository` (Postgres), `LiveCounterRepository` (Redis), `SalesHistoryRepository` (ClickHouse), `ShopDirectory` and `ProductCategoryDirectory` (own Postgres read models).
3. **Own read models** (R3) for shop name/slug and product category, fed by `tenancy.shop_*` and `catalog.product_*`; erasure on `tenancy.shop_deleted`. No `ProductModel`, `ShopModel`, or `"Shop"` SQL remains (D-7, D-12, section C).
4. **Three order consumers** (board, live counters, sales history) plus refund, shop, product consumers, all with schemas from `packages/contracts`, DLQ with reason code, and exactly-once apply. Exposed as one `SellerInsightsProjectorModule` with a static `projectors` list (pattern of `community/feed-projectors.module.ts`); the barrel stops exporting classes (D-8).
5. **Reads**: strict zod query DTOs, `GET /leaderboards` (public, rate limited), `GET /shops/:shopId/rank`, `/dashboard/today`, `/stats` behind `ShopScoped('shop.read')`; contracts response schemas; 503 mapping and timeouts.
6. **Ticker**: subscriber discovery by `RealtimeSubscriptions.topicsWithSubscribers('shop','live')` (S51 follow-up), one Redis lease per shop, non-overlapping ticks, graceful shutdown.
7. **Snapshots**: scheduled through S49 (`upsertSchedule`), due at period end + 1 h, catch-up, atomic replace per board via `TransactionRunner`.
8. **Analytics facts** in ClickHouse: one `shop_sale_facts` / `shop_refund_facts` pair, deduplicated at read (`argMax`/`GROUP BY` on `(order_id, product_id)`), DDL as a migration step, `seller_sales` dropped.
9. **Living spec**: write `docs/spec/capabilities/S40-leaderboards-dashboard.md` first (J01 follow-up: states that revenue is `lineTotalMinor`), keeping `[proof:]`/`[code:]` true.

## Technical Context

**Language/Version**: TypeScript (NestJS monorepo, `packages/backend`, `packages/contracts`, `packages/web` client).

**Primary Dependencies**: NestJS, Sequelize (Postgres), ioredis (Lua), `@clickhouse/client` via `infrastructure/clickhouse`, `infrastructure/projections` (S53), `infrastructure/jobs` (S49), `infrastructure/rate-limit` (S50), `infrastructure/realtime` (S51), TransactionRunner (S54), zod, `fast-check` (already used in the repo for property tests).

**Storage**: Redis (boards, applied-order sets, live counters, ticker leases), Postgres (`LeaderboardSnapshot` + new `SellerInsightsShop`, `SellerInsightsProduct`), ClickHouse (sale and refund facts).

**Testing**: jest e2e via `scripts/sdd/test-spec.sh`, unit specs beside `domain/` code; the eight e2e files and five unit files of `test-plan.md`.

**Target Platform**: Linux services: `apps/api` (reads), `apps/worker` (ticker, snapshot jobs), `apps/projector` (consumers).

**Project Type**: web-service monorepo (backend domain + contracts + web client touch-up).

**Performance Goals**: boards/live within 5 s p99; analytics within 30 s p99; public top list cached (`s-maxage`), 99% < 100 ms (SC-005, unverified).

**Constraints**: board store 500 ms and analytics 3 s timeouts; revenue ≤ 2^33 − 1 per shop and period; no cross-domain tables.

**Scale/Scope**: 62 acceptance scenarios, ~600k shops per board as the design ceiling (exact rank via `ZREVRANK`).

No NEEDS CLARIFICATION remain (see `research.md`).

## Constitution Check

| Principle | Status | How |
|---|---|---|
| I Layered modules | Pass (fixes D-6) | ports in `domain/`, adapters in `infra/`, `api` → `application` → `domain` |
| II Routing | Pass | routes under `/shops/:shopId/...` and public `/leaderboards`; removes `/sellers/me/stats` and `/leaderboards/shops/:id` |
| III Data/transactions | Pass | snapshot replace and read-model upserts through `TransactionRunner.run`; the existing `sequelize.transaction` at `infra/leaderboard-snapshot.jobs.ts:89` is migrated and its `// S54 T037 audit` comment deleted; migration uses `lock_timeout`; no new direct sites |
| IV Communication | Pass | membership via `ShopScoped`/`ShopAccessService` (S03 follow-up); no model injection of other domains |
| V API contracts | Pass | zod DTOs, strict (unknown/repeated rejected), problem+json, schemas in contracts |
| VI Frontend | Pass | only `packages/web/lib/api/shops.ts` route and field names change |
| VII Testing | Pass | test-plan covers every AS; duplicate and invalid-payload tests for every consumer (J01 follow-up); no hollow assertions (L-003) |
| VIII Operations | Pass | metrics, structured logs, graceful shutdown, fail-open limiter |
| IX Data isolation | Pass (fixes D-7, D-12) | two new tables registered in `db/ownership.ts`; R3 read models; `check:table-ownership --strict` zero findings |
| X Monorepo | Pass (fixes D-8) | barrel exports modules only |

Post-design re-check: unchanged, no violation to justify. Complexity Tracking is empty.

## Follow-ups and gaps traceability

| Item | Plan answer | Workstream |
|---|---|---|
| A1–A12, A50 board feed | new `BoardFeed` apply script + domain arithmetic | WS3 |
| A13, AS-61 | `seller-insights.metrics.ts`, lag gauge | WS10 |
| A14–A22 | read services, DTOs, limiter, timeouts, snapshot-first reads | WS4 |
| A23–A25 | snapshot job rewrite | WS5 |
| A26–A34 | live counters, ticker | WS6 |
| A35–A44 | facts table, today, stats, refunds | WS7 |
| A45, A49 | read-model consumers, erasure | WS2, WS9 |
| A46, B (D-6..D-12), C | ports, projector module, ownership | WS1, WS2, WS11 |
| A47 | new e2e files replace `leaderboards.e2e-spec.ts` (every old scenario kept, L-017) | WS12 |
| A48, D1 | contracts | WS1 |
| A51 | web client and k6 script | WS8 |
| (S03) ShopAccessService / ShopQueryService | gates only via `ShopScoped`; no tenancy model or SQL; retest `payouts.read`-style status gate: write permissions are not used here, `shop.read` on a SUSPENDED shop answers 200 (AS-26/47/52), DELETED/offboarding answer 404 per S03 | WS4, WS12 |
| (S05) full-state `catalog.product_*` | product read model keeps `category`, `productVersion`; compacted topic replay gives latest per key; `product_deleted` keeps last category (AS-59); stops reading `Product` | WS2 |
| (S09) `catalogsync.offline_conflict_opened` | not consumed (optional); recorded in gaps.md as not adopted | — |
| (S10) renamed order events | consumers read `totalMinor`, `lines[].unitPriceMinor/lineTotalMinor/title`, `paymentRef`, `order.refunded`; importer files in S40 domain updated; `leaderboards.e2e-spec.ts` payloads rebuilt with contract factories | WS3, WS6, WS7 |
| (S11) `flashsale.*` names | S40 consumes no flash-sale event; invalid or foreign types on `orders.events` are ignored without DLQ (AS-10); noted | WS3 |
| (S13) `paymentEventSchemas` | S40 does not consume `payments.events` (questions: settled money out of scope); noted | — |
| (S14) `ledger.*` | not consumed (no table reads) | — |
| (S23) `live.reactions_aggregated`, `comment_removed` v2 | not consumed (dashboard shows order sales only) | — |
| (S51) `topicsWithSubscribers` | ticker uses it; on `RealtimeUnavailableError` falls back to its own list of recently-seen subscribed shops (kept in Redis with short TTL) | WS6 |
| (J01) `lineTotalMinor` | AS-01/37/46; stated in the living page | WS0 |
| (J01) same-message-twice, invalid payload | per-consumer tests in test-plan | WS12 |

## Project Structure

### Documentation (this feature)

```text
specs/domains/S40-leaderboards-dashboard/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/            # http-routes.md, events-consumed.md, realtime-frame.md, schemas.md
└── tasks.md              # next command
```

### Source Code

```text
packages/contracts/src/seller-insights/
  index.ts  leaderboard.ts  rank.ts  dashboard.ts  stats.ts  live-frame.ts  consumed-events.ts
packages/backend/libs/domains/seller-insights/
  domain/        periods.ts ranking-key.ts rank-percent.ts conversion.ts average-order-value.ts
                 sale-facts.ts ports.ts errors.ts   (+ *.spec.ts)
  application/   leaderboard-read.service.ts  shop-rank.service.ts  snapshot.service.ts
                 live-dashboard.service.ts  dashboard-today.service.ts  seller-stats.service.ts
                 erasure.service.ts  seller-insights.metrics.ts
  infra/         redis-board.repository.ts  board.lua.ts  redis-live-counter.repository.ts
                 pg-snapshot.repository.ts  pg-shop-directory.ts  pg-product-categories.ts
                 clickhouse-sales-history.ts  dashboard-ticker.service.ts  lease.ts
                 snapshot.jobs.ts  projectors/{board,live,sales,refund,shop,product,erasure}.projector.ts
                 models/{seller-insights-shop,seller-insights-product,leaderboard-snapshot}.model.ts
  api/           leaderboards.controller.ts  shop-rank.controller.ts  dashboard.controller.ts
                 seller-stats.controller.ts  query-dtos.ts  rate-limit-policies.ts
  leaderboards.module.ts  seller-stats.module.ts  leaderboards-worker.module.ts
  seller-insights-projector.module.ts  index.ts
packages/backend/migrations/<ts>-seller-insights-s40-expand.js   (Postgres) 
packages/backend/clickhouse/051_shop_sale_facts.sql, 052_drop_seller_sales (drop 001/050 usage)
docs/spec/capabilities/S40-leaderboards-dashboard.md
```

**Structure Decision**: keep the existing domain folder and the three-app split; the crawler files (S41) are untouched.

## Workstreams (inputs to tasks.md)

- **WS0** Living page first, then SC/UNVERIFIED rows.
- **WS1** Contracts + pure domain + unit specs (AS-07, 14, 29, 40, 56).
- **WS2** Postgres migration (two read-model tables, snapshot columns `shopName`, `participants`, unique `(periodKind, periodId, category, rank)`), ownership entries, shop/product consumers (AS-58/59).
- **WS3** Board feed: Lua script per `(order, period)`: sealed check (flag key `lb:sealed:{period}`), applied-set `SADD`, revenue ceiling check across all boards before any write, `ZADD` with ranking key from `max(previous instant, new instant)`; TTL = period end + 35 d on every key; outcome counters.
- **WS4** Reads and rank (rank/of/revenue in one Lua/`MULTI` call), snapshot-first for frozen periods, Cache-Control per source, limiter policy, 503 mapping.
- **WS5** Snapshot service/jobs and schedules (Monday/day 1 01:00 UTC), catch-up, `period_not_closed`/`invalid_period`.
- **WS6** Live counters (atomic mark+increments in Lua, mark TTL longer than the window plus replay allowance, stale guard), ticker.
- **WS7** ClickHouse facts, today, stats, refund consumer (retry 5 then DLQ, `partial_refund_unsupported`).
- **WS8** Remove old routes, update `packages/web/lib/api/shops.ts`, load-test seeder and k6 script; sibling follow-ups in gaps.md.
- **WS9** Erasure across all stores (AS-60).
- **WS10** Metrics and logs (AS-61).
- **WS11** Module/barrel/ownership cleanup (AS-62), remove direct `sequelize.transaction`.
- **WS12** E2E rewrites per test-plan; final capability suite once.

## Complexity Tracking

None.
