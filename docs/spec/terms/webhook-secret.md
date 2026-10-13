---
id: webhook-secret
title: Webhook secret
kind: term
status: draft
aliases: []
defined_for: S10-cart-checkout
rules_hash: 32342fbce4d8
---
# Webhook secret
## Definition
The webhook secret is the shared secret used to check the signature on events sent to [`POST /webhooks/stripe`](post-webhooks-stripe.md). [`verifyStripeSignature`](verify-stripe-signature.md) checks the signature over the raw body in [constant time ↗](../sw-external-terms.md#constant-time-comparison). It also requires the timestamp to be within the [clock skew tolerance](clock-skew-tolerance.md). It accepts the current secret and, during a rotation, the previous one too. Only an event that passes this check can become a [verified webhook event](verified-webhook-event.md) and mark an order `PAID`.

## Example
During a secret rotation, the payment provider still signs an event with the previous secret. The timestamp is 120 s old (illustrative), which is inside the ±300 s window. The event is accepted, stored and queued:
```json
{"received": true}
```

## Known gaps
- The spec does not say which status code a bad signature or a stale timestamp gets.
- The spec does not say how long the previous secret stays valid, or how a rotation is started and ended.
- The spec does not say where the secret is configured or stored.

## Used by
<!-- used-by:start -->
- [clock-skew-tolerance](clock-skew-tolerance.md)
- [guest-cart-token](guest-cart-token.md)
- [verified-webhook-event](verified-webhook-event.md)
- [verify-stripe-signature](verify-stripe-signature.md)
<!-- used-by:end -->
