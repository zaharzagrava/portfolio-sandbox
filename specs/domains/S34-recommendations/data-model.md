# Data Model: S34

No Postgres tables (the ownership registry gets no entry). Types live in `domain/`; wire schemas in `packages/contracts`.

| Entity | Store and shape | Rules |
|---|---|---|
| Basket | ClickHouse `recommendation_baskets`: `order_id String`, `buyer_id String`, `products Array(String)`, `paid_at DateTime64(3,'UTC')`, `order_version UInt32`, `inserted_at DateTime64(3,'UTC') DEFAULT now64(3)`; `ReplacingMergeTree(order_version)`, `PARTITION BY toYYYYMM(paid_at)`, `ORDER BY order_id`, `TTL toDateTime(paid_at) + INTERVAL 13 MONTH` | one per `orderId`; `products` distinct and sorted, 2–30 entries; replaced only by a strictly higher `order_version`; opaque IDs only; read with `FINAL` |
| Edge | derived in the build query, never stored | `co ≥ minCo` and `uniqExact(buyer_id) ≥ minBuyers`; `score = co / sqrt(n(a)·n(b))`, symmetric; `n(p)` = all eligible baskets of `p` in the window |
| Neighbour list | Redis ZSET `rec:bought:{productId}`, member = neighbour id, score = cosine (unrounded) | ≤ 20 entries, 3-day TTL, one owner; staging key `rec:bought:{productId}:next` swapped by `RENAME`; deleted by the removal pass when the product lost all edges |
| Build lock | Redis string `rec:build:lock` = owner token | `NX PX 3_600_000`; released by compare-and-delete |
| Build marker | Redis set `rec:build:{runId}` | product ids published by the run, TTL 2 h, deleted at the end; input of the removal pass |
| Build run result | job result `{outcome: 'completed'|'skipped_empty'|'skipped_locked', products, edges, removed}`; failure = job failure | metrics `recommendations_build_*` |
| Recommendation item | response only: `{productId, title, priceMinor, currency, score (4 decimals), hops 1|2}` | facts from R1 at request time |

State transitions: Basket `absent → stored(v) → stored(v' > v)`; equal or lower version is a no-op. Neighbour list `absent → live(build N) → live(build N+1) | absent (removal after a complete build) | absent (TTL)`.

Validation of stored entries (U3): member is a UUID and not the requested product; score is a finite number in (0, 1]; otherwise skipped and counted in `recommendations_bad_entries_total`.
