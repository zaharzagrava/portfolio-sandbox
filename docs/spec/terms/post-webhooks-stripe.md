---
id: post-webhooks-stripe
title: POST /webhooks/stripe
kind: term
status: draft
aliases: [/webhooks/stripe]
defined_for: S10-cart-checkout
rules_hash: 581faa0ce274
---
# POST /webhooks/stripe
## Definition
`POST /webhooks/stripe` is the endpoint where the payment provider sends [signed payment events](verified-webhook-event.md). It needs no session. It checks the signature with [`verifyStripeSignature`](verify-stripe-signature.md), then [stores and queues the event](job-enqueue.md), and answers before any processing happens. A job processes the queued event later. Only that processing can mark an order `PAID`, never the browser's redirect. It reaches the same [guarded transitions](guarded-update.md) as the [payments consumer](event-consumer.md) on [`payments.events`](payments-events-topic.md), so an event that arrives on both paths gives one outcome.

## Example
The provider sends the same event `evt_123` twice. The event ID is illustrative. The first call stores and queues it. The second call is caught as a [duplicate](consumer-outcomes.md):
```json
{"received": true, "duplicate": true}
```
A signed body that is not JSON, or has no `id` and `type`, gets [`400 invalid_payload`](invalid-payload.md). [A body over the cap ↗](../sw-external-terms.md#http-413-content-too-large) gets `413`.

## Known gaps
- The spec does not say which status code a bad signature or an out-of-window timestamp gets.
- The spec does not say what happens to an event after its last processing attempt fails. It only says the event is never lost.
- The spec does not say how this endpoint is protected from rate or abuse beyond the signature and the body cap.

## Used by
<!-- used-by:start -->
- [consumer-outcomes](consumer-outcomes.md)
- [event-consumer](event-consumer.md)
- [guarded-update](guarded-update.md)
- [job-enqueue](job-enqueue.md)
- [payment-event-outcome](payment-event-outcome.md)
- [verified-webhook-event](verified-webhook-event.md)
<!-- used-by:end -->
