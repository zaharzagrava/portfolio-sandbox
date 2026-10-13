---
id: per-shop-running-cap
title: Per-shop running job cap
kind: term
status: draft
aliases: [per-shop cap]
defined_for: job-scheduler-lease
rules_hash: 6056de3f90a5
---
# Per-shop running job cap
## Definition
The per-shop running job cap limits how many jobs of one shop can be [`RUNNING`](job-status.md) at the same time. The count covers every worker together, not each worker on its own. It stops one busy shop from [starving the others ↗](../sw-external-terms.md#starvation). [Jobs that belong to no shop](shopless-job.md) are never capped.

## Example
With the default cap of 5, if shop A already has 5 `RUNNING` jobs, [workers skip shop A's queued jobs](job-claim.md). They claim jobs from other shops, or jobs without a shop, until one of shop A's jobs finishes.

## Known gaps
- The spec does not say how a job is linked to a shop when it is enqueued.
- The spec does not say whether the cap can be set differently per shop or only changed globally.
- The spec does not say what happens to a shop's jobs when the shop is over the cap. Leaving them [`QUEUED`](job-status.md) until a slot frees up is an assumption.

## Used by
<!-- used-by:start -->
- [S49](../capabilities/S49-job-scheduler.md): R-15
- [job-scheduler-lease](../concepts/job-scheduler-lease.md): C-07
- [fleet-concurrency](fleet-concurrency.md)
- [fleet-wide-limit](fleet-wide-limit.md)
- [job-claim](job-claim.md)
- [job](job.md)
- [search-backfill-shop-state](search-backfill-shop-state.md)
- [search-refresh-popularity](search-refresh-popularity.md)
- [search-retire-previous-index](search-retire-previous-index.md)
- [shopless-job](shopless-job.md)
<!-- used-by:end -->
