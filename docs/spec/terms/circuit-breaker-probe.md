---
id: circuit-breaker-probe
title: Circuit breaker probe
kind: term
status: draft
aliases: [probe]
defined_for: rate-limit-policy
rules_hash: ca6965c37c3e
---
# Circuit breaker probe
## Definition
[The limiter](rate-limit.md) has a [circuit breaker ↗](../sw-external-terms.md#circuit-breaker) in front of the [counter store](rate-limit-counter-store.md). After enough consecutive store failures it opens and stops calling the store for a cooldown. When the cooldown ends, the probe is the single request allowed through to the store to test whether it has recovered. Design intent (not stated in the spec): this stops every request from waiting on a store that is down, and it keeps a recovering store from getting a sudden flood of calls.

## Example
The store goes down and three requests in a row fail against it, so the breaker opens. For the next 2 s the limiter does not call the store. The first request after that is the probe and goes to the store.

## Known gaps
- The spec does not say what happens after the probe: whether success closes the breaker, or failure starts another cooldown.
- The spec does not say how requests are decided while the breaker is open or while the probe is in flight. Presumably the policy's [fail mode](rate-limit-fail-mode.md) applies ([fallback bucket](rate-limit-bucket.md) or [`rate_limiter_unavailable`](rate-limiter-unavailable.md)), but this is not stated.
- The spec does not say whether the breaker is per instance or shared, or whether there is one per store or one per policy.

## Used by
<!-- used-by:start -->
- [S13](../capabilities/S13-payment-intents.md): B-13
- [S33](../capabilities/S33-autocomplete.md): R-14
- [S50](../capabilities/S50-rate-limiter.md): R-19
- [S52](../capabilities/S52-cache-toolkit.md): B-17
- [rate-limit-policy](../concepts/rate-limit-policy.md): C-08
- [cache-store-circuit-breaker](cache-store-circuit-breaker.md)
- [provider-operation](provider-operation.md)
- [rate-limit-bucket](rate-limit-bucket.md)
- [rate-limit-counter-store](rate-limit-counter-store.md)
- [rate-limit-fail-mode](rate-limit-fail-mode.md)
- [rate-limit](rate-limit.md)
<!-- used-by:end -->
