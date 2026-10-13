---
id: orders-events-consumer
title: OrdersEventsConsumer
kind: term
status: draft
aliases: [orders events consumer]
defined_for: S13-payment-intents
rules_hash: e3b0c44298fc
---
# OrdersEventsConsumer
## Definition
`OrdersEventsConsumer` is the payments domain's [event consumer](event-consumer.md) for the [`orders.events` topic](orders-events-topic.md). It reads `order.reserved`, `order.paid` and `order.cancelled`, and uses them to keep [`PayableOrder`](payable-order.md), the payments order copy, up to date. On `order.cancelled` it also cancels the matching payment, but only while no [charge attempt](checkout-attempt.md) is recorded. For a payment waiting for customer action, it asks the [payment provider](payment-provider.md) to cancel the intent and then marks the payment `CANCELLED`.

## Example
`order.cancelled` arrives for an order whose payment is `PENDING`, and no charge attempt has been recorded. The consumer moves the payment to `CANCELLED(order_cancelled)`, and the provider receives 0 calls (S13.B-16).
Code: `packages/backend/libs/domains/payments/infra/orders-events.consumer.ts#OrdersEventsConsumer`

## Known gaps
- The spec does not say how the consumer handles duplicate or out-of-order events, for example `order.cancelled` arriving before `order.reserved`.
- The spec does not say how S13.R-21 fits with S13.B-17. S13.R-21 allows a cancel only while no charge attempt is recorded. S13.B-17 cancels a payment that is already waiting for the customer, so an attempt seems to exist.
- The spec does not say what `order.paid` does beyond updating the order copy, for example whether it changes an existing payment.

## Used by
<!-- used-by:start -->
- [checkout-attempt](checkout-attempt.md)
- [event-consumer](event-consumer.md)
- [orders-events-topic](orders-events-topic.md)
- [payment-provider](payment-provider.md)
- [payments-domain-layer](payments-domain-layer.md)
- [product-view-event](product-view-event.md)
<!-- used-by:end -->
