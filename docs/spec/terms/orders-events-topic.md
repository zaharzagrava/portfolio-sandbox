---
id: orders-events-topic
title: orders.events topic
kind: term
status: draft
aliases: [orders.events]
defined_for: S13-payment-intents
rules_hash: ad0ec72be023
---
# orders.events topic
## Definition
`orders.events` is the topic where the orders domain publishes the life of an order. Payments reads three events from it: [`order.reserved`](order-reserved-event.md), [`order.paid`](order-paid-event.md) and [`order.cancelled`](order-cancelled-event.md). [`OrdersEventsConsumer`](orders-events-consumer.md) uses them to keep the payments domain's [order copy](order-copy.md) ([`PayableOrder`](payable-order.md)) up to date. It also cancels payments that have not started charging yet. Because of this topic, payments never has to read the orders domain's tables.

## Example
Here `order.cancelled` arrives on `orders.events` for a [`PENDING`](payment-status.md) payment, and no [charge attempt](checkout-attempt.md) has been recorded yet. The payment becomes [`CANCELLED(order_cancelled)`](payment-status.md) and the provider is never called (S13.B-16). If the payment is waiting for the customer instead, the [provider intent](payment-intent.md) is cancelled once (S13.B-17).

## Known gaps
- The spec does not say how the consumer handles [duplicate](consumer-outcomes.md) or [out-of-order events](per-aggregate-ordering.md), for example `order.cancelled` arriving before `order.reserved`.
- The spec does not say whether payments reads any other event types from this topic, or what it does with them.

## Used by
<!-- used-by:start -->
- [J01](../capabilities/J01-buy-to-payout.md): R-02
- [checkout-attempt](checkout-attempt.md)
- [consumer-outcomes](consumer-outcomes.md)
- [order-copy](order-copy.md)
- [order-refunded-event](order-refunded-event.md)
- [order-reserved-event](order-reserved-event.md)
- [orders-events-consumer](orders-events-consumer.md)
- [payment-intent](payment-intent.md)
- [per-aggregate-ordering](per-aggregate-ordering.md)
- [settlement-consumer](settlement-consumer.md)
<!-- used-by:end -->
