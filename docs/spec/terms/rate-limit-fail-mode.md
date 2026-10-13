---
id: rate-limit-fail-mode
title: Rate limit fail mode
kind: term
status: draft
aliases: [fail mode]
defined_for: idempotency-key
rules_hash: 64d9e09ab1db
---
# Rate limit fail mode
## Definition
A fail mode is what the [rate limiter](rate-limit.md) does when it cannot decide, for example when its own [counter store](rate-limit-counter-store.md) is unavailable. The spec lists fail modes as part of how it limits request rates. In general engineering, "[fail open ↗](../sw-external-terms.md#fail-open-fail-closed)" lets the request through without a check, and "fail closed" rejects it. The spec names fail modes but does not say which ones exist or which routes use which.

## Example
Illustrative only. The spec does not describe this case. A route has a rate limit, and the store that holds its counters stops responding:
```
fail open   -> request is accepted without a limit check
fail closed -> request is rejected
```

## Known gaps
- The spec does not say which fail modes S50 offers, or which one each route uses by default.
- The spec does not say what status code or error body a client gets when a route fails closed.
- The spec does not say whether a request that a fail mode lets through still counts against the rate limit later.

## Used by
<!-- used-by:start -->
- [S50](../capabilities/S50-rate-limiter.md): R-20
- [rate-limit-policy](../concepts/rate-limit-policy.md): C-06, C-07
- [circuit-breaker-probe](circuit-breaker-probe.md)
- [concurrency-limit](concurrency-limit.md)
- [default-rate-limit-policies](default-rate-limit-policies.md)
- [get-payments](get-payments.md)
- [rate-limit-cost-resolver](rate-limit-cost-resolver.md)
- [rate-limit-counter-store](rate-limit-counter-store.md)
- [rate-limit-store-timeout-ms](rate-limit-store-timeout-ms.md)
- [rate-limit](rate-limit.md)
- [rate-limiter-service](rate-limiter-service.md)
- [rate-limiter-unavailable](rate-limiter-unavailable.md)
- [subject-extractor](subject-extractor.md)
<!-- used-by:end -->
