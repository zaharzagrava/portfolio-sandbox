-- SD-18: one row per paid order line, per shop (fed from orders.events). Dashboards and period
-- snapshots read the minute rollup - never COUNT(*) over OLTP order tables.
CREATE TABLE IF NOT EXISTS shop_sales
(
    order_id     String,
    shop_id      String,
    product_id   String,
    category     LowCardinality(String),
    units        UInt32,
    revenue      Int64,
    ts           DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (shop_id, ts, order_id, product_id);

CREATE TABLE IF NOT EXISTS shop_sales_minute
(
    shop_id  String,
    minute   DateTime('UTC'),
    orders   UInt64,
    units    UInt64,
    revenue  Int64
)
ENGINE = SummingMergeTree
ORDER BY (shop_id, minute);

-- `orders` counts lines here; distinct orders per minute come from shop_sales when exactness matters.
CREATE MATERIALIZED VIEW IF NOT EXISTS shop_sales_minute_mv TO shop_sales_minute AS
SELECT shop_id, toStartOfMinute(ts) AS minute, uniqExact(order_id) AS orders, sum(units) AS units, sum(revenue) AS revenue
FROM shop_sales GROUP BY shop_id, minute;
