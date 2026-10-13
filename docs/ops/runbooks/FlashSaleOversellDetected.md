# FlashSaleOversellDetected

**Severity:** page (SEV1) · **Owner:** commerce · **Dashboards:** *Flash sales & checkout*

## What it means
At reconciliation, Redis flash stock disagreed with Postgres (`flash_sale_stock_drift_units_total` increased). Redis lost writes (failover / eviction), so during the sale more units may have been reserved than existed (`direction="redis_high"`), or units were withheld (`redis_low`).

## Triage (≤ 5 min)
1. Which sale? Logs: `{service="worker"} |= "flash sale" |= "drift"` gives sale id and numbers.
2. Real oversell? `SELECT count(*), sum(quantity) FROM "StockReservation" WHERE "flashSaleId" = '<id>' AND status = 'CONVERTED';` vs the sale's `units`.
3. Redis incident around the sale? (failover events, `redis_memory_used_bytes` near max → evictions)

## Mitigate
- **Oversold (converted > units):** stop further conversions if the sale is still running (end the sale / kill its flag). Commerce decides per order: fulfil from other stock or cancel + refund the LAST orders (by `createdAt`) with an apology voucher. Never cancel silently.
- **Withheld:** the reconciliation job already returned unsold units to `Product.quantity` (DB wins); nothing else to do.
- **Root cause:** Redis persistence/failover settings (AOF everysec, Multi-AZ), `noeviction` on the stock DB.

## Verify
Converted ≤ units for the sale; affected customers contacted; drift counter flat for the next sales.
