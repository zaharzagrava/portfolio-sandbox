-- One row per sold order line. Read by GET /api/sellers/me/stats
-- (libs/common/src/seller-stats) and bulk-filled by the load-test seeder
-- (scripts/load-tests/seed). Applied idempotently by both on startup.
--
-- ORDER BY (seller_id, ts): every stats query is "one seller, a time range",
-- so this is a primary-key range scan rather than a full-table scan.
CREATE TABLE IF NOT EXISTS seller_sales
(
    ts           DateTime64(3, 'UTC'),
    seller_id    UUID,
    product_id   UUID,
    buyer_id     UUID,
    order_id     UUID,
    amount_cents Int64,
    quantity     UInt32,
    status       LowCardinality(String),
    source       LowCardinality(String) DEFAULT 'app'
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (seller_id, ts)
