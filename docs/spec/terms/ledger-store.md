---
id: ledger-store
title: Ledger store
kind: term
status: draft
aliases: [store]
defined_for: S14-ledger-reconciliation
rules_hash: 3e10771af613
---
# Ledger store
## Definition
The ledger store is the database layer that holds [journal headers](ledger-journal.md), their entries and the [running balances](running-balance.md). It enforces the ledger's [invariants](ledger-invariants.md) itself, whoever does the writing, so a bug in application code cannot get around them. At commit it refuses any journal whose lines do not sum to zero. It rejects `UPDATE` and `DELETE` on every [entry partition](ledger-entry-partition.md) and on the header table. It also enforces that each [(kind, reference)](journal-kind-reference.md) appears only once.

## Example
A hand-written SQL insert of entries that sum to +10 is refused when the transaction commits. An `UPDATE` that tries to change an existing entry's amount is rejected too. To fix a wrong entry, you post a [reversing journal](reversing-journal.md).

## Known gaps
- The spec does not say how the commit-time balance check is built (for example, a [trigger ↗](../sw-external-terms.md#database-trigger) or a [deferred constraint ↗](../sw-external-terms.md#deferred-constraint)).
- The spec does not name the tables or the [partitioning key ↗](../sw-external-terms.md#table-partitioning). It only says partitions exist and that [`ledger.ensure-partitions`](ledger-ensure-partitions.md) maintains them.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): R-02
- [journal-kind-reference](journal-kind-reference.md)
- [journal-unbalanced](journal-unbalanced.md)
- [ledger-entry-partition](ledger-entry-partition.md)
- [ledger-invariants](ledger-invariants.md)
- [ledger-journal](ledger-journal.md)
- [ledger-verify-invariants](ledger-verify-invariants.md)
- [reversing-journal](reversing-journal.md)
- [running-balance](running-balance.md)
<!-- used-by:end -->
