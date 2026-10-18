---
id: rate-limit-cost-resolver
title: Rate limit cost resolver
kind: term
status: draft
aliases: [resolver]
defined_for: S50-rate-limiter
rules_hash: 6f22ed46db49
---
# Rate limit cost resolver
## Definition
A cost resolver is a function on a [rate-limited route](rate-limit-decorator.md). It works out how many units one request should cost, instead of the default single unit. On the [HTTP surface](http-surface.md) its result is rounded up, raised to at least one unit, and replaced by one unit when it is not a finite number. If the cost is larger than [the policy's limit](rate-limit-policy.md), the request is refused with [`rate_limit_cost_exceeded`](rate-limit-cost-exceeded.md). If the resolver itself throws, the policy's [fail mode](rate-limit-fail-mode.md) decides the outcome, and the client never sees a raw `500`.

## Example
A resolver returns `2.3`, so the request costs `3` units. It returns `0.4`, so the cost is `1`. It returns `NaN`, so the cost is `1`. On a policy with limit 5, a result of `7` gets `422` `rate_limit_cost_exceeded` (illustrative values).

## Known gaps
- The spec does not say how a resolver is attached to `@RateLimit(...)` or what input it receives, such as the request or the subject.
- The spec does not say whether a resolver is allowed on sliding-window or concurrency policies. The sliding-window rule only describes adding one request at a time.

## Used by
<!-- used-by:start -->
- [S50](../capabilities/S50-rate-limiter.md): R-06, R-20
- [http-surface](http-surface.md)
- [rate-limit-decorator](rate-limit-decorator.md)
- [rate-limit-fail-mode](rate-limit-fail-mode.md)
- [rate-limit-policy](rate-limit-policy.md)
<!-- used-by:end -->
