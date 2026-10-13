---
id: search-backfill-shop-state
title: search.backfill-shop-state job
kind: term
status: draft
aliases: []
defined_for: job-scheduler-lease
rules_hash: e3b0c44298fc
---
# search.backfill-shop-state job
## Definition
`search.backfill-shop-state` is one of the jobs that [S32](../capabilities/S32-product-search.md), the product search capability, runs on the [distributed job scheduler](../capabilities/S49-job-scheduler.md). It runs like any other job: it is [enqueued](job-enqueue.md), [claimed under a lease](job-lease.md), retried on failure, and ends in a final status. The spec gives only the name, so what the job actually does is not stated. Judging by the name, it fills in or rebuilds shop-level data in the search index, but that is a guess, not a confirmed fact. Because it is tied to a shop, it most likely counts toward the [per-shop cap](per-shop-running-cap.md). The spec does not confirm this.

## Example
Illustrative: S32 enqueues `search.backfill-shop-state` for one shop, and a worker claims it. The handler throws a timeout error, so the job goes back to [`QUEUED`](job-status.md) with a [backoff delay](job-retries.md). On a later attempt it succeeds and becomes `SUCCEEDED`. If it fails on every try up to [`maxAttempts`](job-max-attempts.md), it becomes [`DEAD`](job-status.md) instead.

## Known gaps
- The spec does not say what triggers this job (a cron schedule, an event, or a manual or admin action), what its payload contains, or what [idempotency key](idempotency-key.md) it is enqueued with.
- The spec does not say what "shop state" means here, or which part of the search index the job writes.
- Not confirmed in the code: whether the job carries a shop, which would put it under the per-shop running job cap.

## Used by
<!-- used-by:start -->
- [idempotency-key](idempotency-key.md)
- [job-enqueue](job-enqueue.md)
- [job-lease](job-lease.md)
- [job-retries](job-retries.md)
- [per-shop-running-cap](per-shop-running-cap.md)
<!-- used-by:end -->
