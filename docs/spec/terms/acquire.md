---
id: acquire
title: acquire
kind: term
status: draft
aliases: []
defined_for: S50-rate-limiter
rules_hash: e3b0c44298fc
---
# acquire
## Definition
`acquire` is the method of the programmatic [`RateLimiterService`](rate-limiter-service.md) that takes a [lease](concurrency-lease.md) on a [concurrency limit policy](concurrency-limit.md). It admits the call only while the [subject](rate-limit-subject.md) holds fewer unexpired leases than the policy `limit`. Callers free the lease with [`release()`](concurrency-lease-release.md), which is [idempotent ↗](../sw-external-terms.md#idempotency) and frees only that one lease. A denied `acquire` reports a [clamped](clamping.md) [`retryAfterMs`](retry-after-ms.md) so callers do not retry too soon or wait too long.

## Example
Concurrency policy with limit 2. Two calls to `acquire` for one subject both succeed. A third call is denied with `retryAfterMs` between 1000 and 5000 ms until one holder calls `release()` or its lease expires after [`windowMs`](window-ms.md).

## Known gaps
- The spec does not give the signature of `acquire` or the shape of its result.
- The spec does not say what `acquire` does when it is called on a token-bucket or sliding-window policy.

## Used by
<!-- used-by:start -->
- [clamping](clamping.md)
- [concurrency-lease](concurrency-lease.md)
- [concurrency-limit](concurrency-limit.md)
- [rate-limit-subject](rate-limit-subject.md)
<!-- used-by:end -->
