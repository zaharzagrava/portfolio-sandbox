---
id: transaction-runner
title: Transaction runner
kind: term
status: draft
aliases: [runner]
defined_for: transaction-runner
rules_hash: fb7eb3f26fb6
---
# Transaction runner
## Definition
The transaction runner is the part of the [platform toolkit](platform-toolkit.md) that runs a unit of work as one [database transaction ↗](../sw-external-terms.md#database-transaction). S54 defines it through `run` and the [`@Transactional` decorator](transactional-decorator.md). Each run opens a [transaction scope](transaction-scope.md). Services called inside that scope share the [active transaction](active-transaction.md), so no service needs to receive a transaction object. The scope commits on success and rolls back on any error. afterCommit callbacks run only after the commit. While a transaction is active, safeGet and safeRequest refuse to send.

## Example
S13 writes four rows in one run: the payment, its history row, the charge command and the idempotency record. S53 adds outbox rows to the same transaction with `append` or `appendTask`. If any write fails, none of these rows are kept. The provider call and the publish happen outside the transaction.

## Known gaps
- The spec does not say how `run` and the `@Transactional` decorator differ, or when to use each one.
- The spec does not say what happens when an afterCommit callback throws.
- The spec does not say how S01, S02, S03, S05, S10 and S49 use the runner, even though they list it.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): R-06
- [S28](../capabilities/S28-notifications.md): R-55
- [active-transaction](active-transaction.md)
- [outbox-append-task](outbox-append-task.md)
- [platform-toolkit](platform-toolkit.md)
- [transaction-scope](transaction-scope.md)
- [transactional-decorator](transactional-decorator.md)
<!-- used-by:end -->
