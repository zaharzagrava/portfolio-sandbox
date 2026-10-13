---
id: non-retryable-job-error
title: NonRetryableJobError
kind: term
status: draft
aliases: []
defined_for: job-scheduler-lease
rules_hash: bef332f05ab6
---
# NonRetryableJobError
## Definition
`NonRetryableJobError` is the error a job handler throws when trying again cannot help. The job becomes [`DEAD`](job-status.md) right away, even if it has attempts left before [`maxAttempts`](job-max-attempts.md). Any other thrown error [re-queues](job-retries.md) the job with [backoff](job-retries.md). Design intent (not stated in the spec): it saves retries and worker time on failures that are permanent, such as bad input.

## Example
Illustrative: the [`search.backfill-shop-state`](search-backfill-shop-state.md) handler finds that the shop in its payload no longer exists. It throws `NonRetryableJobError`, and the job goes straight to `DEAD` with no further attempts.

## Known gaps
- The spec does not say whether the error message or cause is stored on the `DEAD` job for later inspection.

## Used by
<!-- used-by:start -->
- [outbox-task-queue](../concepts/outbox-task-queue.md): C-07
- [job-retries](job-retries.md)
- [outbox-relay](outbox-relay.md)
- [parked-row](parked-row.md)
<!-- used-by:end -->
