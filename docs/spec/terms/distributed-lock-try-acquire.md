---
id: distributed-lock-try-acquire
title: DistributedLock.tryAcquire
kind: term
status: draft
aliases: [tryacquire]
defined_for: S52-cache-toolkit
rules_hash: e3b0c44298fc
---
# DistributedLock.tryAcquire
## Definition
`DistributedLock.tryAcquire` is the method that tries to take a [`DistributedLock` ↗](../sw-external-terms.md#distributed-lock) held in the shared store. `DistributedLock` [fails closed ↗](../sw-external-terms.md#fail-open-fail-closed): when the store is down, `tryAcquire` rejects with [`LockUnavailable`](lock-unavailable.md) and does not pretend the lock was taken. The [recompute lock](recompute-lock.md) is different: it fails open, and reads go ahead without it. The Decisions explain why. `DistributedLock` protects correctness, while the recompute lock only saves effort.

## Example
The store is down. A [`getOrLoad`](get-or-load.md) read still answers through the [loader](loader.md) without the recompute lock. At the same moment, a caller of `DistributedLock.tryAcquire` gets `LockUnavailable` and must not continue as if it held the lock.

## Known gaps
- The spec does not say how `tryAcquire` differs from `acquire`, for example whether it returns at once instead of waiting.
- The spec does not say what `tryAcquire` returns when another holder owns the lock, or whether it returns a fence token for `isNewerFence`.
- The spec does not give the lock lifetime or the arguments of `tryAcquire`.

## Used by
<!-- used-by:start -->
- [loader](loader.md)
- [recompute-lock](recompute-lock.md)
<!-- used-by:end -->
