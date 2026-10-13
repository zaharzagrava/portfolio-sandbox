---
id: job-lease
title: Job lease
kind: term
status: draft
aliases: [lease, leases]
defined_for: job-scheduler-lease
rules_hash: 8bbe54f9d010
---
# Job lease
## Definition
A job lease is a worker's time-limited claim on a job, and it is what makes the job [`RUNNING`](job-status.md). Workers take leases with [row-lock skip-locked claims ↗](../sw-external-terms.md#skip-locked-lease), so two workers never claim the same job. Every write that ends or changes one worker's run of the job must name that worker and the run's number, or it is rejected. If a worker's lease has expired, that worker's writes change nothing. A background process takes back jobs whose lease has expired.

## Example
Worker A claims `recommendations.build-bought-together` on attempt 2 (illustrative), but A's lease expires and the reaper re-queues the job. Worker B then claims it on a new attempt. When A later tries to mark the job [`SUCCEEDED`](job-status.md), the fence does not match, so nothing changes.

## Known gaps
- The spec does not say how long a lease lasts or whether workers can extend it while a job runs.
- The spec does not say what a [stale worker](stale-worker.md) sees when its fenced write is rejected, such as an error or a silent no-op.

## Used by
<!-- used-by:start -->
- [S34](../capabilities/S34-recommendations.md): R-21
- [S49](../capabilities/S49-job-scheduler.md): R-09, R-14, B-07, B-08
- [S53](../capabilities/S53-events-projections.md): R-10
- [job-scheduler-lease](../concepts/job-scheduler-lease.md): C-06
- [outbox-task-queue](../concepts/outbox-task-queue.md): C-06
- [attempt-fencing](attempt-fencing.md)
- [autocomplete-build](autocomplete-build.md)
- [autocomplete-worker-module](autocomplete-worker-module.md)
- [build-lock](build-lock.md)
- [fleet-wide-limit](fleet-wide-limit.md)
- [inbox-table](inbox-table.md)
- [job-attempt](job-attempt.md)
- [job-heartbeat](job-heartbeat.md)
- [job-max-attempts](job-max-attempts.md)
- [job-max-runtime](job-max-runtime.md)
- [job-reaper](job-reaper.md)
- [job-retry-delay](job-retry-delay.md)
- [job-status](job-status.md)
- [order-baskets-build](order-baskets-build.md)
- [outbox-relay](outbox-relay.md)
- [scheduler-leader](scheduler-leader.md)
- [search-backfill-shop-state](search-backfill-shop-state.md)
- [search-refresh-popularity](search-refresh-popularity.md)
- [search-retire-previous-index](search-retire-previous-index.md)
- [skipped-locked](skipped-locked.md)
- [stale-worker](stale-worker.md)
- [suggest-builder](suggest-builder.md)
- [suggestion-build](suggestion-build.md)
- [unknown-payment-resolution](unknown-payment-resolution.md)
- [worker-instance](worker-instance.md)
- [zero-downtime-reindexing](zero-downtime-reindexing.md)
<!-- used-by:end -->
