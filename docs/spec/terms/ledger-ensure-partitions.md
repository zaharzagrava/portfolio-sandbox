---
id: ledger-ensure-partitions
title: ledger.ensure-partitions job
kind: term
status: draft
aliases: [ledger.ensure-partitions]
defined_for: S14-ledger-reconciliation
rules_hash: 5916297104ac
---
# ledger.ensure-partitions job
## Definition
`ledger.ensure-partitions` is a scheduled ledger job that maintains the [entry partitions](ledger-entry-partition.md), so that [postings](ledger-posting.md) always have a partition to write into. It is one of the ledger's jobs and runs on the [shared job scheduler](scheduler-leader.md). Creating partitions before they are needed keeps a posting from failing for lack of one. This is design intent (not stated in the spec).

## Example
The job is declared next to `ledger.sweep-hot-accounts` and `ledger.verify-invariants` in `packages/backend/libs/domains/payments/infra/ledger.jobs.ts` (`LedgerJobs`). The scheduler runs it like any other job, with a [lease](job-lease.md), [attempts](job-attempt.md) and [heartbeats](job-heartbeat.md).

## Known gaps
- The spec does not say how often the job runs, or how far ahead it creates partitions.
- The spec does not say whether the job ever drops or detaches old partitions. Entries are append-only and a reconciled day's entries never change.
- The spec does not say what a posting does when the job has fallen behind and no partition exists for it.

## Used by
<!-- used-by:start -->
- [job-attempt](job-attempt.md)
- [job-heartbeat](job-heartbeat.md)
- [job-lease](job-lease.md)
- [ledger-entry-partition](ledger-entry-partition.md)
- [ledger-posting](ledger-posting.md)
- [scheduler-leader](scheduler-leader.md)
- [uncovered-month](uncovered-month.md)
<!-- used-by:end -->
