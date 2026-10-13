---
id: order-unavailable
title: order_unavailable (503)
kind: term
status: draft
aliases: [order_unavailable]
defined_for: S10-cart-checkout
rules_hash: e3b0c44298fc
---
# order_unavailable (503)
## Definition
`order_unavailable` is a `503` error code from the orders domain, and it always comes with [`Retry-After` ↗](../sw-external-terms.md#retry-after). The buyer's cancel returns it when [the event for the transition cannot be appended in the same transaction as the transition](outbox-append.md). In that case nothing is changed: the order status, [history](order-status-history.md), [reservations](all-or-nothing-reservation.md) and events all stay as they were. The order can be cancelled again later, so the client can safely retry.

## Example
```
POST /orders/ord_123/cancel        (order id illustrative)
→ 503  {"code": "order_unavailable", ...}
Retry-After: <seconds>
```
The order is still [`RESERVED`](order-status.md) and its reservations are still [`HELD`](reservation-status.md).

## Known gaps
- The spec does not say what value `Retry-After` carries.
- The spec does not say whether any route other than the buyer's cancel returns this code. Examples would be other [order commands](order-command.md) or `POST /checkout`.

## Used by
<!-- used-by:start -->
- [all-or-nothing-reservation](all-or-nothing-reservation.md)
- [order-command](order-command.md)
- [order-status-history](order-status-history.md)
- [outbox-append](outbox-append.md)
<!-- used-by:end -->
