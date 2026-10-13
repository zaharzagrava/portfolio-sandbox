---
id: store-clock
title: Store clock
kind: term
status: draft
aliases: [instance clock, store's clock]
defined_for: rate-limit-policy
rules_hash: fefad8b6cef2
---
# Store clock
## Definition
The store clock is the time kept by the [rate limit counter store](rate-limit-counter-store.md). Every [rate limit decision](rate-limit-policy.md) reads the time from it, never from the clock of the instance handling the request. This way all instances agree on when a [window](rate-limit-bucket.md) starts and when [tokens refill ↗](../sw-external-terms.md#token-bucket). Design intent (not stated in the spec): instance clocks can drift apart, so they would give different answers for the same bucket.

## Example
Instance A's clock runs 2 s ahead of instance B's (illustrative). Both still see the same window for [`auth.login.ip`](rate-limit-policy.md), because both use the time from the shared store.

## Known gaps
- The spec does not say which clock the in-process fallback bucket uses under [fail open ↗](../sw-external-terms.md#fail-open-fail-closed), when the store cannot be reached.

## Used by
<!-- used-by:start -->
- [S50](../capabilities/S50-rate-limiter.md): R-14
- [rate-limit-policy](../concepts/rate-limit-policy.md): C-03
- [rate-limit-bucket](rate-limit-bucket.md)
- [rate-limit-counter-store](rate-limit-counter-store.md)
- [rate-limit-policy](rate-limit-policy.md)
- [sliding-window-estimate](sliding-window-estimate.md)
<!-- used-by:end -->
