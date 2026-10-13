-- S34 contract step (operator, NOT applied by clickhouse:migrate: it lives outside the migrated directory).
-- Run only after orders.events was replayed into recommendation_baskets (041) and one nightly
-- recommendations.build-bought-together run completed on it. The old table has no reader left.
DROP TABLE IF EXISTS order_baskets;
