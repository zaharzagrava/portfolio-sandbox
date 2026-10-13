---
id: redis-build-lock-adapter
title: RedisBuildLockAdapter
kind: term
status: draft
aliases: []
defined_for: S34-recommendations
rules_hash: e3b0c44298fc
---
# RedisBuildLockAdapter
## Definition
`RedisBuildLockAdapter` is the code that keeps the build lock in Redis. The bought-together build uses this lock so that only one build runs at a time. Before a build reads or writes anything, it asks the adapter for the lock. If another run already holds the lock, the new run ends with `skipped_locked`. The lock is held under a lease. If the run holding it crashes, the lock expires by itself, so later builds are not blocked forever.

## Example
1. The job `recommendations.build-bought-together` fires at 03:17 (cron `17 3 * * *`). It takes the lock, which has a 1-hour lease.
2. A second run starts at 03:20 (an illustrative time) while the first is still building. It finds the lock held and ends with `skipped_locked`.
3. Suppose the first worker crashes at 03:30 (illustrative). No new build can run until the lease expires.

## Known gaps
- The spec does not say what happens when a build runs longer than its lease. A second build might take the lock while the first is still writing lists.
- The spec does not say whether a build that finishes releases the lock at once, or whether the lock stays until the lease expires.
- The spec does not say the Redis key name of the lock.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
