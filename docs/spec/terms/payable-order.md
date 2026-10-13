---
id: payable-order
title: PayableOrder
kind: term
status: draft
aliases: [payable order]
defined_for: S13-payment-intents
rules_hash: 90d16811877f
---
# PayableOrder
## Definition
`PayableOrder` is the table that stores the [order copy](order-copy.md), and the payments domain owns it. [`OrdersEventsConsumer`](orders-events-consumer.md) fills it from [`orders.events`](orders-events-topic.md), so payment code never reads the orders domain's tables. [`checkPayable`](check-payable.md) uses it to decide if an order can be paid. The amount and currency of a new payment are taken from it and never from the request body.

## Example
A buyer posts [`POST /payments/intents`](payment-intent.md) for an order whose [`order.reserved`](order-reserved-event.md) event has not arrived yet. If the `PayableOrder` row appears within 2 s, the answer is `202`. If it does not, the answer is `404 order_not_found` (S13.B-06).
If the row exists but `now == reservedUntil`, the answer is [`409 order_not_payable`](order-not-payable.md) with reason [`hold_expired`](hold-expired.md) (S13.R-03).

## Known gaps
- The spec does not list the columns of `PayableOrder`. The rules only imply an owner, a status, [`reservedUntil`](reserved-until.md), an amount and a currency.
- The spec does not say whether rows are ever deleted, for example after `order.paid` or `order.cancelled`, or whether they are only updated.
- Not confirmed in the code: whether the processor's payability re-check before calling the provider (S13.R-12) reads `PayableOrder` or asks the orders domain.

## Used by
<!-- used-by:start -->
- [W03](../capabilities/W03-cart-checkout-orders.md): B-16
- [order-copy](order-copy.md)
- [order-reserved-event](order-reserved-event.md)
<!-- used-by:end -->
