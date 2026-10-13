---
id: transaction-scope
title: Transaction scope
kind: term
status: draft
aliases: [scope, serializable scope]
defined_for: transaction-runner
rules_hash: ef5457d856d0
---
# Transaction scope
## Definition
A transaction scope is a unit of work that runs as one database transaction. If the work succeeds, the scope commits. If any error occurs, it [rolls back ↗](../sw-external-terms.md#database-transaction) and rethrows the same error unchanged. Services called inside the scope share its [active transaction](active-transaction.md). A stricter kind of scope also retries conflicts before it gives up.

## Example
[S13](../capabilities/S13-payment-intents.md) opens one scope to write the payment, its history row, the charge command and the idempotency record. If writing the idempotency record fails, the scope rolls back. None of the four rows remain, and the caller sees the original error. The scope makes no provider call and no publish.

## Known gaps
- The spec does not say how `run` and the `@Transactional` decorator differ, or when to use each.
- The spec does not say how code asks for a serializable scope instead of a normal one.

## Used by
<!-- used-by:start -->
- [S54](../capabilities/S54-platform-toolkit.md): R-14
- [transaction-runner](../concepts/transaction-runner.md): C-01, C-04
- [active-transaction](active-transaction.md)
- [after-commit-callback](after-commit-callback.md)
- [append-standalone](append-standalone.md)
- [event-row](event-row.md)
- [safe-http-client](safe-http-client.md)
- [serializable-scope](serializable-scope.md)
- [shop-cell-moved-event](shop-cell-moved-event.md)
- [task-row](task-row.md)
- [transaction-runner](transaction-runner.md)
- [transaction-timeouts](transaction-timeouts.md)
- [transactional-decorator](transactional-decorator.md)
<!-- used-by:end -->
