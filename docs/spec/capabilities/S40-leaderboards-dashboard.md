---
id: S40
title: Seller leaderboards, live sales dashboard and seller stats (period boards with ties, my rank, snapshots, live frames, today chart, shop stats)
kind: capability
status: draft
depends_on: [S01, S03, S05, S10, S49, S50, S51, S53, S54]
concepts: [projection-and-replay, rate-limit-policy, realtime-topic-stream, problem-json-errors, tenant-shop-rbac]
models: []
scope:
  - packages/backend/libs/domains/seller-insights/domain/*.ts
  - packages/backend/libs/domains/seller-insights/application/dashboard-today.service.ts
  - packages/backend/libs/domains/seller-insights/application/erasure.service.ts
  - packages/backend/libs/domains/seller-insights/application/leaderboard-read.service.ts
  - packages/backend/libs/domains/seller-insights/application/seller-insights.metrics.ts
  - packages/backend/libs/domains/seller-insights/application/seller-stats.service.ts
  - packages/backend/libs/domains/seller-insights/application/shop-rank.service.ts
  - packages/backend/libs/domains/seller-insights/application/snapshot.service.ts
  - packages/backend/libs/domains/seller-insights/api/*.ts
  - packages/backend/libs/domains/seller-insights/infra/board.lua.ts
  - packages/backend/libs/domains/seller-insights/infra/clickhouse-sales-history.ts
  - packages/backend/libs/domains/seller-insights/infra/dashboard-ticker.service.ts
  - packages/backend/libs/domains/seller-insights/infra/lease.ts
  - packages/backend/libs/domains/seller-insights/infra/pg-*.ts
  - packages/backend/libs/domains/seller-insights/infra/redis-*.ts
  - packages/backend/libs/domains/seller-insights/infra/snapshot.jobs.ts
  - packages/backend/libs/domains/seller-insights/infra/projectors/*.ts
  - packages/backend/libs/domains/seller-insights/infra/models/*.ts
  - packages/backend/libs/domains/seller-insights/leaderboards*.module.ts
  - packages/backend/libs/domains/seller-insights/seller-*.module.ts
  - packages/backend/libs/domains/seller-insights/index.ts
  - packages/contracts/src/seller-insights/*.ts
  - packages/backend/clickhouse/051_shop_sale_facts.sql
---
# S40 - Seller leaderboards, live sales dashboard and seller stats (period boards with ties, my rank, snapshots, live frames, today chart, shop stats)
## Purpose
Paid orders feed three read models of a shop's sales: weekly and monthly top-seller boards (overall and per product category), per-second live counters that a ticker pushes to the shop's dashboard, and an exact sales history that answers "today" and the last N days. Everything counts what the buyer paid, the sum of `lineTotalMinor` of a shop's lines, never unit price times quantity. The public top list shows rank, shop, slug and name only; a shop's own revenue and rank reach its members only. Closed periods are frozen as top-100 snapshots, and a deleted shop leaves every store. The domain keeps its own copies of shop names and product categories, fed by events, and reads no table of another domain.

## Entry points
- `GET /api/leaderboards` (anonymous, rate limited) answers the top list of one board. [code: packages/backend/libs/domains/seller-insights/api/leaderboards.controller.ts#LeaderboardsController]
- `GET /api/shops/:shopId/rank`, `GET /api/shops/:shopId/dashboard/today` and `GET /api/shops/:shopId/stats` need membership of the shop. [code: packages/backend/libs/domains/seller-insights/api/shop-rank.controller.ts#ShopRankController] [code: packages/backend/libs/domains/seller-insights/api/dashboard.controller.ts#DashboardController] [code: packages/backend/libs/domains/seller-insights/api/seller-stats.controller.ts#SellerStatsController]
- Realtime topic `shop:{shopId}:live`, event `dashboard`, one frame per second per watched shop. [code: packages/backend/libs/domains/seller-insights/infra/dashboard-ticker.service.ts#DashboardTicker]
- Consumers of `orders.events` (boards, live counters, sales history, refunds), `products.events` and the tenancy shop events, listed by `SellerInsightsProjectorModule.projectors`. [code: packages/backend/libs/domains/seller-insights/seller-insights-projector.module.ts#SellerInsightsProjectorModule]
- Jobs `seller-insights.snapshot.weekly` (Monday 01:00 UTC) and `seller-insights.snapshot.monthly` (day 1, 01:00 UTC). [code: packages/backend/libs/domains/seller-insights/infra/snapshot.jobs.ts#SnapshotJobs]

## Rules
- **S40.R-01** A paid order MUST add to the weekly and monthly boards of its `paidAt` (UTC) the sum of its `lineTotalMinor` per shop: to the overall board and, when the product's category is known, to that category's board; a shop without revenue is on no board. [proof: S40 AS-01, S40 AS-07, S40 AS-08, S40 AS-15] [code: packages/backend/libs/domains/seller-insights/domain/sale-facts.ts#boardPlan]
- **S40.R-02** An order MUST be applied once per period however often, in whatever order and by however many consumers at once it is delivered, and to all boards of the period or to none. [proof: S40 AS-02, S40 AS-03, S40 AS-13] [code: packages/backend/libs/domains/seller-insights/infra/board.lua.ts#APPLY_ORDER_SCRIPT]
- **S40.R-03** Boards MUST rank by revenue, then by the shop's latest sale instant (one second for weeks, one minute for months), then by larger shop id first; the latest instant MUST NOT move back when an older sale arrives later, so a rebuild by replay in any order gives the same boards. [proof: S40 AS-04, S40 AS-05, S40 AS-06, S40 AS-12, S40 AS-14] [code: packages/backend/libs/domains/seller-insights/domain/ranking-key.ts#rankingKey]
- **S40.R-04** A shop's revenue in a period MUST stay at or below 2^33 - 1 minor units; an order that would pass it MUST be dead-lettered whole as `revenue_limit_exceeded`. [proof: S40 AS-13, S40 AS-14] [code: packages/backend/libs/domains/seller-insights/domain/ranking-key.ts#MAX_REVENUE_MINOR]
- **S40.R-05** Every key of a period MUST expire 35 days after the period ends, counted from the injected clock, and none may be stored without an expiry. [proof: S40 AS-16] [code: packages/backend/libs/domains/seller-insights/infra/redis-board.repository.ts#RedisBoardRepository]
- **S40.R-06** A message that is not a valid paid order of the platform currency MUST be dead-lettered with a reason code (`invalid_payload`, `unsupported_currency`, `revenue_limit_exceeded`) without changing a board, and MUST NOT hold back the next message; the live-counter and sales-history consumers MUST judge the same messages the same way. [proof: S40 AS-10] [code: packages/backend/libs/domains/seller-insights/infra/projectors/support.ts#parsePaid]
- **S40.R-07** A product without a known category MUST count on the overall board only and increment `category_unresolved`; a sale MUST NOT be re-attributed when its category becomes known later. [proof: S40 AS-11] [code: packages/backend/libs/domains/seller-insights/infra/projectors/board.projector.ts#BoardProjector]
- **S40.R-08** An event for a frozen period MUST be acknowledged without being applied, counted as `sealed` and logged once with the order and the period, while the other period of the same event is applied. [proof: S40 AS-09] [code: packages/backend/libs/domains/seller-insights/infra/projectors/board.projector.ts#BoardProjector]
- **S40.R-09** The public top list MUST answer without credentials with entries of `rank`, `shopId`, `slug` and `name` only, never a revenue or a user id, with `Cache-Control: public, max-age=10, s-maxage=30` for a live board. [proof: S40 AS-17, S40 AS-18] [code: packages/contracts/src/seller-insights/leaderboard.ts#leaderboardPageSchema]
- **S40.R-10** Selectors MUST be validated strictly: an unknown, repeated or malformed parameter is `400 validation_failed` naming the field, and a period after the current one is `422 period_in_future`. [proof: S40 AS-19] [code: packages/backend/libs/domains/seller-insights/api/query-dtos.ts#parseTopQuery]
- **S40.R-11** Shop names and slugs on the list MUST come from this domain's own read model with a version guard (a shop without a row is listed with a null name and slug, a stale rename is ignored), and the top-list route MUST allow 60 requests a minute per address, answer `429 rate_limited` after that and serve when the limiter store is down. [proof: S40 AS-20, S40 AS-21, S40 AS-58] [code: packages/backend/libs/domains/seller-insights/api/rate-limit-policies.ts#sellerInsightsRatePolicies]
- **S40.R-12** A frozen period MUST be read from its snapshot only (`source: "snapshot"`, `closed: true`, `Cache-Control: public, max-age=3600, s-maxage=86400`); with the board store down a current period MUST answer `503` with `Retry-After: 5` and a generic detail within a second, and a frozen period MUST still be served. [proof: S40 AS-22, S40 AS-23] [code: packages/backend/libs/domains/seller-insights/application/leaderboard-read.service.ts#LeaderboardReadService]
- **S40.R-13** A member of a shop, whatever the role, MUST get the shop's `rank`, `of`, `topPercent = max(1, ceil(rank / of * 100))` and revenue read in one step, equal to its position in the top list of the same board; a shop without revenue on the board gets `404 not_ranked`. [proof: S40 AS-24, S40 AS-25, S40 AS-27, S40 AS-29] [code: packages/backend/libs/domains/seller-insights/application/shop-rank.service.ts#ShopRankService]
- **S40.R-14** A non-member, an unknown shop and a malformed id MUST be indistinguishable (`404 shop_not_found`) on every shop route of this capability, a missing session is `401`, a suspended shop answers `200` and a deleted one `404`. [proof: S40 AS-26, S40 AS-47, S40 AS-52] [code: packages/backend/libs/domains/seller-insights/api/shop-rank.controller.ts#ShopRankController]
- **S40.R-15** In a frozen period the rank MUST come from the snapshot (top 100 only: a shop below it is `not_ranked`), and a closed period that is not frozen yet from the live board. [proof: S40 AS-28, S40 AS-30] [code: packages/backend/libs/domains/seller-insights/infra/pg-snapshot.repository.ts#PgSnapshotRepository]
- **S40.R-16** One hour after a period ends, its three kinds of board MUST be frozen as the top 100 with the shop name as of then, the revenue and the number of participants; a period that is not closed, a future one or a malformed id MUST be refused and change nothing. [proof: S40 AS-31, S40 AS-32] [code: packages/backend/libs/domains/seller-insights/application/snapshot.service.ts#SnapshotService]
- **S40.R-17** Freezing MUST be idempotent and atomic per board: a re-run or concurrent run leaves the same rows and a reader never sees an empty or partial list; each run MUST also freeze every closed, unfrozen period that still has boards, oldest first, and skip one without boards with a warning. [proof: S40 AS-33, S40 AS-34] [code: packages/backend/libs/domains/seller-insights/infra/pg-snapshot.repository.ts#PgSnapshotRepository]
- **S40.R-18** The two snapshot schedules MUST be registered idempotently at every boot, the first-version schedules removed, and a schedule that fires on several replicas MUST run once. [proof: S40 AS-35] [code: packages/backend/libs/domains/seller-insights/infra/snapshot.jobs.ts#SnapshotJobs]
- **S40.R-19** A snapshot MUST keep the shop name it was frozen with, a shop unknown at that time with a null name. [proof: S40 AS-36] [code: packages/backend/libs/domains/seller-insights/application/snapshot.service.ts#SnapshotService]
- **S40.R-20** Per shop and second the live counters MUST count checkouts (once per shop per reservation) and orders, units and revenue (once per shop per paid order); the mark of an event and its increments MUST be one atomic step, so a redelivery counts it once and a failed attempt leaves nothing; an event older than the 60-second window MUST change no counter. [proof: S40 AS-37, S40 AS-38, S40 AS-39, S40 AS-41] [code: packages/backend/libs/domains/seller-insights/infra/redis-live-counter.repository.ts#RedisLiveCounterRepository]
- **S40.R-21** Once a second, for every shop with a subscriber on `shop:{id}:live` and only those, exactly one frame `{shopId, at, windowSeconds, last60s, ordersPerSecond, checkoutConversion}` MUST be published without replay, with `checkoutConversion = round(orders / checkouts, 3)` or null. [proof: S40 AS-37, S40 AS-40, S40 AS-42, S40 AS-45] [code: packages/backend/libs/domains/seller-insights/domain/dashboard-frame.ts#buildFrame]
- **S40.R-22** One lease per shop MUST give one publisher per shop across ticker instances, and a stopped holder MUST be replaced within 5 seconds; a tick that overruns MUST make the next one skip instead of overlapping, and shutdown MUST finish the tick in progress, publish nothing afterwards and release the leases. [proof: S40 AS-43, S40 AS-44, S40 AS-49] [code: packages/backend/libs/domains/seller-insights/infra/dashboard-ticker.service.ts#DashboardTicker]
- **S40.R-23** "Today" MUST return the UTC day's totals and sparse per-minute series from the exact sales history, and the stats the last N UTC days (`days` 1 to 365, default 30) with a zero-filled daily series, the five best products and no buyer identity; the figures MUST be exact under redelivery, replay, compaction and an order split over batches, and `avgOrderValueMinor` MUST round half up. [proof: S40 AS-46, S40 AS-50, S40 AS-51, S40 AS-54, S40 AS-55, S40 AS-56, S40 AS-57] [code: packages/backend/libs/domains/seller-insights/application/seller-stats.service.ts#SellerStatsService]
- **S40.R-24** With the analytics store down or slower than 3 seconds, "today" and stats MUST answer `503` with `Retry-After: 5` and a generic detail within 4 seconds, and the live frames MUST keep flowing. [proof: S40 AS-48] [code: packages/backend/libs/domains/seller-insights/infra/clickhouse-sales-history.ts#ClickHouseSalesHistory]
- **S40.R-25** A full refund MUST be recorded against each shop's recorded share on the refund day; a refund without a recorded sale MUST be tried 5 times and dead-lettered as `refund_without_sale`, a partial amount dead-lettered as `partial_refund_unsupported`, and neither may change the history, the boards or the live counters. [proof: S40 AS-53] [code: packages/backend/libs/domains/seller-insights/infra/projectors/refund.projector.ts#RefundProjector]
- **S40.R-26** The shop and product read models MUST move forward only (version-guarded upserts), a deleted product MUST keep its last category, and an invalid message MUST be dead-lettered with no effect. [proof: S40 AS-58, S40 AS-59] [code: packages/backend/libs/domains/seller-insights/infra/projectors/read-model.projectors.ts#ProductCategoryProjector]
- **S40.R-27** On `tenancy.shop_deleted` every trace of the shop MUST leave every store (boards, snapshot rows with the rest renumbered, live counters, sales and refund facts, both read models), and a repeat MUST change nothing. [proof: S40 AS-60] [code: packages/backend/libs/domains/seller-insights/application/erasure.service.ts#ErasureService]
- **S40.R-28** Outcome counters (`leaderboard_events_total{outcome}`), a feed-lag gauge and the tick counters MUST exist, and every log line of the feeds and the ticker MUST be one JSON object with a correlation id and no buyer id, e-mail or payload. [proof: S40 AS-61] [code: packages/backend/libs/domains/seller-insights/application/seller-insights.metrics.ts#insightsMetrics]
- **S40.R-29** The domain MUST read no table or model of another domain and MUST NOT open a transaction by hand; its entry point MUST export modules only. [proof: S40 AS-62] [code: packages/backend/libs/domains/seller-insights/index.ts]

## Behaviors
- **S40.B-01** Given a paid order of two lines for a shop, when it is consumed twice, then the shop has the sum of the two `lineTotalMinor` on the overall board once. [proof: S40 AS-01, S40 AS-02]
- **S40.B-02** Given two shops with the same revenue, when one reached it earlier, then it ranks first, and a later sale of the other never moves it back. [proof: S40 AS-04, S40 AS-05]
- **S40.B-03** Given a closed week, when the weekly job runs one hour after it ended, then its top 100 are stored and the week is served from the snapshot. [proof: S40 AS-31, S40 AS-22]
- **S40.B-04** Given a member watching their shop, when a sale arrives, then the next frame shows it and it fades from the window after 60 seconds. [proof: S40 AS-42]
- **S40.B-05** Given a stranger, when they ask for another shop's rank, then the answer is the same `404` as for a shop that does not exist. [proof: S40 AS-26]
- **S40.B-06** Given a full refund, when it is consumed, then each shop's refunded amount is its own share on the refund day. [proof: S40 AS-53]
- **S40.B-07** Given the analytics store is emptied, when the order events are replayed in any order, then "today" and the stats are the same as before. [proof: S40 AS-55]
- **S40.B-08** Given a deleted shop, when the event is consumed, then no store of the domain holds a row, entry or counter of it. [proof: S40 AS-60]

## Lifecycles
A period is open until its end passes, then closed (late events still count), then frozen one hour after the end by the snapshot job (late events are acknowledged and not applied); frozen is final. A read-model row only moves to a higher version and is deleted with its shop. A live counter bucket lives 180 seconds; a board key lives until 35 days after its period.

## Owns
- PostgreSQL tables `LeaderboardSnapshot`, `SellerInsightsShop` and `SellerInsightsProduct`.
- Redis keys `lb:*` (boards, revenue, last-sale slot, applied orders, board list, sealed flag) and `live:*` (counters, marks, leases), all with a time to live.
- ClickHouse tables `shop_sale_facts` and `shop_refund_facts` (`packages/backend/clickhouse/051_shop_sale_facts.sql`).
- Rate-limit policy `seller-insights.leaderboard-read.ip`; jobs `leaderboards.snapshot` with two schedules.
- The response schemas of `packages/contracts/src/seller-insights`.

## Decisions
- Revenue is `lineTotalMinor` (what the buyer paid, discounts included), the same figure the ledger and the statements use; boards, live counters and sales history all count it, which corrects the earlier unit price times quantity.
- The ranking key is revenue times 2^20 plus the inverted last-sale slot, so one sorted-set score orders by revenue then by the earlier instant, exact below 2^53.
- Idempotency differs per store on purpose: a set of applied order ids for boards, a short-lived mark written with the increments for counters, the engine's latest-version-per-key for the sales history, version guards for read models.
- Shop names and categories are copies fed by events; the top list never joins another domain's table.
- Snapshots are sealed first and replaced board by board under a per-period lock, so a re-run is harmless.
- Stats belong to a shop, not to a user: `GET /api/sellers/me/stats` and `GET /api/leaderboards/shops/:shopId` are gone.

## Known gaps
- The throughput and latency criteria SC-002 (a sale on the boards within 5 seconds, in "today" within 30), SC-003 (live panel within 2 seconds of a payment) and SC-005 (top list under 100 ms at 50,000 requests a second) have no automated proof; they are listed in `specs/UNVERIFIED.md`.
- Gross revenue ranks the boards: refunds change the stats only, so a refunded self-purchase still ranks.
- A suspended shop stays on the public boards; hiding it is a later moderation capability.
- Framework-level rejections (an envelope version the consumers do not know, an event type they do not handle) are dead-lettered or skipped by the consumer framework and counted by its own metrics, not by `leaderboard_events_total{rejected}`.
