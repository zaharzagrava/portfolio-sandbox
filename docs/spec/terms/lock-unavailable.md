---
id: lock-unavailable
title: LockUnavailable
kind: term
status: draft
aliases: []
defined_for: S52-cache-toolkit
rules_hash: e3b0c44298fc
---
# LockUnavailable
## Definition
`LockUnavailable` is the error that [`DistributedLock.tryAcquire`](distributed-lock-try-acquire.md) rejects with when the [shared store](l2-cache.md) is down. It means the lock state could not be checked or recorded. It does not mean another holder owns the lock. Callers do not get the lock by default, because `DistributedLock` [fails closed ↗](../sw-external-terms.md#fail-open-fail-closed): it protects correctness. The [per-key recompute lock](recompute-lock.md) is different. It fails open, so a cache read just goes ahead without it.

## Example
The shared store refuses connections. A [`getOrLoad`](get-or-load.md) read for a key still answers from the [loader](loader.md) without the recompute lock. At the same moment, `DistributedLock.tryAcquire` for a job rejects with `LockUnavailable`.

## Known gaps
- The spec does not say whether `acquire`, `extend` and `withLock` also reject with `LockUnavailable` when the store is down. It names only `tryAcquire`.
- The spec does not say whether `LockUnavailable` is raised on a store timeout or an open circuit breaker, or only when the store refuses connections.
- Not confirmed in the code: the file that defines `LockUnavailable` and whether it carries a retry hint.

## Used by
<!-- used-by:start -->
- [l2-cache](l2-cache.md)
- [loader](loader.md)
- [recompute-lock](recompute-lock.md)
<!-- used-by:end -->
