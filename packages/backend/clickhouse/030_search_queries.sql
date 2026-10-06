-- SD-12: every product search, for autocomplete popularity (and SD-37 relevance evaluation).
CREATE TABLE IF NOT EXISTS search_queries
(
    event_id  String,
    query     String,
    results   UInt32,
    user_hash String,
    ts        DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (query, ts, event_id)
TTL toDateTime(ts) + INTERVAL 90 DAY;

-- SD-37: result clicks, joined with search_queries for CTR@k / MRR when tuning boosts and synonyms.
CREATE TABLE IF NOT EXISTS search_clicks
(
    event_id   String,
    query      String,
    product_id String,
    position   UInt16,
    ts         DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (query, ts, event_id)
TTL toDateTime(ts) + INTERVAL 90 DAY;
