---
id: uncovered-month
title: Uncovered month
kind: term
status: draft
aliases: [uncovered]
defined_for: S14-ledger-reconciliation
rules_hash: fb0c7df52b48
---
# Uncovered month
## Definition
An uncovered month is a month for which the ledger's [entry storage](ledger-entry-partition.md) has no dedicated partition yet. A [journal](ledger-journal.md) posted in such a month is not refused. Its entries go into a [catch-all partition](catch-all-partition.md). Later, [partition maintenance](ledger-ensure-partitions.md) moves those entries into the correct partition without changing any total. Entries stay [append-only ↗](../sw-external-terms.md#append-only) while this happens, so the move does not change any amount.

## Example
The `ledger.ensure-partitions` job has not yet created the partition for a month. A [`SALE` journal](journal-kind.md) posted that month lands in the catch-all partition. When maintenance runs, it moves those entries to the new month partition, and every balance and sum stays the same.

## Known gaps
- Not confirmed in the code: that the maintenance which moves the rows is the `ledger.ensure-partitions` job. The spec only says "maintenance".
- The spec does not say how far ahead monthly partitions are created, so it is unclear how often an uncovered month happens in practice.
- The spec does not say how the move works alongside the store's rejection of `UPDATE` and `DELETE` on every partition.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): B-15
- [catch-all-partition](catch-all-partition.md)
- [journal-kind](journal-kind.md)
- [ledger-ensure-partitions](ledger-ensure-partitions.md)
- [ledger-entry-partition](ledger-entry-partition.md)
- [ledger-journal](ledger-journal.md)
<!-- used-by:end -->
