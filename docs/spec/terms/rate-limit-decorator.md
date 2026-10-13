---
id: rate-limit-decorator
title: Rate limit decorator
kind: term
status: draft
aliases: [decorator, route decorator]
defined_for: S50-rate-limiter
rules_hash: 25a1afe3e62e
---
# Rate limit decorator
## Definition
[Rate limiting](../capabilities/S50-rate-limiter.md) is attached to a route with a decorator. `@RateLimit(...)` runs the route's [policies](rate-limit-policy.md) as an interceptor. [`@RateLimitExempt(reason)`](rate-limit-exemption.md) removes the route from all limiting, and the reason must not be blank. A route with neither decorator gets a [default policy](default-rate-limit-policies.md), chosen by HTTP method. Throttling runs after authentication and before validation and the [idempotency check](idempotency-key.md).

## Example
```ts
@RateLimit(...)            // runs the route's policies (exact arguments not shown in the facts)
@RateLimitExempt('reason') // exempts the route; a blank reason stops startup
```
If a route has two policies and the second denies, the [units](rate-limit-cost.md) taken by the first are returned.

## Known gaps
- The spec does not show the argument shape of `@RateLimit(...)`, for example how policies, [cost resolvers](rate-limit-cost-resolver.md) or [subject extractors](subject-extractor.md) are passed in.
- The spec does not say what happens if a route has both `@RateLimit` and `@RateLimitExempt`.

## Used by
<!-- used-by:start -->
- [S50](../capabilities/S50-rate-limiter.md): B-18
- [default-rate-limit-policies](default-rate-limit-policies.md)
- [idempotency-key](idempotency-key.md)
- [nestjs-module](nestjs-module.md)
- [rate-limit-cost-resolver](rate-limit-cost-resolver.md)
- [rate-limit-cost](rate-limit-cost.md)
- [rate-limit-exemption](rate-limit-exemption.md)
- [rate-limit-policy](rate-limit-policy.md)
- [rate-limiter-service](rate-limiter-service.md)
- [subject-extractor](subject-extractor.md)
<!-- used-by:end -->
