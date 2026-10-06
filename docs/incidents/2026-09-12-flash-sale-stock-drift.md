# Postmortem: flash sale stock drift after a Redis failover (worked example)

**Status:** reviewed · **Severity:** SEV1 · **Date:** 2026-09-12 · **Authors:** commerce on-call · **Incident commander:** platform on-call

> Example postmortem written for the O-01 template; the scenario exercises the real FlashSaleOversellDetected path.

## Summary
During the "Pixel 10 launch" flash sale (500 units), the primary Redis node of the stock cluster failed over. ~1 s of acknowledged writes (bucket decrements) had not reached the replica, which was promoted. Redis then had 7 more units "available" than were actually reserved, and 7 extra orders were accepted. Reconciliation 16 minutes after the sale ended detected the drift and paged.

## Impact
- 507 orders converted for 500 units: 7 customers could not be fulfilled from launch stock.
- 5 were fulfilled from warehouse stock (2-day delay); 2 were cancelled + refunded with a €20 voucher, all contacted within 3 hours.
- Error budgets: none consumed. The API behaved "correctly" the whole time, which is exactly why this needed a business-invariant alert, not an SLO.
- Detection: `FlashSaleOversellDetected` page, 16 min after the sale, 41 min after the failover.

## Timeline (UTC)
| Time | Event |
|---|---|
| 18:00 | Sale starts; 9k checkouts/s peak |
| 18:24:10 | ElastiCache primary replaced (hardware); replica promoted |
| 18:24:11 | ~180 decrements from the last second lost |
| 18:31 | Sale sells out (as seen by Redis) |
| 18:47 | `flash-sale.reconcile` job: drift 7 units (`redis_high`), page |
| 18:52 | On-call confirms: 507 CONVERTED vs 500 units (runbook step 2) |
| 19:30 | Commerce decision: fulfil 5 from warehouse, cancel 2 newest |
| 21:05 | Customers contacted, resolved |

## Root cause(s) and contributing factors
1. Flash stock lived only in Redis during the sale. Replication is async, so a failover can lose acknowledged writes: a known trade-off (DOUBTS Q32) accepted for throughput.
2. The stock cluster had `appendfsync everysec`, but failover promotes the replica, not the AOF.
3. Detection only at reconciliation: nothing compared Redis vs Postgres during the sale.

## What went well / poorly / lucky
- **Well:** reservations are in Postgres too, so the exact damage was computable in one query; idempotent refunds; the runbook was followed as written.
- **Poorly:** 41 minutes from cause to page.
- **Lucky:** the failover happened late; at 18:05 the loss would have been ~10× larger.

## Action items
| Action | Type | Owner | Ticket | Due |
|---|---|---|---|---|
| Use `WAIT 1 50` after bucket decrements for flash stock (sync to ≥ 1 replica, +1 ms p99) | prevent | commerce | MKT-1412 | 2026-09-30 |
| Alert on Redis failover events during an active sale (ElastiCache event → SNS → page) | detect | platform | MKT-1413 | 2026-09-26 |
| Run a mid-sale reconciliation every 60 s (converted + held vs units) | detect | commerce | MKT-1414 | 2026-10-10 |
| Keep a 1% unsold buffer for launch sales | mitigate | commerce | MKT-1415 | 2026-09-20 |
