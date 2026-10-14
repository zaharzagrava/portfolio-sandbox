# AuctionSettlementAnomaly

**Severity:** ticket · **Owner:** commerce · **Dashboards:** *Auctions*

## What it means
An `order.paid` arrived for the first (winner's) order of an auction that had already moved on (`auction_settlement_anomaly_total{kind="late_payment"}` increased): the auction offered the unit to the runner-up, was sold, or was returned. The money arrived for a sale that no longer exists, so a customer paid for a unit they will not get.

## Triage (≤ 5 min)
1. Which auction and order? The worker logs a warning `auction.settlement_anomaly` with `auctionId` and `orderId`.
2. What is the auction's status now? `SELECT status, "statusReason", "winnerId", "winnerOrderId", "firstOrderId" FROM "Auction" WHERE id = '<auctionId>';`

## Mitigate
- Refund the payment of the first order through payments (S13/S14); the auction is not changed by this alert.
- If the runner-up's offer is still open and the first buyer insists, support decides; the system never reverses an offer on its own.

## Verify
The refund is booked; the counter stays flat.

## Follow-up
If it recurs, check the winner payment window against the order expiry sweeper delay.
