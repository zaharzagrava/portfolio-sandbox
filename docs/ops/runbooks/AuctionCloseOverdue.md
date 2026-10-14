# AuctionCloseOverdue

**Severity:** page · **Owner:** commerce · **Dashboards:** *Auctions* · **SLO:** auction close within 60 s of its end

## What it means
An `OPEN` auction is more than 60 s past its end (`auction_open_overdue` > 0). Bidding is already closed for it (the server clock refuses bids at the end), but nobody has decided the result, so the winner waits and the unit stays held. Both the delayed `auctions.close` job and the 30 s sweeper (`auctions.sweep-due`) failed to close it.

## Triage (≤ 5 min)
1. Which auctions? `SELECT "id", "endsAt", "leaderId" FROM "Auction" WHERE "status" = 'OPEN' AND "endsAt" < now() - interval '60 seconds';`
2. Is the job system healthy? `job_queue_lag_seconds`, the worker logs `{service="worker"} |= "auction.job"`; a lease on `auctions.sweep-due` held by a dead worker expires after 2 minutes.
3. Is the leader check failing? `bid_unavailable`-style tenancy errors in the worker log (`membership lookup unavailable`) keep the close from awarding an unchecked leader on purpose.

## Mitigate
- **Worker or job queue down:** restore it; the sweeper closes everything due on its next run (≤ 200 per run).
- **Tenancy lookup failing:** restore tenancy; the next sweep closes the auction. Do not edit the row by hand.
- **A close that keeps deferring** (`close of auction … deferred: the leader kept changing`): wait one sweep; bids stop at the end so it settles.

## Verify
`auction_open_overdue` returns to 0 and `auction_close_lag_seconds` p99 is under 60 s again.

## Follow-up
Ticket for the root cause; check the unit was returned or the winner's order requested (`auctions.request-order` / `auctions.return-stock`).
