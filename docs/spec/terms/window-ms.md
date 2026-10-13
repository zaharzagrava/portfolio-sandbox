---
id: window-ms
title: windowMs
kind: term
status: draft
aliases: []
defined_for: S50-rate-limiter
rules_hash: e3b0c44298fc
---
# windowMs
## Definition
`windowMs` is the time span of a [rate limit policy](rate-limit-policy.md), given in milliseconds. Each of the three algorithms uses it differently. A [token bucket ↗](../sw-external-terms.md#token-bucket) refills `limit` tokens per `windowMs`. A [sliding window ↗](../sw-external-terms.md#sliding-window) counts usage over `windowMs`. In a [concurrency limit](concurrency-limit.md), `windowMs` is the lifetime of a [lease](concurrency-lease.md), so the slot of a crashed holder is freed when it expires.

## Example
Policy `p` with limit 5 per 15 minutes has `windowMs` 900000. The response advertises the window in seconds:
```
[RateLimit-Policy](rate-limit-response-headers.md): "p";q=5;w=900
```

## Known gaps
- The spec does not say which values of `windowMs` are allowed, or whether a policy is checked for them when it is declared.
- The spec does not say how to pick `windowMs` for a concurrency policy relative to the handler's longest normal run time.

## Used by
<!-- used-by:start -->
- [concurrency-lease](concurrency-lease.md)
- [concurrency-limit](concurrency-limit.md)
- [rate-limit-policy](rate-limit-policy.md)
<!-- used-by:end -->
