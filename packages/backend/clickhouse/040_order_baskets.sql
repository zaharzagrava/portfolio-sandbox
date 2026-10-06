-- X-01: one row per paid order with its distinct products ("basket").
-- ReplacingMergeTree on order_id: Kafka redelivery of order.paid collapses; the
-- nightly co-occurrence build reads FINAL, so pair counts are exact.
CREATE TABLE IF NOT EXISTS order_baskets
(
    order_id  String,
    products  Array(String),
    ts        DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY order_id
TTL toDateTime(ts) + INTERVAL 13 MONTH;
