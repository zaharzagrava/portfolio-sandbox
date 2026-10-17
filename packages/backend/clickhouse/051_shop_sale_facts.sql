-- S40: the exact sales history of a shop, fed from orders.events (order.paid and order.refunded) by the seller-insights
-- projector. One row per (shop, order, product); a redelivery or a replay writes the same key again and the reader takes the
-- latest version of each key (argMax by ingested_at) before summing, so the figures are exact before any merge ran.
-- Never COUNT(*) over OLTP order tables for a dashboard refresh.
CREATE TABLE IF NOT EXISTS shop_sale_facts
(
    shop_id          String,
    order_id         String,
    product_id       String,
    title            String,
    buyer_id         String,
    units            UInt32,
    line_total_minor Int64,
    paid_at          DateTime64(3, 'UTC'),
    ingested_at      DateTime64(3, 'UTC') DEFAULT now64(3),
    INDEX idx_order order_id TYPE bloom_filter GRANULARITY 4
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(paid_at)
ORDER BY (shop_id, order_id, product_id);

-- A full refund of an order, split by the shares each shop recorded (one row per shop and order).
CREATE TABLE IF NOT EXISTS shop_refund_facts
(
    shop_id      String,
    order_id     String,
    amount_minor Int64,
    refunded_at  DateTime64(3, 'UTC'),
    ingested_at  DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(refunded_at)
ORDER BY (shop_id, order_id);
