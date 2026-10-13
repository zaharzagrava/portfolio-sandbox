---
id: client-abort
title: Client abort
kind: term
status: draft
aliases: [client aborts]
defined_for: S50-rate-limiter
rules_hash: e83c4c4991f2
---
# Client abort
## Definition
A client abort happens when the client closes the connection or cancels the request before the handler has finished. In this system it matters for [concurrency limit policies](concurrency-limit.md) on routes. The [lease](concurrency-lease.md) taken for the request must be released on an abort, just as on success or on a thrown error. Without this, an abandoned request would hold its slot until the lease expired after [`windowMs`](window-ms.md).

## Example
Route with concurrency limit 2 and a handler that takes 300 ms. A client disconnects after 100 ms (illustrative). Its lease is released at once, so a new request can take the slot without getting [`429`](rate-limited.md).

## Known gaps
- The spec does not say how an abort is detected, or whether the handler keeps running after the lease is released.
- Not confirmed in the code: whether an abort that arrives after the handler has finished can release the lease a second time. [`release()` is idempotent ↗](../sw-external-terms.md#idempotency), so this should be harmless.

## Used by
<!-- used-by:start -->
- [S50](../capabilities/S50-rate-limiter.md): R-12
- [concurrency-lease](concurrency-lease.md)
- [concurrency-limit](concurrency-limit.md)
<!-- used-by:end -->
