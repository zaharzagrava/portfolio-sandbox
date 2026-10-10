-- S34: one row per paid order with its distinct products ("basket"), the buyer and the order version.
-- ReplacingMergeTree(order_version): the highest version of an order wins at merge time; readers use FINAL and the
-- capture service only inserts strictly higher versions. Replaces 040_order_baskets (dropped by 042 after the replay).
CREATE TABLE IF NOT EXISTS recommendation_baskets
(
    order_id      String,
    buyer_id      String,
    products      Array(String),
    paid_at       DateTime64(3, 'UTC'),
    order_version UInt32,
    inserted_at   DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(order_version)
PARTITION BY toYYYYMM(paid_at)
ORDER BY order_id
TTL toDateTime(paid_at) + INTERVAL 13 MONTH;
