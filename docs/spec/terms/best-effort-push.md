---
id: best-effort-push
title: Best-effort push
kind: term
status: draft
aliases: [best-effort]
defined_for: S13-payment-intents
rules_hash: e261bb1cb54b
---
# Best-effort push
## Definition
A best-effort push is a [realtime message](realtime-hub.md) that the system tries once to deliver but does not guarantee. If sending it fails, the change that triggered it still stands and is not rolled back or retried. In S13, the [`payment.status` event](payment-status-event.md) is pushed this way to the [owner's realtime topic](realtime-topic.md) after every payment status change. This is different from domain events such as `payments.payment_succeeded`, which leave through the [outbox](inbox-table.md) and so get [at-least-once publication](at-least-once-delivery.md). The likely reason is that a broken realtime channel should never block or undo a payment transition: design intent (not stated in the spec).

## Example
The processor moves a payment from `PENDING` to `COMPLETED` through the [guarded update](guarded-update.md). The publish of `payment.status` to the buyer's topic fails, for example because the realtime store is down. The payment stays `COMPLETED`, and the buyer sees the new status on their next `GET /payments/:paymentId`.

## Known gaps
- The spec does not say whether a failed `payment.status` push is retried or simply dropped.
- The spec does not say whether the push is sent after the transaction commits (for example from an afterCommit callback) or through the outbox.
- The spec does not say how a buyer whose stream missed a push catches up, for example whether `payment.status` uses the replay buffer.

## Used by
<!-- used-by:start -->
- [S10](../capabilities/S10-cart-checkout.md): R-43
- [S13](../capabilities/S13-payment-intents.md): R-24
- [S28](../capabilities/S28-notifications.md): R-41
- [at-least-once-delivery](at-least-once-delivery.md)
- [delivery-status](delivery-status.md)
- [guarded-update](guarded-update.md)
- [inbox-table](inbox-table.md)
- [orders-realtime-failed-total](orders-realtime-failed-total.md)
- [payment-status-event](payment-status-event.md)
- [provider-secret](provider-secret.md)
- [realtime-hub](realtime-hub.md)
- [realtime-topic](realtime-topic.md)
<!-- used-by:end -->
