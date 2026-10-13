---
id: http-surface
title: HTTP surface (rate limiting)
kind: term
status: draft
aliases: [over http]
defined_for: S50-rate-limiter
rules_hash: e1338b55596a
---
# HTTP surface (rate limiting)
## Definition
The HTTP surface is the part of the [rate limiter](../capabilities/S50-rate-limiter.md) that runs on web routes, not inside workers or application services. It is driven by the [`@RateLimit(...)`](rate-limit-decorator.md) and [`@RateLimitExempt(reason)`](rate-limit-exemption.md) decorators, and by the [default policies](default-rate-limit-policies.md) for routes that have neither. On this surface, decisions become HTTP answers: a `429` [problem+json ↗](../sw-external-terms.md#problem-json) body, a `422` [`rate_limit_cost_exceeded`](rate-limit-cost-exceeded.md), or a `503` [`rate_limiter_unavailable`](rate-limiter-unavailable.md). Allowed responses carry the [rate-limit response headers](rate-limit-response-headers.md). When a route works out a request's cost, that cost is rounded up to a whole number before it reaches the limiter.

## Example
An allowed request on a [policy](rate-limit-policy.md) `p` with limit 5 over 15 minutes gets these headers:
```
RateLimit-Policy: "p";q=5;w=900
RateLimit: "p";r=…;t=…
```
When `p` is used up, the same route answers `429` problem+json. The body names neither the policy nor the [subject](rate-limit-subject.md).

## Known gaps
- The spec does not say how headers are formatted when a route has several policies. No rule covers header formatting (AS-82); B-06 only summarizes it.
- The spec does not say which fields the full `429` body contains. B-07 only says that the policy name and the subject are left out.

## Used by
<!-- used-by:start -->
- [S50](../capabilities/S50-rate-limiter.md): R-06
- [concurrency-lease-release](concurrency-lease-release.md)
- [configure-http-app](configure-http-app.md)
- [default-rate-limit-policies](default-rate-limit-policies.md)
- [rate-limit-cost-resolver](rate-limit-cost-resolver.md)
- [rate-limit-policy](rate-limit-policy.md)
- [rate-limit-response-headers](rate-limit-response-headers.md)
- [rate-limit-subject](rate-limit-subject.md)
- [start-management-listener](start-management-listener.md)
<!-- used-by:end -->
