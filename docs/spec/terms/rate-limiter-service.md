---
id: rate-limiter-service
title: RateLimiterService
kind: term
status: draft
aliases: [programmatic ratelimiterservice]
defined_for: S50-rate-limiter
rules_hash: 8d31c94b81b2
---
# RateLimiterService
## Definition
`RateLimiterService` is the programmatic way into the shared limiter. Workers and application services use it instead of the [route decorators](rate-limit-decorator.md). It offers the methods `check`, `acquire`, `refund`, `reset` and `penalize`. It uses the same [rate limit policies](rate-limit-policy.md), [subjects](rate-limit-subject.md), costs and [fail modes](rate-limit-fail-mode.md) as the HTTP surface. Each decision is one atomic step in the [rate limit counter store](rate-limit-counter-store.md) and uses only the store clock.

## Example
A worker calls `check` 50 times in parallel for one new subject on a token-bucket policy with a burst of 10. Exactly 10 calls are allowed, with `remaining` going from 9 down to 0. The other 40 are denied with `limit-exceeded` (S50.B-01). A call with `cost: 0` throws `InvalidRateLimitCostError` and changes nothing (S50.R-04).

## Known gaps
- The spec does not give the method signatures or the shape of the result for `check`, `acquire`, `refund`, `reset` or `penalize`.
- The spec does not say when it is safe to call `refund` and `reset`. Tests exist (AS-58, AS-59), but the spec has no rule for them.
- The spec does not say how `penalize` behaves. Penalties are a P2 story and the spec has no rule for them yet (AS-60 to AS-65).

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-31
- [marketing-cap](marketing-cap.md)
- [marketing-email](marketing-email.md)
- [notify-marketing-push](notify-marketing-push.md)
- [rate-limit-counter-store](rate-limit-counter-store.md)
- [rate-limit-decorator](rate-limit-decorator.md)
- [rate-limit-fail-mode](rate-limit-fail-mode.md)
- [rate-limit-policy](rate-limit-policy.md)
- [rate-limit-subject](rate-limit-subject.md)
- [reset-on-success](reset-on-success.md)
- [transactional-delivery](transactional-delivery.md)
- [transactional-send](transactional-send.md)
<!-- used-by:end -->
