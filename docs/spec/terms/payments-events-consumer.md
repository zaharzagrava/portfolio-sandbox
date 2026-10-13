---
id: payments-events-consumer
title: PaymentsEventsConsumer
kind: term
status: draft
aliases: [payments events consumer]
defined_for: S10-cart-checkout
rules_hash: e3b0c44298fc
---
# PaymentsEventsConsumer
## Definition
`PaymentsEventsConsumer` is the [event consumer](event-consumer.md) in the orders domain that reads the [`payments.events` topic](payments-events-topic.md). It handles `payments.payment_succeeded`, `payments.payment_failed` and `payments.payment_refunded`. It is a second path to the same order changes that [`POST /webhooks/stripe`](post-webhooks-stripe.md) makes. Both paths use the same [guarded transitions](guarded-update.md), so a payment result that arrives on both paths changes the order only once. The consumer must also handle a [repeated message only once](consumer-deduplication-mode.md).

## Example
Order `ord_42` (illustrative ID) is `RESERVED`. The webhook marks it `PAID`. Later, `payments.payment_succeeded` for `ord_42` arrives on `payments.events`, and that message is delivered twice. The order stays `PAID`. Neither message adds a history row or raises `version`.

## Known gaps
- The spec does not say which capability publishes to `payments.events`, or what fields each message carries.
- The spec does not say whether the consumer checks amount and currency against the order, as the webhook path does. It only says both paths use the same guarded transitions.
- The spec does not say whether `payments.payment_refunded` must be a full refund before it refunds the order. That condition is stated only for the webhook's `charge.refunded`.

## Used by
<!-- used-by:start -->
- [consumer-deduplication-mode](consumer-deduplication-mode.md)
- [event-consumer](event-consumer.md)
- [guarded-update](guarded-update.md)
- [payments-events-topic](payments-events-topic.md)
<!-- used-by:end -->
