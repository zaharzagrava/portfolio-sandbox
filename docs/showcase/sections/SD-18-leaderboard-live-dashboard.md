# SD-18 — Seller Leaderboards & Live Sales Dashboard

Status: ☑ done (typechecked; spec written, not run) · Phase 4 · Depends on: F-03, F-05, SD-32 · Extends README #25–28 (ClickHouse analytics)

## Marketplace adaptation
- **Top sellers of the week** per category (public leaderboard, "my rank" for each shop).
- **Live launch dashboard** for a shop during a flash sale/drop: orders/min, revenue, conversion, stock left — updated every second.

## Patterns showcased
| Pattern | Lesson |
|---|---|
| Redis **sorted sets** per period/category `lb:2026-W40:electronics` (`ZINCRBY`, `ZREVRANGE`, `ZREVRANK`), TTL per period key | 10/06 #18 |
| Tie-breaker encoded in score (`revenue * 1e6 + (MAX_TS - lastSaleTs)/1e6`) | 10/06 #18 |
| Updated by a projector on `orders.events` (F-05), idempotent via processed-order set | D26 |
| Snapshots to Postgres/ClickHouse at period end | 10/06 #18 |
| Live dashboard: **Kafka → ClickHouse materialised views** (README #28) for per-second aggregates + Redis rolling counters for the last 60 s → SSE push every 1 s (never COUNT(*) on OLTP) | 10/06 #18 |
| Percentile rank for shops outside top N (approximate via ZCOUNT buckets) | 10/06 #18 |

## Steps
- [x] Leaderboard projector + `GET /leaderboards/:category?period=` + `GET /shops/:id/rank`.
- [x] Live dashboard aggregator (Redis per-second buckets) + SSE topic `shop:{id}:live` emitter (1 s ticker job, only for shops with subscribers).
- [x] ClickHouse MV for minute rollups (if not already from #28).
- [x] e2e: two shops' orders → ranks correct, tie broken by earlier sale; replayed event doesn't double count.

## Scale
- Target: 10k order events/s feeding boards; 500k dashboard viewers in a mega launch; leaderboard reads 50k RPS.
- Hot path: Redis ZSET reads/writes only; dashboards fed from Redis rolling buckets.
- Capacity: ZINCRBY ~100k/s per shard; boards spread over categories; read replicas for ZREVRANGE.
- Proof: k6 order event flood + leaderboard reads; p99 < 20 ms.

## Implementation notes (2026-10-01)
- **Leaderboards** (`LeaderboardProjector`, apps/projector, on `order.paid`):
  - Per ISO week and calendar month there is an overall board plus per-category boards.
  - One Lua script per (order, period), with all keys declared and hash-tagged `{period}`, atomically does: the idempotency `SADD seen`, then `HINCRBY` exact revenue, then a rebuilt ZSET score, then registering the board in the period's board set.
  - Score = revenue·2^20 + time left in the period at the last sale (seconds for weeks, minutes for months), so equal revenue ranks the earlier seller first. It's formatted `%.0f` in Lua because the default `%.14g` would drop the tie-breaker. Exact while revenue < $85.9M per shop per period.
- **Reads** (`LeaderboardService`): `GET /api/leaderboards?period=week|month&id=&category=` uses ZREVRANGE + HMGET, with shop names through the cache and `s-maxage=30`. `GET /api/leaderboards/shops/:id` uses ZREVRANK/ZCARD and returns rank, of and topPercent. Expired periods fall back to `LeaderboardSnapshot`.
- **`LeaderboardSnapshotJobs`** (worker; Monday 01:00 and the 1st 01:00): freezes the top 100 of every board of the closed period into Postgres (migration `20261001250000`), idempotent (delete + insert in one transaction).
- **Live dashboard:**
  - `ShopLiveProjector` keeps per-second Redis hashes (checkouts from `order.reserved`; orders/units/revenue from `order.paid`) and records the shop in `dash:active`.
  - `DashboardTicker` (worker) only computes for shops with recent activity AND live subscribers (`PUBSUB NUMSUB`), using per-shop leases. It pushes the 60 s totals, an orders/s sparkline and checkout conversion to SSE `shop:{id}:live`; the topic policy (members only) is registered in the gateway.
  - History: `ShopSalesProjector` writes ClickHouse `shop_sales` + the `shop_sales_minute` MV (`clickhouse/050_shop_sales.sql`). `GET /api/shops/:shopId/dashboard/today` serves the initial chart.
- **Shared** `redis/lease.ts` (`holdLease`) is now used by the SD-15 and SD-18 tickers.
- **Spec** `leaderboards/leaderboards.e2e-spec.ts` covers: tie by earlier sale, replay without double counting, category/month boards, rank, snapshot fallback, and dashboard sums + conversion.
