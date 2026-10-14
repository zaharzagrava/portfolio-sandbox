# AuctionOrderRequestDeadLettered

**Severity:** page · **Owner:** commerce · **Dashboards:** *Auctions*, *Job queue*

## What it means
The request for a winner's (or the runner-up's) order to `orders` failed on its last attempt (`auction_order_request_failed_total{kind="dead_letter"}` increased). The auction stays `CLOSED` (or `SECOND_CHANCE`) with no order: the winner cannot pay and the unit stays held until someone acts.

## Triage (≤ 5 min)
1. Which auction? `{service="worker"} |= "auction.job" |= "request-order"` or the dead job row: `SELECT payload, "lastError" FROM "Job" WHERE type = 'auctions.request-order' AND status = 'DEAD' ORDER BY "finishedAt" DESC;`
2. Why? A timeout or 5xx from `orders` is transient: check the orders service health. A permanent refusal never dead-letters (it is handled as an unpaid winner).
3. Is an order already there? `SELECT id, status FROM "BisOrder" WHERE "idempotencyKey" = 'auction:<auctionId>:winner';` The command is idempotent on that key.

## Mitigate
- **Orders recovered:** the sweeper asks again for any awarded auction with no stored order older than 60 s; or re-run the job from the job console. Both are safe to repeat.
- **Order exists but the ID was not stored:** the same sweeper repair stores it (the command replays the same order).

## Verify
The auction has `winnerOrderId` set and the order is `RESERVED`; the counter stops rising.

## Follow-up
Postmortem if more than one auction was affected.
