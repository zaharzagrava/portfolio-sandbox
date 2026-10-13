---
id: retry-after-ms
title: retryAfterMs
kind: term
status: draft
aliases: []
defined_for: S50-rate-limiter
rules_hash: e3b0c44298fc
---
# retryAfterMs
## Definition
`retryAfterMs` is the field of a [rate limit decision](rate-limit-check.md) that tells the caller how long to wait before the same request can succeed. An allowed decision reports `0`. Its meaning depends on the algorithm. For a [token bucket ↗](../sw-external-terms.md#token-bucket) it is the time until [`cost`](rate-limit-cost.md) tokens exist. For a [sliding window ↗](../sw-external-terms.md#sliding-window) it is the earliest delay that admits the request. For a [concurrency limit](concurrency-limit.md) the value is clamped. It is `null` when waiting can never help, because the cost exceeds the limit.

## Example
A [fail-closed ↗](../sw-external-terms.md#fail-open-fail-closed) decision when the store is down:
```json
{ "allowed": false, "reason": "store-unavailable", "retryAfterMs": 1000 }
```
Over HTTP this becomes `503` with `Retry-After: 1`.

## Known gaps
- The spec does not say how `retryAfterMs` is rounded into the `Retry-After` header, which is in seconds. B-05 only requires `Retry-After >= 1`.
- The spec does not state the full `429` body, so it is not confirmed whether `retryAfterMs` appears in the body as well as in the header.

## Used by
<!-- used-by:start -->
- [concurrency-limit](concurrency-limit.md)
- [rate-limit-check](rate-limit-check.md)
<!-- used-by:end -->
