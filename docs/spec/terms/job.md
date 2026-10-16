---
id: job
title: Job (scheduler job)
kind: term
status: draft
aliases: [jobs]
defined_for: S49-job-scheduler
rules_hash: b1d5886310c3
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
- [S01](../capabilities/S01-auth-sessions.md): R-44, R-45
- [S10](../capabilities/S10-cart-checkout.md): B-17
- [S14](../capabilities/S14-ledger-reconciliation.md): R-34, R-43
- [S49](../capabilities/S49-job-scheduler.md): R-01
- [api-layer](api-layer.md)
- [auth-purge-reset-tokens-job](auth-purge-reset-tokens-job.md)
- [infrastructure-layer](infrastructure-layer.md)
- [invite-purge-job](invite-purge-job.md)
- [job-claim](job-claim.md)
- [job-enqueue](job-enqueue.md)
- [job-status](job-status.md)
- [job-type](job-type.md)
- [ledger-jobs](ledger-jobs.md)
- [ledger-settle-order-job](ledger-settle-order-job.md)
- [notifications-callbacks-queue](notifications-callbacks-queue.md)
- [notifications-reconcile-unread-job](notifications-reconcile-unread-job.md)
- [order-items-backfill](order-items-backfill.md)
- [order-settlement](order-settlement.md)
- [orders-backfill-item-titles-job](orders-backfill-item-titles-job.md)
- [outbox-purge-job](outbox-purge-job.md)
- [payouts-run-weekly-job](payouts-run-weekly-job.md)
- [per-shop-running-cap](per-shop-running-cap.md)
- [products-flush-view-counts-job](products-flush-view-counts-job.md)
- [provider-statement](provider-statement.md)
- [provider-unavailable-failed-run](provider-unavailable-failed-run.md)
- [reset-token-jobs](reset-token-jobs.md)
- [search-backfill-embeddings-job](search-backfill-embeddings-job.md)
- [search-purge-tombstones-job](search-purge-tombstones-job.md)
- [shop-purge-job](shop-purge-job.md)
- [stock-operation-purge](stock-operation-purge.md)
<!-- used-by:end -->
