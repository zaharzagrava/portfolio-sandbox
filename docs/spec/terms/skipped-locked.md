---
id: skipped-locked
title: skipped_locked
kind: term
status: draft
aliases: []
defined_for: S34-recommendations
rules_hash: 1840f8dc2e78
---
# skipped_locked
## Definition
`skipped_locked` is a [build end state](build-end-states.md) of the [`recommendations.build-bought-together`](order-baskets-build.md) job. A run ends with it when another build already holds the [build lock](build-lock.md). That run reads nothing and writes nothing, and the lists of the running build stay as they are. The lock is held in Redis by `RedisBuildLockAdapter` and has a [lease](job-lease.md). If the holder crashes, the lease expires and a later run can take the lock. One build at a time keeps two runs from replacing or removing the same [neighbour lists](direct-neighbour.md) at once. This is design intent (not stated in the spec).

## Example
1. The nightly build starts at 03:17 (cron `17 3 * * *`) and takes the build lock, which has a 1-hour lease.
2. A second run starts at 03:20 while the first is still working. This start time is illustrative.
3. The second run sees the lock is held and ends with `skipped_locked`. The first build carries on unchanged.
4. If the first holder had crashed, the lock would expire when its lease ends, and the next run could build.

## Known gaps
- The spec does not say whether a `skipped_locked` run is counted in [`recommendations_build_skipped_total`](recommendations-build-skipped-total.md) or in another metric.
- The spec does not say whether the job scheduler (S49) treats `skipped_locked` as a success, or retries the run later.
- The spec does not say what result body comes with `skipped_locked`, for example whether `{products, edges, removed}` is returned with zero counts.

## Used by
<!-- used-by:start -->
- [S53](../capabilities/S53-events-projections.md): B-06
- [build-end-states](build-end-states.md)
- [build-lock](build-lock.md)
- [direct-neighbour](direct-neighbour.md)
- [job-lease](job-lease.md)
<!-- used-by:end -->
