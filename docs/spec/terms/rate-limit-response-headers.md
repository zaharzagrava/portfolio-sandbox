---
id: rate-limit-response-headers
title: Rate-limit response headers
kind: term
status: draft
aliases: []
defined_for: idempotency-key
rules_hash: e3b0c44298fc
---
# Rate-limit response headers
## Definition
Rate-limit response headers are HTTP headers that [S50](../capabilities/S50-rate-limiter.md) adds to responses on [rate-limited routes](rate-limit.md). They tell the client about its rate limit. A client can use them to slow down before it gets a `429`, or to know when to try again. Design intent (not stated in the spec): clients that retry with the same [idempotency key](idempotency-key.md) can follow these headers. Without them, a client might keep retrying a request that will be refused.

## Example
A route has a rate limit of 3. The fourth identical request with the same `Idempotency-Key` is refused. The header below is illustrative only: [`Retry-After` ↗](../sw-external-terms.md#retry-after) is a standard HTTP header, but the spec does not name the headers S50 sends.
```
HTTP/1.1 429 Too Many Requests
Retry-After: 30        (illustrative)
```

## Known gaps
- The spec does not say which headers are sent, what they are called, or what values they carry.
- The spec does not say whether the headers come on every response or only on `429` responses.
- The spec does not say whether the headers differ for [token bucket ↗](../sw-external-terms.md#token-bucket), [sliding window ↗](../sw-external-terms.md#sliding-window) and concurrency limits.

## Used by
<!-- used-by:start -->
- [http-surface](http-surface.md)
- [idempotency-key](idempotency-key.md)
- [rate-limit-cost-exceeded](rate-limit-cost-exceeded.md)
- [rate-limit](rate-limit.md)
<!-- used-by:end -->
