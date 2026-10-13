---
id: rate-limit-budget
title: Rate limit budget
kind: term
status: draft
aliases: [budget]
defined_for: S50-rate-limiter
rules_hash: 515b6106d9ee
---
# Rate limit budget
## Definition
The budget is the total number of units a [rate limit policy](rate-limit-policy.md) lets one [subject](rate-limit-subject.md) use. For a [token bucket ↗](../sw-external-terms.md#token-bucket) that is the bucket capacity; for a [sliding window ↗](../sw-external-terms.md#sliding-window), the requests admitted per window; for a [concurrency limit](concurrency-limit.md), the [leases](concurrency-lease.md) held at once. Each request spends units equal to its [rate limit cost](rate-limit-cost.md). Every decision is one [atomic step ↗](../sw-external-terms.md#atomicity) in the [shared store](rate-limit-counter-store.md), so the units admitted across all instances never exceed the budget.

## Example
Burst 10 and 50 parallel `check` calls on a fresh subject: exactly 10 are allowed and 40 are denied with `[limit-exceeded](rate-limited.md)` (B-01). This holds even when the calls arrive at different instances.

## Known gaps
- The spec does not hold the budget exactly under [fail open ↗](../sw-external-terms.md#fail-open-fail-closed). Each instance then uses a [local fallback bucket](fallback-token-bucket.md) with a share of the limit, so the fleet-wide total only approximates the budget.
- The spec does not state rules for the "local leased budget" (AS-21 to AS-25). It is a separate P2 feature and needs review before anyone relies on it.

## Used by
<!-- used-by:start -->
- [S50](../capabilities/S50-rate-limiter.md): R-13
- [client-address](client-address.md)
- [concurrency-lease](concurrency-lease.md)
- [concurrency-limit](concurrency-limit.md)
- [failures-only-policy](failures-only-policy.md)
- [fallback-token-bucket](fallback-token-bucket.md)
- [mutating-route](mutating-route.md)
- [rate-limit-cost](rate-limit-cost.md)
- [rate-limit-counter-store](rate-limit-counter-store.md)
- [rate-limit-policy](rate-limit-policy.md)
- [rate-limit-subject](rate-limit-subject.md)
<!-- used-by:end -->
