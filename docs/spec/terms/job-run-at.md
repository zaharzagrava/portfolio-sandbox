---
id: job-run-at
title: runAt
kind: term
status: draft
aliases: []
defined_for: S49-job-scheduler
rules_hash: e3b0c44298fc
---
# runAt
## Definition
`runAt` is the earliest moment a job may be claimed. Until then the job stays [`QUEUED`](job-status.md) and no [worker](worker-instance.md) takes it. [Claims](job-claim.md) pick due jobs in order of `runAt`, then id. Retries move `runAt` later by a [jittered backoff delay](job-retry-delay.md). A shutdown release sets it to the current time. [Enqueue](job-enqueue.md) rejects a `runAt` that is too far in the future.

## Example
A job has `runAt = 20:00Z` and was enqueued at 10:00Z. A worker that runs at 19:59:59Z leaves it `QUEUED` with `attempts = 0`. The first claim after 20:00Z picks it up.

## Known gaps
- The spec does not say what `runAt` defaults to when the option is omitted. Running immediately seems likely, but the spec does not confirm it.
- The spec does not say whether a `runAt` in the past is accepted as-is or rejected.

## Used by
<!-- used-by:start -->
- [job-claim](job-claim.md)
- [job-enqueue](job-enqueue.md)
- [job-retry-delay](job-retry-delay.md)
- [worker-instance](worker-instance.md)
<!-- used-by:end -->
