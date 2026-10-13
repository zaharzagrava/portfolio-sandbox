---
id: concurrency-lease-release
title: release (concurrency lease)
kind: term
status: draft
aliases: [release]
defined_for: S50-rate-limiter
rules_hash: c73c21c69833
---
# release (concurrency lease)
## Definition
`release()` gives back a [concurrency lease](concurrency-lease.md), so another caller of the same [subject](rate-limit-subject.md) can take the slot. [It is idempotent ↗](../sw-external-terms.md#idempotency): calling it twice has the same effect as calling it once. It frees only the lease it belongs to, never another holder's lease. On the [HTTP surface](http-surface.md) the [limiter](../capabilities/S50-rate-limiter.md) calls it for you. Workers that call [`acquire`](acquire.md) themselves must call it when their work ends.

## Example
Illustrative shape, not confirmed in the code:
```ts
const lease = await rateLimiter.acquire(/* policy, subject */);
try { await doWork(); } finally { await lease.release(); }
```
Calling `lease.release()` a second time changes nothing.

## Known gaps
- Not confirmed in the code: the exact signature of `acquire` and the object that carries `release()`.
- The spec does not say what `release()` does when the store is unavailable. If it fails, the slot stays taken until the lease expires.

## Used by
<!-- used-by:start -->
- [S52](../capabilities/S52-cache-toolkit.md): R-11
- [concurrency-lease](concurrency-lease.md)
- [http-surface](http-surface.md)
- [rate-limit-subject](rate-limit-subject.md)
<!-- used-by:end -->
