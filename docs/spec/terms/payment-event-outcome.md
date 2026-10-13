---
id: payment-event-outcome
title: Payment event outcome
kind: term
status: draft
aliases: [outcome, outcomes]
defined_for: S10-cart-checkout
rules_hash: e3b0c44298fc
---
# Payment event outcome
## Definition
A payment event outcome is the result stored with a payment event once the system has processed it. An event can update its order through a [guarded transition](guarded-update.md), such as marking it `PAID`, cancelling it or refunding it. If it does not, it is stored as [`REJECTED`](rejected-payment-event.md), [`UNMATCHED`](unmatched-payment-event.md) or [`IGNORED`](ignored-payment-event.md), and the order stays the same. In every case the event is kept and never thrown away. [The webhook](post-webhooks-stripe.md) stores and queues the event before any outcome is decided. Its `200` answer therefore never tells you the outcome.

## Example
- Amount or currency does not match the order: `REJECTED`
- No `orderId`, or an `orderId` for an order that does not exist: `UNMATCHED`
- An event type the system does not handle: `IGNORED`
- A matching, verified `payments.payment_succeeded` event: the order moves to `PAID`

## Known gaps
- The spec does not say what status an event gets when it is applied successfully. It also does not say what status a late failure gets after `PAID`, which is ignored for the order.
- The spec does not say whether stored outcomes can be queried, or how operators find events that were rejected or not matched.
- The spec does not say whether messages from the [`payments.events` consumer](event-consumer.md) get these same stored statuses, or only webhook events do.

## Used by
<!-- used-by:start -->
- [event-consumer](event-consumer.md)
- [guarded-update](guarded-update.md)
- [ignored-payment-event](ignored-payment-event.md)
- [order-id](order-id.md)
- [post-webhooks-stripe](post-webhooks-stripe.md)
- [unmatched-payment-event](unmatched-payment-event.md)
<!-- used-by:end -->
