---
id: ledger-verify-invariants
title: ledger.verify-invariants job
kind: term
status: draft
aliases: [ledger.verify-invariants]
defined_for: S14-ledger-reconciliation
rules_hash: e3b0c44298fc
---
# ledger.verify-invariants job
## Definition
`ledger.verify-invariants` is one of the ledger's background jobs. It is registered in [`LedgerJobs`](ledger-jobs.md) and run by the [job scheduler](scheduler-leader.md), like the other ledger jobs. Its name suggests it checks the stored ledger against the [ledger invariants](ledger-invariants.md), but the spec doesn't say what it checks. Do not confuse it with the checks done during posting. The [ledger store](ledger-store.md) and the posting code enforce the invariants on every write, so this job is not what keeps a bad [journal](ledger-journal.md) out of the ledger.

## Example
The ledger's job list in `packages/backend/libs/domains/payments/infra/ledger.jobs.ts#LedgerJobs` names it next to the other jobs:
```
payments.reconcile-daily, ledger.sweep-hot-accounts, ledger.verify-invariants,
ledger.ensure-partitions, ledger.backfill-balances, ledger.settle-order
```

## Known gaps
- The spec does not say what `ledger.verify-invariants` checks. For example, it doesn't say whether it compares [running balances](running-balance.md) with the sum of entries, or confirms that every journal sums to zero.
- The spec does not say how the job is started: on a schedule (and how often) or only on demand.
- The spec does not say what happens when the job finds a violation, such as a metric, an alert, an issue for operators or a failed job attempt.

## Used by
<!-- used-by:start -->
- [ledger-invariants](ledger-invariants.md)
- [ledger-journal](ledger-journal.md)
- [ledger-store](ledger-store.md)
- [running-balance](running-balance.md)
- [scheduler-leader](scheduler-leader.md)
<!-- used-by:end -->
