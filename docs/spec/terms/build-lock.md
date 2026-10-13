---
id: build-lock
title: Build lock
kind: term
status: draft
aliases: [lock]
defined_for: S34-recommendations
rules_hash: b4e3cee931a1
---
# Build lock
## Definition
The build lock lets only a single [bought-together build](order-baskets-build.md) run at a time. It is held in [Redis ↗](../sw-external-terms.md#time-to-live) by [`RedisBuildLockAdapter`](redis-build-lock-adapter.md). A build takes the lock before it starts working. If another run finds the lock already held, it ends with [`skipped_locked`](skipped-locked.md). The lock has a [lease](job-lease.md), so if the build holding it crashes, the lock expires and a later run can take it. The likely reason is to stop two runs from replacing or removing the same [neighbour lists](neighbour-list.md) at once. That reason is design intent (not stated in the spec).

## Example
1. The nightly job `recommendations.build-bought-together` fires at 03:17 (cron `17 3 * * *`) and takes the build lock with its 1-hour lease.
2. A second run starts at 03:20 while the first is still building. This start time is illustrative. The second run finds the lock held and ends `skipped_locked`.
3. If the first worker had crashed at 03:30, the lock would stay held until its lease ran out. Only after that could a new run build.

## Known gaps
- The spec does not say what happens if a build runs longer than the lease. A second build might then take the lock while the first is still writing lists.
- The spec does not say whether a build that finishes normally releases the lock straight away, or whether the lock stays until the lease runs out.
- The spec does not say the Redis key name of the lock.

## Used by
<!-- used-by:start -->
- [job-lease](job-lease.md)
- [neighbour-list](neighbour-list.md)
- [order-baskets-build](order-baskets-build.md)
- [skipped-locked](skipped-locked.md)
<!-- used-by:end -->
