---
id: job-retries
title: Job retries
kind: term
status: draft
aliases: [retry]
defined_for: idempotency-key
rules_hash: 5379fe22004a
---
# Job retries
## Definition
Job retries are how the distributed system that runs background jobs runs a job again after a run fails. That capability's title names retries, but the spec gives no rule for how they work. In general, such a system retries a failed job a limited number of times and waits longer between tries. Retries are separate from the [idempotency key](idempotency-key.md): the key stops a second job from being created, and a retry runs the same job again. Design intent (not stated in the spec): the point of retries is to keep a short outage from losing work.

## Example
A job is [enqueued](job-enqueue.md) and gets [`created: true`](enqueue-created-flag.md). Its first run fails because a downstream call times out. S49 later runs that same job again. The timing and the number of tries here are illustrative, because the spec does not define them.

## Known gaps
- The spec does not say how many times a job is retried or how long S49 waits between tries.
- The spec does not say what happens to a job after its last failed try, for example whether it is dropped, marked failed or moved to a separate queue.
- Not confirmed in the code: whether a retry keeps the original [job id](job-attempt.md) or creates a new run record.

## Used by
<!-- used-by:start -->
- [J02](../capabilities/J02-seller-to-first-sale.md): B-17
- [S10](../capabilities/S10-cart-checkout.md): R-18, R-23
- [S49](../capabilities/S49-job-scheduler.md): R-12, B-05, B-06
- [order-reservation](../concepts/order-reservation.md): C-05
- [idempotency-key](idempotency-key.md)
- [inbox-table](inbox-table.md)
- [job-attempt](job-attempt.md)
- [job-enqueue](job-enqueue.md)
- [job-heartbeat](job-heartbeat.md)
- [job-max-attempts](job-max-attempts.md)
- [job-max-runtime](job-max-runtime.md)
- [job-status](job-status.md)
- [non-retryable-job-error](non-retryable-job-error.md)
- [payments-reconcile-daily-job](payments-reconcile-daily-job.md)
- [per-aggregate-ordering](per-aggregate-ordering.md)
- [search-backfill-shop-state](search-backfill-shop-state.md)
- [search-retire-previous-index](search-retire-previous-index.md)
- [shop-webhook](shop-webhook.md)
- [stock-release](stock-release.md)
- [stripe-statement-adapter](stripe-statement-adapter.md)
<!-- used-by:end -->
