---
id: job-heartbeat
title: Job heartbeat
kind: term
status: draft
aliases: [heartbeat]
defined_for: S49-job-scheduler
rules_hash: 17606beffcc7
---
# Job heartbeat
## Definition
A heartbeat is a signal from a running [handler](job-handler.md) that it is still alive and working on its job. While heartbeats keep succeeding, the [job reaper](job-reaper.md) does not take the job back, even after the handler runs past its original [job lease](job-lease.md). A slow but healthy handler can therefore finish without being [re-queued](job-retries.md). Handlers can also send one explicitly through `ctx.heartbeat()`. Extending the lease this way is design intent (not stated in the spec).

## Example
A handler's lease runs out partway through its work, but its heartbeats keep succeeding. The reaper never re-queues it, and the job ends [`SUCCEEDED`](job-status.md) (S49.B-08).

## Known gaps
- The spec does not say how often heartbeats are sent, whether they are automatic, or how far each one extends the lease.
- The spec does not say what happens to a running handler when a heartbeat fails. `ctx.heartbeat()` has tests but no rule.
- Not confirmed in the code: the heartbeat code files and symbols are not listed.

## Used by
<!-- used-by:start -->
- [S49](../capabilities/S49-job-scheduler.md): B-08
- [job-handler](job-handler.md)
- [job-lease-ms](job-lease-ms.md)
- [job-lease](job-lease.md)
- [job-max-runtime](job-max-runtime.md)
- [job-reaper](job-reaper.md)
- [job-retries](job-retries.md)
- [realtime-config](realtime-config.md)
<!-- used-by:end -->
