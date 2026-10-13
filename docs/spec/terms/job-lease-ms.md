---
id: job-lease-ms
title: leaseMs
kind: term
status: draft
aliases: []
defined_for: S49-job-scheduler
rules_hash: e3b0c44298fc
---
# leaseMs
## Definition
`[lease](job-lease.md)Ms` is a setting on a [job handler](job-handler.md) that controls how long a claimed job's lease lasts. When a worker claims a job, the lease is set to `leaseMs`, counted from the moment of the claim. If the lease expires while the job is still [`RUNNING`](job-status.md), the [job reaper](job-reaper.md) may take the job back. [Heartbeats](job-heartbeat.md) keep the job safe from the reaper, so a handler can run longer than `leaseMs`.

## Example
A handler declares `leaseMs: 30000` (illustrative). A worker claims a job at 10:00:00Z, so the lease runs until 10:00:30Z. If heartbeats keep succeeding, the reaper never takes the job and it ends `SUCCEEDED` (S49.B-08).

## Known gaps
- The spec does not say the default value of `leaseMs`, or where exactly it is declared. It is probably an option of `@JobHandler`, but the spec does not confirm this.
- The spec does not say how far a successful heartbeat extends the lease.
- Not confirmed in the code: the claim and reaper code files are not listed, so no rule about `leaseMs` is tied to a code symbol.

## Used by
<!-- used-by:start -->
- [job-handler](job-handler.md)
- [job-heartbeat](job-heartbeat.md)
- [job-reaper](job-reaper.md)
<!-- used-by:end -->
