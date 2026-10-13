---
id: search-retire-previous-index
title: search.retire-previous-index job
kind: term
status: draft
aliases: [search.retire-previous-index]
defined_for: job-scheduler-lease
rules_hash: e3b0c44298fc
---
# search.retire-previous-index job
## Definition
`search.retire-previous-index` is an [S32](../capabilities/S32-product-search.md) job that runs on [S49](../capabilities/S49-job-scheduler.md) and removes the [previous search index](search-index.md) after [zero-downtime reindexing](zero-downtime-reindexing.md). Because it is an S49 job, it gets [leases](job-lease.md), [retries](job-retries.md) and [the reaper](job-reaper.md) without S32 writing that logic. Running it as a separate background job means the switch to the new index never waits for the old one to be deleted. That reason is design intent (not stated in the spec).

## Example
Illustrative lifecycle, using the real [job status values](job-status.md):
```
QUEUED → RUNNING (a worker claims it and holds the lease) → SUCCEEDED   old index removed
RUNNING → error thrown → QUEUED again after a backoff delay with [jitter](jitter.md)
RUNNING → [NonRetryableJobError](non-retryable-job-error.md), or [maxAttempts](job-max-attempts.md) reached → [DEAD](job-status.md)
```

## Known gaps
- The spec does not say what enqueues this job, whether it is enqueued after a reindex or run on a [cron schedule](time-zone-aware-cron.md), or how long the previous index is kept first.
- The spec does not say whether the job carries a shop id, so it is unknown whether the [per-shop cap](per-shop-running-cap.md) applies or whether it runs as a [shopless job](shopless-job.md).
- Not confirmed in the code: whether the job still succeeds if the previous index is already gone. This matters because the job can run again after a retry or after the reaper re-queues it.

## Used by
<!-- used-by:start -->
- [cutover](cutover.md)
- [job-lease](job-lease.md)
- [job-reaper](job-reaper.md)
- [job-retries](job-retries.md)
- [job-status](job-status.md)
- [per-shop-running-cap](per-shop-running-cap.md)
- [reindex-rollback](reindex-rollback.md)
- [search-index](search-index.md)
- [shopless-job](shopless-job.md)
- [time-zone-aware-cron](time-zone-aware-cron.md)
- [zero-downtime-reindexing](zero-downtime-reindexing.md)
<!-- used-by:end -->
