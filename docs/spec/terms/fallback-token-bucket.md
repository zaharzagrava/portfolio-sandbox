---
id: fallback-token-bucket
title: In-process fallback token bucket
kind: term
status: draft
aliases: [fallback bucket]
defined_for: S50-rate-limiter
rules_hash: f7231eb00f99
---
# In-process fallback token bucket
## Definition
The in-process fallback [token bucket ↗](../sw-external-terms.md#token-bucket) is a token bucket held in an instance's own memory (`FallbackLimiter`). It decides for [fail-open ↗](../sw-external-terms.md#fail-open-fail-closed) policies whenever the [shared store](rate-limit-counter-store.md) cannot. That happens when a store call fails, times out, or is skipped because the [circuit breaker](cache-store-circuit-breaker.md) is open. Its capacity is the [policy limit](rate-limit-policy.md) divided by the fleet size, so the whole fleet together stays near the real budget. It keeps a bounded number of [subjects](rate-limit-subject.md) so memory cannot grow without limit.

## Example
Policy limit 100, fleet size 4 (illustrative): each instance's fallback bucket holds `max(1, floor(100 ÷ 4)) = 25` tokens per subject. With limit 3 and fleet size 4, the capacity is `max(1, 0) = 1`.

## Known gaps
- The spec does not say where `fleetSize` comes from. The config key `rate_limit_fallback_instances` looks likely, but this is not confirmed in the code.
- The spec does not say which subjects are evicted at the subject cap. Eviction could quietly reset a subject's budget.
- The spec does not say how sliding-window and concurrency policies behave under fail open, or whether fallback usage is ever reconciled with the store.

## Used by
<!-- used-by:start -->
- [S50](../capabilities/S50-rate-limiter.md): R-18
- [cache-store-circuit-breaker](cache-store-circuit-breaker.md)
- [rate-limit-budget](rate-limit-budget.md)
- [rate-limit-counter-store](rate-limit-counter-store.md)
- [rate-limit-policy](rate-limit-policy.md)
- [rate-limit-subject-fallback](rate-limit-subject-fallback.md)
- [rate-limit-subject](rate-limit-subject.md)
<!-- used-by:end -->
