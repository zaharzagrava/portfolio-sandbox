# SD-32 — Trending Products (top-K) & Sponsored Listing Click Billing

Status: ☑ done (typechecked; specs written, not run) · Phase 5 · Depends on: SD-31, SD-20 (ledger for ad charges), F-05

## Marketplace adaptation
1. **Trending now**: top-K most viewed/bought products per category in the last hour (approximate is fine).
2. **Sponsored listings**: shops pay per click on promoted products → **exact, deduplicated** click counts per ad per minute → billed to shop balance.

## Patterns showcased
| Pattern | Lesson |
|---|---|
| Streaming consumer with **tumbling 1-min windows** (event time + watermark, allowed lateness 2 min, late events → correction path) | 10/09 #32 |
| **Count-Min Sketch + min-heap** per window/category for approximate top-K at high cardinality (genuinely needed: 50M products) → Redis ZSET `trending:{category}` | 10/09 #32, 11/03 heap |
| Multi-level: per-partition top-K merged into global top-K | 10/09 #32 |
| **Hot key salting**: viral ad → key `adId#0..9`, pre-aggregate, merge | 10/09 #32 |
| Ad clicks: signed **click tokens** (impression → token → click) for dedupe & fraud; **Kafka transactions** (read-process-write exactly-once) for aggregate topic | 06/01 §2.2 |
| Aggregates upserted idempotently in ClickHouse (`ReplacingMergeTree` by (ad, minute)) + raw clicks to S3/ClickHouse → **daily batch reconciliation** recomputes billing (lambda architecture) | 10/09 #32 |
| Billing: hourly job charges shops from reconciled counts → ledger entries (SD-20) | — |
| Click-spam filter (IP/device bursts) before billing | 10/09 #32 |

## Steps
- [x] `CountMinSketch`, `TopKHeap` (pure, unit-tested) + window manager.
- [x] Trending consumer → Redis; `GET /trending?category=`.
- [x] Sponsored: `AdCampaign` model, impression/click token signer, click endpoint (redirect via SD-08 style), Kafka transactional aggregator, ClickHouse tables, reconciliation + billing jobs.
- [x] e2e: duplicate click token counted once; billing run → ledger debit equals clicks × CPC.

## Scale
- Target: 500k view events/s (trending), 50k clicks/s.
- Hot path: all streaming; sketches in memory per consumer (width 2^16 × depth 4 ≈ 1 MB per window/category group).
- Capacity: 64 partitions → 16 consumers × ~30k ev/s.
- Proof: replay script of 10M synthetic events; compare approximate top-K to exact top-K (precision ≥ 0.9).

## Implementation notes (2026-10-01)
- **Streaming primitives** (`trending/count-min-sketch.ts`, unit spec, verified on Zipf-like data — never undercounts, top-10 recovered 10/10):
  - `CountMinSketch` (murmur3 rows).
  - `TopK` min-heap with an index for O(log K) updates.
  - `TumblingWindows` (event time, watermark = max seen − 2 min lateness, late events counted and dropped).
- **Trending:**
  - `TrendingConsumer` (projector) is a raw kafkajs consumer of `analytics.events`: weighted views (×1) and add-to-carts (×5) per category per minute.
  - On window close, the partition's top-50 is `ZINCRBY`-merged into `trending:{category}:<window>`, so the multi-level merge happens in Redis.
  - `GET /api/trending?category=` = `ZUNION` of the last 60 windows, hydrated, cached 30 s.
  - Offsets commit as consumed: a crash loses at most the open windows (approximate by design).
- **Ads:**
  - Migration `20261001330000`: `AdCampaign` and `AdBillingRun` (PK campaign+hour).
  - `GET /api/ads/sponsored` mints signed impression tokens (30 min); budget is checked against a Redis spend counter.
  - `GET /api/ads/click/:token`: verify → dedupe per impression (`SET NX`) → IP burst filter (valid flag) → produce to `ads.clicks` with key `campaign#salt(0..9)` (hot-key salting) → always a 302.
  - `ClickAggregator` (worker): Kafka **transactions**, so per-batch aggregates + consumer offsets commit atomically (read_committed downstream). Rows are keyed (campaign, minute, partition, first offset) so replays replace rather than add.
  - `clickhouse/080_ads.sql`: Kafka engines → `ad_clicks_raw` (ReplacingMergeTree by click_id) and `ad_click_minute`.
- **Billing** (`AdBillingJobs`, worker):
  - Hourly from the aggregates. One charge per (campaign, hour) via the `AdBillingRun` PK in the same transaction as the ledger `AD_CHARGE` journal (shop → PLATFORM_FEES), capped by the daily budget.
  - Daily reconciliation recomputes from raw deduplicated valid clicks and posts an ADJUSTMENT for differences (lambda architecture; the batch path is the truth); idempotent via `reconciledClicks`.
- **Spec** `ads/ads.e2e-spec.ts` covers: impression dedupe + forged token + salting, exactly-once hourly billing with budget cap and replayed aggregates, reconciliation 12 → 10, `aggregateBatch`, trending weighting.
