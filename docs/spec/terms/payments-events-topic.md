---
id: payments-events-topic
title: payments.events topic
kind: term
status: draft
aliases: [payments.events]
defined_for: S10-cart-checkout
rules_hash: 233d700dc830
---
# payments.events topic
## Definition
`payments.events` is a topic on the [event backbone](event-backbone.md) that carries payment results as events. The orders domain reads it through [`PaymentsEventsConsumer`](payments-events-consumer.md). It carries three event types: `payments.payment_succeeded`, `payments.payment_failed` and `payments.payment_refunded`. It is a second path to the same order changes that [`POST /webhooks/stripe`](post-webhooks-stripe.md) drives. Both paths use the same [guarded transitions](guarded-update.md), so a payment that arrives on both paths changes the order only once. The consumer must also handle a repeated message only once.

## Example
Order `ord_42` is [`RESERVED`](order-status.md). The payment provider's webhook marks it `PAID` (the order ID is illustrative). Later, `payments.payment_succeeded` for `ord_42` arrives on `payments.events`, and the same message is delivered twice. The order stays `PAID`. Neither message adds a second [history row](order-status-history.md) or raises [`version`](order-version.md) again.

## Known gaps
- The spec does not say which capability publishes to `payments.events`, or what fields each message carries.
- The spec does not say whether the amount and currency checks of the webhook path also apply to messages from this topic. It only says both paths use the same guarded transitions.
- The spec does not say whether `payments.payment_refunded` must be a full refund to refund the order. That condition is stated only for the webhook's `charge.refunded`.

## Used by
<!-- used-by:start -->
- [event-backbone](event-backbone.md)
- [guarded-update](guarded-update.md)
- [order-status-history](order-status-history.md)
- [payments-events-consumer](payments-events-consumer.md)
<!-- used-by:end -->
