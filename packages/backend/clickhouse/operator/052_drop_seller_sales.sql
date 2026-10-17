-- S40 contract step (operator, NOT applied by clickhouse:migrate: it lives outside the migrated directory).
-- Run after the seller-insights projector has written shop_sale_facts for the whole retention window (replay
-- orders.events from the start into the new tables first). `seller_sales` was only ever written by the load-test seeder;
-- `shop_sales` and its minute view double counted redeliveries and are replaced by shop_sale_facts.
DROP VIEW IF EXISTS shop_sales_minute_mv;
DROP TABLE IF EXISTS shop_sales_minute;
DROP TABLE IF EXISTS shop_sales;
DROP TABLE IF EXISTS seller_sales;
