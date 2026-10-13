---
id: ledger-entry-partition
title: Ledger entry partition
kind: term
status: draft
aliases: [entry partitions, partitions]
defined_for: S14-ledger-reconciliation
rules_hash: 04c9994673a9
---
# Ledger entry partition
## Definition
A ledger entry partition is one physical piece of the [partitioned table ↗](../sw-external-terms.md#table-partitioning) that holds [journal lines](ledger-posting.md) (entries). Together, the partitions form the logical entry table that [postings](ledger-posting.md) append to. Each partition is [append-only ↗](../sw-external-terms.md#append-only): the ledger store rejects `UPDATE` and `DELETE` on every one of them, as it does on the header table. To correct a stored entry, you post a new [reversing journal](reversing-journal.md). Splitting the table into partitions keeps a table that only ever grows manageable. This is design intent (not stated in the spec).

## Example
Suppose an operator runs `UPDATE` to fix the amount of an entry from yesterday's `SALE` on whichever partition holds that entry. The store rejects the statement. The fix is a reversing journal (for example an [`ADJUSTMENT`](adjustment-journal.md)) posted in the current period.

## Known gaps
- The spec does not name the partitioning key or the partition granularity, for example by `postedAt` month.
- The spec does not say what happens when an entry is written and no partition exists for it.

## Used by
<!-- used-by:start -->
- [ledger-ensure-partitions](ledger-ensure-partitions.md)
- [ledger-jobs](ledger-jobs.md)
- [ledger-posting](ledger-posting.md)
- [ledger-store](ledger-store.md)
- [reversing-journal](reversing-journal.md)
- [uncovered-month](uncovered-month.md)
<!-- used-by:end -->
