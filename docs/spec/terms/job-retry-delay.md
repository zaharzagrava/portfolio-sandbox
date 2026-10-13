---
id: job-retry-delay
title: Job retry delay
kind: term
status: draft
aliases: [backoff, retry delay]
defined_for: S49-job-scheduler
rules_hash: ade38ef26bd7
---
# Job retry delay
## Definition
When a handler throws an error, the job goes back to [`QUEUED`](job-status.md) and waits for the retry delay before it can be [claimed](job-claim.md) again. The delay uses [full jitter](jitter.md): a random value between zero and a cap. [The cap grows exponentially ↗](../sw-external-terms.md#exponential-backoff) with the number of attempts, up to a fixed ceiling (S49.R-12). Jitter is there so that failed jobs do not all come back in waves.

## Example
A handler throws on attempt 1. The cap is `min(15 min, 1 s × 2^1)` = 2 s. So the job is re-queued with a random delay between 0 and 2 s, and it succeeds on attempt 2 (S49.B-05).

## Known gaps
- The spec does not say how the delay is stored. The likely way is by setting [`runAt`](job-run-at.md) to now plus the delay, but this is not stated.
- The spec does not say whether the delay applies when [the reaper](job-reaper.md) re-queues a job with an [expired lease](job-lease.md). S49.R-12 covers only thrown errors.
- A shutdown release is not a retry delay. That job returns with `runAt = now` and its attempt refunded (S49.B-11).

## Used by
<!-- used-by:start -->
- [S49](../capabilities/S49-job-scheduler.md): B-05
- [jitter](jitter.md)
- [job-claim](job-claim.md)
- [job-lease](job-lease.md)
- [job-reaper](job-reaper.md)
- [job-run-at](job-run-at.md)
- [non-retryable-broker-error](non-retryable-broker-error.md)
- [pending-row](pending-row.md)
<!-- used-by:end -->
