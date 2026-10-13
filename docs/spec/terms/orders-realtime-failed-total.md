---
id: orders-realtime-failed-total
title: orders_realtime_failed_total
kind: term
status: draft
aliases: []
defined_for: S10-cart-checkout
rules_hash: e3b0c44298fc
---
# orders_realtime_failed_total
## Definition
`orders_realtime_failed_total` is a metric that counts failed realtime pushes about orders. After an order transition commits, the [orders domain](orders-domain.md) pushes the change to the [realtime hub](realtime-hub.md) as a [best-effort push](best-effort-push.md). If that push fails, for example because the hub is down, the counter goes up. The transition and its events stay committed. The buyer can still see the new status through [`GET /orders/:orderId`](get-order-by-id.md).

## Example
The realtime hub is down when the [expiry job](hold-expired.md) cancels an order with [`hold_expired`](hold-expired.md). The cancel commits and [`order.cancelled`](order-cancelled-event.md) is appended. `orders_realtime_failed_total` goes up by 1, and `GET /orders/:orderId` shows `CANCELLED`.

## Known gaps
- The spec does not say which labels this metric has.
- The spec does not say whether a failed push is ever retried. The term "best effort" suggests it is not.

## Used by
<!-- used-by:start -->
- [best-effort-push](best-effort-push.md)
- [hold-expired](hold-expired.md)
- [orders-domain](orders-domain.md)
- [realtime-hub](realtime-hub.md)
<!-- used-by:end -->
