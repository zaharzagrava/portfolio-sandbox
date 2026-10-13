---
id: ledger-jobs
title: LedgerJobs
kind: term
status: draft
aliases: [ledger.jobs.ts]
defined_for: S14-ledger-reconciliation
rules_hash: e3b0c44298fc
---
# LedgerJobs
## Definition
`LedgerJobs` is the [infra-layer](infrastructure-layer.md) class in the payments domain that declares the ledger's background job types. Each job runs on the [shared job scheduler](job.md), which handles [leases](job-lease.md), retries and [heartbeats](job-heartbeat.md). The job types cover daily reconciliation, the [hot-account shard sweep](shard-sweep.md), [invariant checks](ledger-invariants.md), [entry-partition upkeep](ledger-entry-partition.md), [balance backfill](ledger-backfill-balances-job.md) and [order settlement](order-settlement.md). Note that the reconciliation job is named [`payments.reconcile-daily`](payments-reconcile-daily-job.md), while the others use the `ledger.` prefix.

## Example
All six job types are declared in `packages/backend/libs/domains/payments/infra/ledger.jobs.ts#LedgerJobs`:
```
payments.reconcile-daily, ledger.sweep-hot-accounts, ledger.verify-invariants,
ledger.ensure-partitions, ledger.backfill-balances, ledger.settle-order
```
For example, `payments.reconcile-daily` runs the reconciliation for the previous [closed UTC day](closed-utc-day.md). If the provider fails, the job layer makes [at most 3 attempts](job-max-attempts.md).

## Known gaps
- The spec does not say which of these jobs are recurring schedules and which are enqueued on demand. It also does not give their [payload contracts](job-payload-contract.md). The only timings it states are the hourly sweep and the daily reconciliation.
- The spec does not say what `ledger.verify-invariants`, `ledger.ensure-partitions` and `ledger.backfill-balances` actually do. Their names are the only hint.
- Not confirmed in the code: that `ledger.settle-order` is how the [settlement consumer](settlement-consumer.md) schedules its deferred attempts when the sale is not there yet. Also unconfirmed: which module registers `LedgerJobs`.

## Used by
<!-- used-by:start -->
- [closed-utc-day](closed-utc-day.md)
- [infrastructure-layer](infrastructure-layer.md)
- [job-heartbeat](job-heartbeat.md)
- [job-lease](job-lease.md)
- [job-max-attempts](job-max-attempts.md)
- [job-payload-contract](job-payload-contract.md)
- [job](job.md)
- [ledger-backfill-balances-job](ledger-backfill-balances-job.md)
- [ledger-entry-partition](ledger-entry-partition.md)
- [ledger-invariants](ledger-invariants.md)
- [order-settlement](order-settlement.md)
- [settlement-consumer](settlement-consumer.md)
- [shard-sweep](shard-sweep.md)
<!-- used-by:end -->
