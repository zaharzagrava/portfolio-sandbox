---
id: job-enqueue
title: Job enqueue
kind: term
status: draft
aliases: [enqueue, enqueue calls]
defined_for: idempotency-key
rules_hash: 2013e9020631
---
# Job enqueue
## Definition
Job enqueue is the call that adds a job to the shared system that runs background jobs across many machines. It accepts an [idempotency key](idempotency-key.md). If a job already exists for that key, the call creates nothing and returns the original job's id. When many calls arrive at the same moment with one key, exactly one of them creates the job.

## Example
20 workers enqueue the same job at once with the key `nightly-report-2026-10-13` (illustrative). Exactly one reply has `[created: true](enqueue-created-flag.md)`. The other 19 get the same job id with `[created: false](enqueue-created-flag.md)`.

## Known gaps
- The spec does not say whether a key is required on enqueue or optional.
- The spec does not say the endpoint or function name used to enqueue.

## Used by
<!-- used-by:start -->
- [S49](../capabilities/S49-job-scheduler.md): R-02, R-03, B-02
- [idempotency-key](../concepts/idempotency-key.md): C-04, C-05
- [job-scheduler-lease](../concepts/job-scheduler-lease.md): C-02
- [enqueue-created-flag](enqueue-created-flag.md)
- [idempotency-key-conflict-error](idempotency-key-conflict-error.md)
- [idempotency-key](idempotency-key.md)
- [idempotency-purge-job](idempotency-purge-job.md)
- [job-max-attempts](job-max-attempts.md)
- [job-payload-contract](job-payload-contract.md)
- [job-retries](job-retries.md)
- [job-run-at](job-run-at.md)
- [job-status](job-status.md)
- [job-type-registry](job-type-registry.md)
- [job-type](job-type.md)
- [job](job.md)
- [payment-processor](payment-processor.md)
- [post-webhooks-stripe](post-webhooks-stripe.md)
- [scheduler-leader](scheduler-leader.md)
- [scheduler-tick](scheduler-tick.md)
- [search-backfill-shop-state](search-backfill-shop-state.md)
<!-- used-by:end -->
