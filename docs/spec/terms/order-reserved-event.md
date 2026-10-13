---
id: order-reserved-event
title: order.reserved event
kind: term
status: draft
aliases: [order.reserved]
defined_for: S13-payment-intents
rules_hash: e3b0c44298fc
---
# order.reserved event
## Definition
`order.reserved` is the event on the [`orders.events` topic](orders-events-topic.md) that says a buyer's order now has a reservation. The [payments domain](payments-domain-layer.md) uses it to create or update the [order copy](order-copy.md). That is how an order becomes [payable](payable-order.md) from the payments side. If a payment request arrives before the event, the [intent endpoint](payment-intent.md) waits briefly for it. If the event still has not arrived, the order is treated as unknown.

## Example
A buyer reserves an order and immediately posts `{orderId, paymentMethodId}` to `POST /payments/intents`. If `order.reserved` arrives within 2 s, the answer is `202`. Otherwise it is `404 order_not_found` (S13.B-06).

## Known gaps
- The spec does not say which fields `order.reserved` carries. The order copy needs at least the owner, the status, `reservedUntil`, the amount and the currency (S13.R-01, S13.R-03).
- The spec does not say what happens when `order.reserved` arrives again for an order that is already in the order copy, for example after a new reservation.

## Used by
<!-- used-by:start -->
- [order-copy](order-copy.md)
- [orders-events-topic](orders-events-topic.md)
- [payable-order](payable-order.md)
- [payment-intent](payment-intent.md)
- [payments-domain-layer](payments-domain-layer.md)
<!-- used-by:end -->
