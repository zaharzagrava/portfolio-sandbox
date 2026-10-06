-- SD-35: observed competitor prices (one row per successful extraction) - charts and "lowest in 30 days".
CREATE TABLE IF NOT EXISTS competitor_prices
(
    target_id    String,
    ts           DateTime64(3, 'UTC'),
    price_minor  Int64,
    currency     LowCardinality(String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (target_id, ts)
TTL toDateTime(ts) + INTERVAL 2 YEAR;
