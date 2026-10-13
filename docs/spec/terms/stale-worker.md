---
id: stale-worker
title: Stale worker
kind: term
status: draft
aliases: [stale]
defined_for: job-scheduler-lease
rules_hash: e81c72abb5fa
---
# Stale worker
## Definition
A stale worker is a worker that still acts as if it runs a job after its [lease](job-lease.md) has expired. Meanwhile the [reaper](job-reaper.md) may have re-queued the job, or another worker may have [claimed](job-claim.md) it again. [Attempt fencing](attempt-fencing.md) turns every write from a stale worker that ends or changes an attempt into a no-op. This is why the scheduler can promise that a stale worker changes nothing.

## Example
These values are illustrative:
1. Worker A runs attempt 2 of `search.retire-previous-index`. It then stalls, for example in a long pause, until its lease expires.
2. The reaper re-queues the job, and worker B claims it as attempt 3.
3. A wakes up and tries to mark the job `SUCCEEDED` for attempt 2. The fenced write matches no row, so the job does not change.

## Known gaps
- The spec does not say how a stale worker learns that its write was fenced out, for example whether it gets an error or a no-op result.
- The spec does not say what blocks a stale worker's write after the reaper re-queues the job but before a new claim. The reaper does not change `attempts`, so the attempt number alone does not block it.
- The spec does not say whether work a stale worker already did outside the job row is undone. Fencing covers only writes that end or change an attempt, so that work may need to be [idempotent ↗](../sw-external-terms.md#idempotency). This is design intent (not stated in the spec).

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): B-20
- [S49](../capabilities/S49-job-scheduler.md): R-11
- [attempt-fencing](attempt-fencing.md)
- [job-claim](job-claim.md)
- [job-lease](job-lease.md)
- [job-reaper](job-reaper.md)
<!-- used-by:end -->
