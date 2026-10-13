---
id: outbox-append-task
title: appendTask
kind: term
status: draft
aliases: [append task]
defined_for: transaction-runner
rules_hash: e3b0c44298fc
---
# appendTask
## Definition
`appendTask` is the [outbox](inbox-table.md) call that writes a [task row](task-row.md) inside the caller's active transaction. Its sibling `append` writes [event rows](event-row.md). Because the row shares the caller's transaction, it commits with the caller's other writes or is [rolled back ↗](../sw-external-terms.md#database-transaction) with them. `appendTask` is one of the two allowed ways to write outbox rows inside a transaction. {{cap:S53}} provides it, and [the outbox relay](outbox-relay.md) handles the rows after commit.

## Example
A service runs a [transaction-runner scope](transaction-runner.md). Inside it, the service saves its business rows and calls `appendTask` to record a follow-up task. If a later write in the same scope fails, the scope rolls back. Neither the business rows nor the task row remain.

## Known gaps
- The spec does not say what arguments `appendTask` takes or what a task row contains, beyond being a task row in the outbox.
- The spec does not say what `appendTask` does when no transaction is active. Raising NoActiveTransactionError is plausible but not confirmed in the code. `appendStandalone` is the call documented for writing without a transaction.
- The spec does not say how a task row differs from an event row once the relay processes it.

## Used by
<!-- used-by:start -->
- [event-row](event-row.md)
- [inbox-table](inbox-table.md)
- [outbox-relay](outbox-relay.md)
- [task-row](task-row.md)
- [transaction-runner](transaction-runner.md)
<!-- used-by:end -->
