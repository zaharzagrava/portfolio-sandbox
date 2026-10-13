---
id: active-transaction
title: Active transaction
kind: term
status: draft
aliases: [shared transaction, transaction is active]
defined_for: transaction-runner
rules_hash: b0da890c5a89
---
# Active transaction
## Definition
The active transaction is the [database transaction ↗](../sw-external-terms.md#database-transaction) that the surrounding unit of work currently has open. Services running inside that unit of work use it automatically, without being passed a transaction object. Because of this, a failure in one service leaves no row from another. While it is active, the outbound HTTP client refuses to send. [Outbox rows](inbox-table.md) must be written into it with [`append`](outbox-append.md) or [`appendTask`](outbox-append-task.md).

## Example
Inside [S13](../capabilities/S13-payment-intents.md)'s payment scope, [S53](../capabilities/S53-events-projections.md)'s `append` writes an event row into the same active transaction. If a later write in the scope fails, the payment rows and the outbox row are all [rolled back](outbox-rollback.md). [`appendStandalone`](append-standalone.md) is the only S53 write that needs no active transaction.

## Known gaps
- The spec does not say how services find the active transaction (for example, through the request context).
- The spec does not say what happens when a scope is started while another one is already active (nesting).

## Used by
<!-- used-by:start -->
- [S49](../capabilities/S49-job-scheduler.md): R-02, B-02
- [S54](../capabilities/S54-platform-toolkit.md): R-17, B-05
- [transaction-runner](../concepts/transaction-runner.md): C-03
- [append-standalone](append-standalone.md)
- [event-row](event-row.md)
- [idempotency-key-conflict-error](idempotency-key-conflict-error.md)
- [inbox-table](inbox-table.md)
- [outbox-rollback](outbox-rollback.md)
- [post-shops](post-shops.md)
- [safe-http-client](safe-http-client.md)
- [task-row](task-row.md)
- [tenancy-tables](tenancy-tables.md)
- [transaction-runner](transaction-runner.md)
- [transaction-scope](transaction-scope.md)
- [transactional-decorator](transactional-decorator.md)
<!-- used-by:end -->
