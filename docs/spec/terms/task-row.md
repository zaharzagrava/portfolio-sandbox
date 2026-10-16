---
id: task-row
title: Task row (outbox)
kind: term
status: draft
aliases: [task rows]
defined_for: transaction-runner
rules_hash: d5ed6215c3d4
---
# Task row (outbox)
## Definition
A task row is an [outbox row](event-row.md) that records work to be done later, instead of a domain event. Code writes it with [`appendTask`](outbox-append-task.md), inside the caller's [active transaction](active-transaction.md). The task row commits together with the caller's other writes. If the scope [rolls back](outbox-rollback.md), the task row is discarded with them. {{cap:S53}} owns task rows, and they are stored next to event rows in the outbox.

## Example
Inside one [transaction-runner scope](transaction-scope.md), a service saves its business rows and calls `appendTask` to queue a follow-up task.
If a later write in the same scope throws, the scope rolls back. Neither the business rows nor the task row remain.

## Known gaps
- The spec does not say which columns a task row has, or what arguments `appendTask` takes.
- The spec does not say what reads task rows after commit or how they are executed. It also does not say whether the outbox relay or a job worker handles them.
- The spec does not say whether `appendStandalone` can write task rows outside a transaction, or only event rows.

## Used by
<!-- used-by:start -->
- [active-transaction](active-transaction.md)
- [event-row](event-row.md)
- [invite-resend](invite-resend.md)
- [outbox-append-task](outbox-append-task.md)
- [outbox-connector-configuration](outbox-connector-configuration.md)
- [outbox-rollback](outbox-rollback.md)
- [payout-failed-event](payout-failed-event.md)
- [payout-paid-event](payout-paid-event.md)
- [source-topic](source-topic.md)
- [transaction-scope](transaction-scope.md)
<!-- used-by:end -->
