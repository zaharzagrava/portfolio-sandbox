---
id: stock-release
title: Stock release
kind: term
status: draft
aliases: [release, stock return]
defined_for: order-reservation
rules_hash: c6697115895f
---
# Stock release
## Definition
A stock release gives held stock back to a product when an order is cancelled. Like every stock change, it goes through the [catalog stock command](catalog-stock-command.md). In the same transaction as the cancellation, each [`HELD`](reservation-status.md) reservation becomes [`RELEASE_PENDING`](reservation-status.md). A [retry job](job-retries.md) then completes any release that failed. The stock must come back exactly once, never twice.

## Example
Order `42` (illustrative) is cancelled with [`hold_expired`](hold-expired.md). In the same transaction, its reservations for products `7` and `19` go from `HELD` to `RELEASE_PENDING`. The release for product `19` fails, and the retry job releases it later.

## Known gaps
- The spec does not give the operation ID format for a release. Only the reserve format `orders:<orderId>:reserve:<productId>` is stated.
- The spec does not say how "returns once" is enforced, or what status a reservation has after a successful release.
- The spec does not say how often the retry job runs or whether it ever gives up.

## Used by
<!-- used-by:start -->
- [J01](../capabilities/J01-buy-to-payout.md): R-05, R-13, B-09
- [J02](../capabilities/J02-seller-to-first-sale.md): B-19
- [J03](../capabilities/J03-launch-day.md): R-11
- [S10](../capabilities/S10-cart-checkout.md): B-13, B-14
- [order-reservation](../concepts/order-reservation.md): C-04
- [catalog-stock-command](catalog-stock-command.md)
- [hold-expired](hold-expired.md)
- [job-retries](job-retries.md)
- [order-cancelled-event](order-cancelled-event.md)
- [stock-operation-id](stock-operation-id.md)
- [stock-operation](stock-operation.md)
<!-- used-by:end -->
