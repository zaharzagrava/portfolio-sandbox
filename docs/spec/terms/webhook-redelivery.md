---
id: webhook-redelivery
title: Webhook redelivery
kind: term
status: draft
aliases: [redelivered, redelivery]
defined_for: S10-cart-checkout
rules_hash: 3814f61e939a
---
# Webhook redelivery
## Definition
Webhook redelivery is when the payment provider sends the same event, with the same [`eventId`](event-id.md), to [`POST /webhooks/stripe`](post-webhooks-stripe.md) more than once. The webhook recognises a redelivered event by its `eventId` and answers it as a [duplicate](consumer-outcomes.md) instead of handling it again. The webhook answers success once the event is stored and queued, never after processing. Design intent (not stated in the spec): this stops slow processing from making the provider redeliver. When processing fails, the system retries it with its own jobs and does not ask the provider to send the event again.

## Example
The provider sends `payments.payment_succeeded` with id `evt_123` (illustrative) and gets `200 {"received": true}`. It then sends `evt_123` again:
```json
200 {"received": true, "duplicate": true}
```

## Known gaps
- The spec does not say what happens when a redelivery arrives after [the daily purge (`orders.purge-webhook-inbox`)](order-webhook-events-purge.md) has removed the stored event. It might not be recognised as a duplicate. The [guarded order transitions](guarded-update.md) would probably still block a second status change, but the spec does not say so.
- The spec does not say whether a redelivered event that was stored as [`REJECTED`](rejected-payment-event.md), [`UNMATCHED`](unmatched-payment-event.md) or [`IGNORED`](ignored-payment-event.md) is checked again or just answered as a duplicate.

## Used by
<!-- used-by:start -->
- [concurrent-delivery-copies](concurrent-delivery-copies.md)
- [consumer-outcomes](consumer-outcomes.md)
- [durable-acceptance](durable-acceptance.md)
- [guarded-update](guarded-update.md)
- [never-send-twice-guard](never-send-twice-guard.md)
- [order-webhook-events-purge](order-webhook-events-purge.md)
<!-- used-by:end -->
