---
id: fleet-wide-limit
title: Fleet-wide limit
kind: term
status: draft
aliases: [fleet, not per worker, whole fleet]
defined_for: job-scheduler-lease
rules_hash: d96eaca31dca
---
# Fleet-wide limit
## Definition
A fleet-wide limit counts across every worker together, not inside each worker separately. In this system the [per-shop cap](per-shop-running-cap.md) is a fleet-wide limit. It is checked against the total number of [`RUNNING` jobs](job-status.md) of a shop on all workers. Adding more workers does not raise how many jobs one shop can run at once. Design intent (not stated in the spec): a cap counted per worker would grow with the fleet size, so it could not stop one shop from [starving ↗](../sw-external-terms.md#starvation) the others.

## Example
The default per-shop cap is 5. Worker 1 runs 3 jobs of shop A, and worker 2 runs 2 jobs of shop A. The fleet total for shop A is now 5. No worker may [claim](job-claim.md) another job of shop A, even though each worker alone is under 5.

## Known gaps
- The spec does not say where the fleet-wide count is kept or checked, for example in the database during the claim.
- The spec does not say how the count stays correct when a worker dies while it still holds a [lease](job-lease.md), before the [reaper](job-reaper.md) re-queues the job.

## Used by
<!-- used-by:start -->
- [S49](../capabilities/S49-job-scheduler.md): R-15
- [S51](../capabilities/S51-realtime-push.md): R-27
- [fleet-concurrency](fleet-concurrency.md)
- [hash-queue-limit](hash-queue-limit.md)
- [job-claim](job-claim.md)
- [job-lease](job-lease.md)
- [job-reaper](job-reaper.md)
- [job-status](job-status.md)
- [per-shop-running-cap](per-shop-running-cap.md)
<!-- used-by:end -->
