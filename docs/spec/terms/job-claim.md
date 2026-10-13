---
id: job-claim
title: Job claim
kind: term
status: draft
aliases: [claim]
defined_for: job-scheduler-lease
rules_hash: 8cbeab198f2d
---
# Job claim
## Definition
A claim is how a worker takes a `QUEUED` job from the database so it can run it under a lease. Claims use row locks with skip-locked: rows already locked by another worker are skipped instead of waited on. Two workers must never claim the same job. Claims must also respect the per-shop cap, so a shop never has more running jobs than the cap allows. Design intent (not stated in the spec): skip-locked lets many workers poll the same table without blocking each other.

## Example
Workers A and B both poll for work at the same moment. A locks the `search.refresh-popularity` job row first. B skips that locked row and claims the next eligible job. B never waits for A, and never runs the same job.

## Known gaps
- The spec does not say how long a lease lasts, or whether a worker can extend it while a job is still running.
- The spec does not say whether the claim enforces the per-shop cap itself, or whether something else does.
- Not confirmed in the code: whether a claim increases the job's attempt count. The rules only say the reaper must not change it.

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): B-20
- [S49](../capabilities/S49-job-scheduler.md): R-08, R-13, B-09, B-10, B-12
- [job-scheduler-lease](../concepts/job-scheduler-lease.md): C-04
- [fleet-wide-limit](fleet-wide-limit.md)
- [job-cancel-outcome](job-cancel-outcome.md)
- [job-cancel](job-cancel.md)
- [job-due](job-due.md)
- [job-payload-contract](job-payload-contract.md)
- [job-retry-delay](job-retry-delay.md)
- [job-run-at](job-run-at.md)
- [job-status](job-status.md)
- [job-type-registry](job-type-registry.md)
- [job-type](job-type.md)
- [job](job.md)
- [per-shop-running-cap](per-shop-running-cap.md)
- [relay-poller-mode](relay-poller-mode.md)
- [stale-worker](stale-worker.md)
<!-- used-by:end -->
