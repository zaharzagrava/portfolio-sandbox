---
id: payment-status-event
title: payment.status event
kind: term
status: draft
aliases: []
defined_for: S13-payment-intents
rules_hash: d1de5cbd5aad
---
# payment.status event
## Definition
`payment.status` is the realtime message sent to the payment owner's [realtime topic](realtime-topic.md) every time a payment's status changes. It lets the buyer's open page show the new status without polling. It goes only to the owner's topic, never to other buyers. Delivery is not guaranteed and a failed send is not retried, but the status change still stands. It is separate from the [domain events](event-definition.md) [`payments.payment_succeeded`](payment-succeeded-event.md), [`payments.payment_failed`](payment-failed-event.md) and `payments.payment_refunded`, which the order system consumes.

## Example
The processor moves a payment from `PENDING` to `COMPLETED`. The buyer's stream receives a `payment.status` frame for that payment (payload illustrative: `{"paymentId": "…", "status": "COMPLETED"}`).

## Known gaps
- The spec does not give the payload shape of `payment.status`.
- The spec does not say whether `payment.status` leaves through [the outbox](inbox-table.md) (as S13.R-22 requires for events) or is pushed directly after commit.

## Used by
<!-- used-by:start -->
- [best-effort-push](best-effort-push.md)
- [event-definition](event-definition.md)
- [inbox-table](inbox-table.md)
- [realtime-topic](realtime-topic.md)
<!-- used-by:end -->
