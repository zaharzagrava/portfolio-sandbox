---
id: rate-limit-exemption
title: Rate limit exemption
kind: term
status: draft
aliases: [exempt, exempt reason, exemption]
defined_for: S50-rate-limiter
rules_hash: 6b08e0fd6604
---
# Rate limit exemption
## Definition
A [rate limit](rate-limit.md) exemption takes one route out of all rate limiting. You mark the route with the [`@RateLimitExempt(reason)` decorator](rate-limit-decorator.md). An exempt route gets neither its own [policies](rate-limit-policy.md) nor the [`default.read` / `default.write`](default-rate-limit-policies.md) [rate limit](rate-limit) that covers routes without a decorator. The reason must not be blank. If it is blank, the application [refuses to start](startup-validation.md). Design intent (not stated in the spec): requiring a reason makes every unlimited route a visible, explained choice, so no route ends up unlimited by accident.

## Example
```ts
// Illustrative handler; only the decorator and its non-blank-reason rule come from S50
@RateLimitExempt('illustrative: internal probe, never called by clients')
@Get('illustrative-path')
handle() { ... }
```
With `@RateLimitExempt('')` or a reason of only spaces, startup fails (S50.B-19).

## Known gaps
- The spec does not say exactly what counts as "blank". Not confirmed in the code: whether a reason made only of whitespace is rejected like an empty string.
- The spec does not say what happens if one route has both `@RateLimit(...)` and `@RateLimitExempt(...)`.
- The spec does not say whether the exemption reason is logged, sent to metrics, or exposed anywhere after startup.

## Used by
<!-- used-by:start -->
- [S50](../capabilities/S50-rate-limiter.md): B-19
- [default-rate-limit-policies](default-rate-limit-policies.md)
- [rate-limit-decorator](rate-limit-decorator.md)
- [rate-limit-policy](rate-limit-policy.md)
- [rate-limit](rate-limit.md)
- [startup-validation](startup-validation.md)
<!-- used-by:end -->
