---
id: job
title: Job (scheduler job)
kind: term
status: draft
aliases: [jobs]
defined_for: S49-job-scheduler
rules_hash: e785aaef9218
---
# Job (scheduler job)
## Definition
A job is one unit of background work stored in the job tables. Other capabilities create it through [enqueue](job-enqueue.md), and a worker later [claims](job-claim.md) it and runs its handler. Each job has a [job type](job-type.md), a payload, a `runAt` time, an attempt count and [exactly one job status](job-status.md). A job may carry a `shopId`. This is a plain identifier, and [the per-shop cap](per-shop-running-cap.md) uses it.

## Example
A capability calls `JobsService.enqueue(type, payload, { idempotencyKey: 'K' })` inside its transaction and receives `{ id, created: true }`. The job starts as `QUEUED` with `attempts = 0`. After a successful run it ends as `SUCCEEDED` with `attempts = 1`.

## Known gaps
- The spec does not say which columns a job row has beyond status, `runAt`, attempts, `shopId`, the lease and `lastError`. No model file exists for this capability.
- Not confirmed in the code: the code facts do not list the enqueue, claim or reaper files. Only the migration `packages/backend/migrations/20261001110000-create-jobs.js` is named.

## Used by
<!-- used-by:start -->
- [S49](../capabilities/S49-job-scheduler.md): R-01
- [job-claim](job-claim.md)
- [job-enqueue](job-enqueue.md)
- [job-status](job-status.md)
- [job-type](job-type.md)
- [outbox-purge-job](outbox-purge-job.md)
- [per-shop-running-cap](per-shop-running-cap.md)
<!-- used-by:end -->
