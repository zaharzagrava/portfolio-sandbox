---
id: catch-all-partition
title: Catch-all partition
kind: term
status: draft
aliases: [catch-all]
defined_for: S14-ledger-reconciliation
rules_hash: 2b4bd63659af
---
# Catch-all partition
## Definition
[Ledger entries](ledger-posting.md) are stored in one [table partition ↗](../sw-external-terms.md#table-partitioning) per month. The catch-all partition is the fallback that takes an entry whose month has no partition yet. The [posting](ledger-posting.md) still succeeds, so a missing partition never blocks money movement. Instead, the store raises an alert, and maintenance later moves the rows into the correct monthly partition without changing any total. Normally it stays empty, because the [idempotent ↗](../sw-external-terms.md#idempotency) [`ledger.ensure-partitions`](ledger-ensure-partitions.md) job creates monthly partitions ahead of time.

## Example
Suppose `ledger.ensure-partitions` has not run, and a [`SALE` journal](journal-kind.md) is posted in a month with no partition (illustrative). Its entries land in the catch-all partition and an alert fires. Maintenance then moves them into that month's partition, and every balance stays the same.

## Known gaps
- The spec does not say how maintenance empties the catch-all partition when the [append-only rule ↗](../sw-external-terms.md#append-only) rejects `UPDATE` and `DELETE` on every partition.
- The spec does not name the alert or the maintenance job that empties the partition.
- Not confirmed in the code: whether the catch-all is a [database default partition ↗](../sw-external-terms.md#table-partitioning) or something the application manages.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): R-41, B-15
- [journal-kind](journal-kind.md)
- [ledger-posting](ledger-posting.md)
- [uncovered-month](uncovered-month.md)
<!-- used-by:end -->
