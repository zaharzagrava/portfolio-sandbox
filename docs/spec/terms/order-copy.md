---
id: order-copy
title: Order copy
kind: term
status: draft
aliases: []
defined_for: payment-lifecycle
rules_hash: 56ed3ae9720e
---
# Order copy
## Definition
The order copy is the payment side's own stored record of the order that a payment belongs to. The payment takes its amount and currency only from this copy. Any amount or currency in the buyer's request body is ignored. Design intent (not stated in the spec): the buyer's client cannot be trusted with the price, so it cannot change what gets charged.

## Example
A buyer submits a payment for order `ord_123` and the request body says `"amount": 1.00`. The order copy says 49.90 EUR, so the payment is created for 49.90 EUR. (All values are illustrative.)

## Known gaps
- The spec does not say how the order copy is created or kept up to date when the order changes in the [orders domain](orders-domain.md).
- The spec does not say which order fields the copy holds beyond amount and currency.

## Used by
<!-- used-by:start -->
- [S13](../capabilities/S13-payment-intents.md): R-01
- [payment-lifecycle](../concepts/payment-lifecycle.md): C-01
- [amount-out-of-range](amount-out-of-range.md)
- [check-payment-money](check-payment-money.md)
- [order-not-found](order-not-found.md)
- [order-reserved-event](order-reserved-event.md)
- [orders-domain](orders-domain.md)
- [orders-events-topic](orders-events-topic.md)
- [payable-order](payable-order.md)
- [payments-domain-layer](payments-domain-layer.md)
<!-- used-by:end -->
