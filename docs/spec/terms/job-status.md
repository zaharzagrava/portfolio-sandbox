---
id: job-status
title: Job status
kind: term
status: draft
aliases: [legal transitions, status]
defined_for: job-scheduler-lease
rules_hash: 6d2d215ce2d6
---
# Job status
## Definition
Every job has exactly one status at a time: `QUEUED`, `RUNNING`, `SUCCEEDED`, `DEAD` or `CANCELLED`. The status says where the job is in its life: waiting, being worked on, finished, given up on, or cancelled. A job may only change status along the legal transitions. A thrown error moves a `RUNNING` job back to `QUEUED`, or to `DEAD` if it should not be [retried](job-retries.md). The [reaper](job-reaper.md) does the same for `RUNNING` jobs whose [lease](job-lease.md) has expired.

## Example
The nightly `recommendations.build-bought-together` job is [enqueued](job-enqueue.md) as `QUEUED`. A worker [claims](job-claim.md) it, and the job becomes `RUNNING`. If the handler throws, the job goes back to `QUEUED` with a backoff delay. When a later attempt finishes, it becomes `SUCCEEDED`. The `SUCCEEDED` step is illustrative, from general job-queue practice.

## Known gaps
- The spec does not say what the full list of legal transitions is. Only the moves back to `QUEUED` and to `DEAD` after a failure are stated.
- The spec does not say how a job becomes `CANCELLED`, or what happens when a cancel and a claim race. Those rules exist in S49 but are not among the rules on this page.
- The spec does not say whether a `DEAD` job can ever be re-queued.

## Used by
<!-- used-by:start -->
- [S49](../capabilities/S49-job-scheduler.md): R-01
- [job-scheduler-lease](../concepts/job-scheduler-lease.md): C-01
- [fleet-wide-limit](fleet-wide-limit.md)
- [job-claim](job-claim.md)
- [job-enqueue](job-enqueue.md)
- [job-last-error](job-last-error.md)
- [job-lease](job-lease.md)
- [job-reaper](job-reaper.md)
- [job-retries](job-retries.md)
- [job](job.md)
- [schedule-enabled](schedule-enabled.md)
- [search-retire-previous-index](search-retire-previous-index.md)
<!-- used-by:end -->
