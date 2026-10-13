---
id: append-standalone
title: appendStandalone
kind: term
status: draft
aliases: [append standalone]
defined_for: transaction-runner
rules_hash: ef942e54ba50
---
# appendStandalone
## Definition
`appendStandalone` is the [S53](../capabilities/S53-events-projections.md) write function that needs no [active transaction](active-transaction.md). The other S53 writes, `append` and [`appendTask`](outbox-append-task.md), must run inside the caller's transaction. Because `appendStandalone` does not join the caller's transaction, its row does not commit or roll back together with the caller's other writes. A likely use is code that has no database work of its own to group with the write. That is design intent (not stated in the spec).

## Example
Inside S13's payment scope, the [event row](event-row.md) is written with `append` so that it commits or rolls back with the payment rows. Code that runs outside any [transaction scope](transaction-scope.md) calls `appendStandalone` instead, because it has no caller's transaction to join.

## Known gaps
- The spec does not say what `appendStandalone` writes (an event row, a task row or both), or whether it opens its own transaction.
- The spec does not say how `appendStandalone` fits with transaction-runner.C-08. That rule says [outbox rows](inbox-table.md) must be written in the caller's transaction, through `append` or `appendTask`.
- The spec does not say what `appendStandalone` does when it is called while a transaction is active: whether it joins that transaction, ignores it or refuses.

## Used by
<!-- used-by:start -->
- [S53](../capabilities/S53-events-projections.md): B-03
- [active-transaction](active-transaction.md)
- [event-row](event-row.md)
- [inbox-table](inbox-table.md)
- [transaction-scope](transaction-scope.md)
<!-- used-by:end -->
