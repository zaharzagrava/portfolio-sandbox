---
id: rate-limiter-unavailable
title: rate_limiter_unavailable
kind: term
status: draft
aliases: []
defined_for: rate-limit-policy
rules_hash: e3b0c44298fc
---
# rate_limiter_unavailable
## Definition
`rate_limiter_unavailable` is the error code returned with `503` when the [counter store](rate-limit-counter-store.md) fails and the [policy's fail mode](rate-limit-fail-mode.md) is [`closed` ↗](../sw-external-terms.md#fail-open-fail-closed). The request is refused, not admitted without a decision. The response carries a short [`Retry-After` ↗](../sw-external-terms.md#retry-after), and the rule sets its value. Policies with fail mode `open` never return this code. They fall back to an [in-process token bucket ↗](../sw-external-terms.md#token-bucket) instead.

## Example
S13 fails closed on `POST /payments/intents`. If the limiter store is down when a buyer creates a payment intent, the buyer gets:
```
HTTP/1.1 503 Service Unavailable
Retry-After: 1
```
with code `rate_limiter_unavailable` in the body.

## Known gaps
- The spec does not say whether requests get this answer while the [circuit breaker ↗](../sw-external-terms.md#circuit-breaker) is open and the store is being skipped, or only when a store call actually fails.
- The spec does not say which policies other than S13's use fail mode `closed`.

## Used by
<!-- used-by:start -->
- [rate-limit-counter-store](rate-limit-counter-store.md)
- [rate-limit-fail-mode](rate-limit-fail-mode.md)
<!-- used-by:end -->
