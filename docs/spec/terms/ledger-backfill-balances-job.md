---
id: ledger-backfill-balances-job
title: ledger.backfill-balances job
kind: term
status: draft
aliases: [ledger.backfill-balances]
defined_for: S14-ledger-reconciliation
rules_hash: 8f239e9c51f9
---
# ledger.backfill-balances job
## Definition
`ledger.backfill-balances` is one of the [job types](job-type.md) registered by the ledger in [`LedgerJobs`](ledger-jobs.md). It runs on the [shared job scheduler](scheduler-tick.md), like the other ledger jobs. The name suggests it fills in balance data that is missing. In this system that could be [running balances](running-balance.md) or the [balance read model](read-model.md). The spec lists the job but never says what it does. Treat any description of its behaviour as unconfirmed until you read the handler.

## Example
The job sits next to the other ledger maintenance jobs in `packages/backend/libs/domains/payments/infra/ledger.jobs.ts#LedgerJobs`:
```
payments.reconcile-daily, ledger.sweep-hot-accounts, ledger.verify-invariants,
ledger.ensure-partitions, ledger.backfill-balances, ledger.settle-order
```

## Known gaps
- The spec does not say what the job backfills or where it reads from. It might write running balance rows from [journal entries](ledger-journal.md), or fill the read model's [durable copy](durable-copy.md) from running balances or from `ledger.journal_posted` v2 events.
- The spec does not say whether the job runs on a schedule or is enqueued by hand, or what its [job payload contract](job-payload-contract.md) is.
- Not confirmed in the code: that this job is how the [rebuildable read model](rebuildable-read-model.md) gets rebuilt. The name suggests it, but no fact links the two.

## Used by
<!-- used-by:start -->
- [balance-projector](balance-projector.md)
- [durable-copy](durable-copy.md)
- [job-payload-contract](job-payload-contract.md)
- [job-type](job-type.md)
- [ledger-jobs](ledger-jobs.md)
- [ledger-journal](ledger-journal.md)
- [read-model](read-model.md)
- [rebuildable-read-model](rebuildable-read-model.md)
- [running-balance](running-balance.md)
- [scheduler-tick](scheduler-tick.md)
<!-- used-by:end -->
