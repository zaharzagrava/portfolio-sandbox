---
id: verify-stripe-signature
title: verifyStripeSignature
kind: term
status: draft
aliases: []
defined_for: S10-cart-checkout
rules_hash: e3b0c44298fc
---
# verifyStripeSignature
## Definition
`verifyStripeSignature` is the domain function that decides whether an event sent to [`POST /webhooks/stripe`](post-webhooks-stripe.md) really comes from the payment provider. It checks the [signature over the raw request body ↗](../sw-external-terms.md#webhook-signature), not over parsed JSON. It compares the signatures in [constant time ↗](../sw-external-terms.md#constant-time-comparison) and rejects timestamps outside the [clock skew tolerance](clock-skew-tolerance.md). It accepts the [current webhook secret](webhook-secret.md) and, during a rotation, the previous one. Only an event that passes becomes a [verified webhook event](verified-webhook-event.md).

Comparing in constant time stops an attacker from guessing a valid signature one byte at a time from response timings. Checking the timestamp stops an attacker from replaying an old captured event. Both reasons are design intent (not stated in the spec).

## Example
The provider signs a body with the previous secret while a rotation is in progress. The timestamp is 120 s old (illustrative), which is inside the ±300 s window. `verifyStripeSignature` accepts it. If a proxy had re-serialised the JSON first (for example, by changing the spacing), the bytes would differ and the check would fail.

## Known gaps
- The spec does not say which header carries the signature or what format it has.
- The spec does not say what the function returns on failure, or which HTTP status the controller sends for each reason.
- The spec does not say how long the previous secret stays valid, or how a rotation starts and ends.

## Used by
<!-- used-by:start -->
- [clock-skew-tolerance](clock-skew-tolerance.md)
- [verified-webhook-event](verified-webhook-event.md)
- [webhook-secret](webhook-secret.md)
<!-- used-by:end -->
