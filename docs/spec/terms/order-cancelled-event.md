---
id: order-cancelled-event
title: order.cancelled event
kind: term
status: draft
aliases: [order.cancelled]
defined_for: S10-cart-checkout
rules_hash: 88e04d58ae79
---
# order.cancelled event
## Definition
`order.cancelled` is the event the [orders domain](orders-domain.md) publishes when an order moves to [`CANCELLED`](order-status.md). Other capabilities react to it instead of polling the order. A cancellation has a reason, for example `user_cancelled` from the buyer or [`hold_expired`](hold-expired.md) from the expiry job or [sweeper](pending-order-recovery.md). Each cancellation emits the event once, and the stock goes back once.

## Example
A buyer calls `POST /orders/:orderId/cancel` on a [`RESERVED`](order-status.md) order. The answer is `200` with `CANCELLED(user_cancelled)`, [the stock is restored once](stock-release.md), and one `order.cancelled` event is published.

## Known gaps
- The spec does not say what the [event payload](event-payload.md) contains, for example whether it includes the cancellation reason or the shop orders.
- The spec does not say whether an order cancelled with `out_of_stock` during checkout also emits `order.cancelled`.
- The spec does not say whether consumers can receive the event more than once.

## Used by
<!-- used-by:start -->
- [S10](../capabilities/S10-cart-checkout.md): R-35, B-15
- [event-payload](event-payload.md)
- [orders-domain](orders-domain.md)
- [pending-order-recovery](pending-order-recovery.md)
- [stock-release](stock-release.md)
<!-- used-by:end -->
