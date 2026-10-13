---
id: attempt-fencing
title: Attempt fencing
kind: term
status: draft
aliases: [fenced]
defined_for: job-scheduler-lease
rules_hash: 2926e0621b25
---
# Attempt fencing
## Definition
Attempt fencing protects writes that end or change an attempt. Each such write must match both the worker that holds [the lease](job-lease.md) and the current [attempt number](job-attempt.md). If either one no longer matches, the write changes nothing. This is how the system guarantees that a worker whose lease expired, and whose job was re-queued or claimed again, changes nothing.

## Example
These values are illustrative:
1. Worker A is running attempt 2 of `search.retire-previous-index` and stalls until its lease expires.
2. [The reaper](job-reaper.md) re-queues the job, and worker B claims it as attempt 3.
3. When A finally tries to mark the job [`SUCCEEDED`](job-status.md) for attempt 2, the fenced write matches no row and the job is unchanged.

## Known gaps
- The spec does not say how a worker learns that its write was fenced out, for example whether it gets an error or a no-op result.

## Used by
<!-- used-by:start -->
- [S49](../capabilities/S49-job-scheduler.md): R-11, B-09
- [job-scheduler-lease](../concepts/job-scheduler-lease.md): C-04
- [job-attempt](job-attempt.md)
- [job-lease](job-lease.md)
- [job-reaper](job-reaper.md)
- [partition-owner](partition-owner.md)
- [payment-processor](payment-processor.md)
- [stale-worker](stale-worker.md)
<!-- used-by:end -->
