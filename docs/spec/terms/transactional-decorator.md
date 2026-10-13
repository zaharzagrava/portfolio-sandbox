---
id: transactional-decorator
title: @Transactional decorator
kind: term
status: draft
aliases: [@transactional]
defined_for: transaction-runner
rules_hash: 407404e7c973
---
# @Transactional decorator
## Definition
The `@Transactional` decorator is one of the two ways S54 provides to run code in a transaction, and the other is `run`. Code under the decorator runs inside a [transaction scope](transaction-scope.md), and services it calls share the [active transaction](active-transaction.md) without receiving a transaction object. The scope commits on success, rolls back on any error, and rethrows the error unchanged. [afterCommit callbacks](after-commit-callback.md) run only after the commit. While the transaction is active, [safeGet and safeRequest](safe-http-client.md) refuse to send.

## Example
S13 writes four rows in one transaction: the payment, its history row, the charge command and the idempotency record. If any of these writes fails, none of the rows are kept. The provider call and the publish happen outside the transaction. The spec does not say whether S13 uses `@Transactional` or `run` for this.

## Known gaps
- The spec does not say how `@Transactional` differs from `run`, or when to use each one.
- The spec does not say how to request a [serializable scope](serializable-scope.md), for example whether the decorator takes an option for it.
- The spec does not say what the decorator can be applied to (a method, a class, or both).

## Used by
<!-- used-by:start -->
- [S54](../capabilities/S54-platform-toolkit.md): B-05
- [active-transaction](active-transaction.md)
- [after-commit-callback](after-commit-callback.md)
- [safe-http-client](safe-http-client.md)
- [serializable-scope](serializable-scope.md)
- [transaction-runner](transaction-runner.md)
- [transaction-scope](transaction-scope.md)
<!-- used-by:end -->
