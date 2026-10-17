# Research: S40 design decisions

No open NEEDS CLARIFICATION: `questions.md` defaults are accepted.

## R-1 Ranking key
- **Decision**: score = `revenue * 2^20 + (2^20 − 1 − slot)` where `slot` is the last-sale instant in whole seconds (weeks) or minutes (months) since period start, clamped to `[0, 2^20 − 1]`. Revenue ≤ 2^33 − 1 gives `< 2^53`, exact in a double. A week has 604,800 s and a month ≤ 44,640 min, both `< 2^20`.
- **Rationale**: higher revenue dominates, earlier instant ranks higher; `ZREVRANGE` returns equal scores in descending member order, which is "larger shop id first" (FR-004). Revenue is recoverable by `floor(score / 2^20)`.
- **Alternatives**: composite lexicographic member names (loses numeric exactness); two sorted sets (not atomic).

## R-2 Latest sale instant never moves back
- **Decision**: the Lua script keeps a per-period hash `lb:last:{period}` of `shopId → max instant slot` (and `lb:rev:{period}` for revenue); the new score is computed from `max(old, new)`. One script call per `(order, period)` updates overall and every category board together after checking the ceiling for all of them first (FR-003, FR-006, AS-13).
- **Alternatives**: recompute from the sorted-set score (needs decode, same result but ties with per-board clamping); store on the member (no).

## R-3 Idempotency of boards
- **Decision**: `SADD lb:applied:{period} orderId` inside the same script; returns duplicate when present. Sealed check first (`lb:sealed:{period}` set by the snapshot job in the same transaction window: the snapshot writes the flag after rows are stored; reads trust the snapshot table).
- **Rationale**: per-period applied sets expire with the period (FR-010), so replay after expiry is not required (35 days).

## R-4 Live counters atomicity
- **Decision**: a Lua script sets the per-event mark (`SET NX`, TTL 120 s beyond the window, stale events never reach it) and `HINCRBY`s the second bucket (TTL 180 s) in one call. A failed script leaves no mark (AS-41). Events older than 60 s at consumption: no write, counter `stale`.
- **Replay later than the mark TTL**: stale by definition (older than 60 s), so ignored. This also fixes A26.

## R-5 Ticker
- **Decision**: each second, `topicsWithSubscribers('shop','live')` → shop ids; per shop `SET lease:{shop} instanceId NX PX 3000` (renew while held); the holder reads 60 buckets with one pipelined `HMGET`-style call, builds the frame (pure function), publishes with `{replay:false}`. Ticks guarded by an in-flight flag (`ticks_skipped`); shutdown awaits the tick and `DEL`s owned leases. Lease TTL 3 s gives failover ≤ 5 s (AS-43).
- **Fallback**: on `RealtimeUnavailableError` the tick reuses the last discovered list for up to 10 s.

## R-6 Analytics store
- **Decision**: `shop_sale_facts` (ReplacingMergeTree keyed `(shop_id, order_id, product_id)`, version `ingested_at`) and `shop_refund_facts` (`(order_id, shop_id)`). Reads aggregate with `GROUP BY (order_id, product_id)` + `argMax`/`any` before summing (exact without `FINAL`, correct before compaction: AS-55). Minute series computed at read from facts with `toStartOfMinute(paid_at)`. `uniqueBuyers` = `uniqExact(buyer_id)` (exact, within FR-040).
- **Rationale**: removes the SummingMergeTree view that double counts (A36). The window is ≤ 365 days of one shop, a sort-key prefix scan.
- **Alternatives**: AggregatingMergeTree views (dedupe not possible), Postgres facts (loads OLTP).

## R-7 Refund attribution
- `order.refunded` → read the recorded shares from `shop_sale_facts` for the order (sum of `line_total_minor` per shop); no rows → throw retryable error (5 attempts with backoff, then DLQ); amount ≠ recorded total → DLQ `partial_refund_unsupported`.

## R-8 Snapshots
- Job computes due periods (`end + 1 h ≤ now`), unfrozen, with boards present; per board: `ZREVRANGE 0..99 WITHSCORES`, `ZCARD`, names from the shop read model; replace in one `TransactionRunner.run` (`DELETE` + bulk `INSERT` with parameter binding, a unique index on `(kind, periodId, category, rank)`); advisory lock `pg_advisory_xact_lock` per period makes concurrent runs serial (AS-33). Readers use READ COMMITTED so they see the old or the new set.
- Sealing: after commit set `lb:sealed:{period}` with period TTL; the feed also checks the snapshot table when the flag is missing and the period is closed.
- Erasure renumbers the remaining rows in one statement with `row_number()`.

## R-9 Rate limit and caching
- Policy `seller-insights.leaderboard-read.ip`, 60/min, fail open, registered in `api/rate-limit-policies.ts` like community's. Cache-Control chosen per `source`.

## R-10 Query validation
- A strict zod schema over `req.query` (arrays and unknown keys rejected) shared by top list and rank; same for `days`. 422 `period_in_future` from the read service.

## R-11 Items intentionally not adopted
- `catalogsync.offline_conflict_opened`, `payments.events`, `ledger.*`, `live.*`, `flashsale.*` are not consumed (spec: orders are the one source of sales figures). Foreign types on `orders.events` are ignored by the type filter.
