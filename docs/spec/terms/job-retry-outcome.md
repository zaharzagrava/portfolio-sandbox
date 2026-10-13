---
id: job-retry-outcome
title: Job retry outcome
kind: term
status: draft
aliases: [retried]
defined_for: S49-job-scheduler
rules_hash: e3b0c44298fc
---
# Job retry outcome
## Definition
The job retry outcome is the result an operator gets from retrying a [`DEAD`](job-status.md) job through [`JobsAdminService.retryDead`](jobs-admin-service-retry-dead.md). `RETRIED` means this call moved the job back to [`QUEUED`](job-status.md) and reset its [attempts](job-attempt.md). When two retries of the same job run at the same time, exactly one of them gets `RETRIED`. So a dead job is revived once, not twice.

## Example
Two operators click "retry" on the same `DEAD` job at the same moment. One call returns `RETRIED`. The job is `QUEUED` with `attempts = 0`, and one [audit log](audit-log.md) line is written (S49.B-14).

## Known gaps
- The spec does not say what the losing concurrent retry returns.
- The spec does not say what retrying a job that is not `DEAD` returns, or what retrying an unknown id returns.

## Used by
<!-- used-by:start -->
- [audit-log](audit-log.md)
- [job-attempt](job-attempt.md)
<!-- used-by:end -->
