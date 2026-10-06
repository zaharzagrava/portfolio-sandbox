-- SD-07: public API request log (searchable by request id per shop) + version/endpoint usage
-- that drives deprecation decisions ("who still calls v2026-01-15 GET /v1/products/:id/stock?").
CREATE TABLE IF NOT EXISTS api_requests
(
    request_id   String,
    shop_id      String,
    key_id       String,
    livemode     UInt8,
    version      LowCardinality(String),
    method       LowCardinality(String),
    route        LowCardinality(String),
    status       UInt16,
    duration_ms  UInt32,
    deprecated   UInt8,
    ts           DateTime64(3, 'UTC')
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(ts)
ORDER BY (shop_id, ts, request_id)
TTL toDateTime(ts) + INTERVAL 30 DAY;

CREATE TABLE IF NOT EXISTS api_usage_daily
(
    day      Date,
    shop_id  String,
    version  LowCardinality(String),
    route    LowCardinality(String),
    calls    UInt64,
    errors   UInt64
)
ENGINE = SummingMergeTree
ORDER BY (day, shop_id, version, route);

CREATE MATERIALIZED VIEW IF NOT EXISTS api_usage_daily_mv TO api_usage_daily AS
SELECT toDate(ts) AS day, shop_id, version, route, count() AS calls, countIf(status >= 500) AS errors
FROM api_requests GROUP BY day, shop_id, version, route;
