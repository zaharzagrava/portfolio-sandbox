---
id: outbox-rollback
title: Rollback leaves no outbox row
kind: term
status: draft
aliases: [rollback]
defined_for: outbox-task-queue
rules_hash: ccc2f1ad956c
---
# Rollback leaves no outbox row
## Definition
The [outbox row](inbox-table.md) is written in the caller's [transaction ↗](../sw-external-terms.md#database-transaction), so rolling back that transaction also removes the event. The [relay](outbox-relay.md) never sees the row and never publishes it. Other [domains](orders-domain.md) never react to a change that did not commit. This is the "a rolled-back change leaves no event" guarantee of the outbox.

## Example
[S05](../capabilities/S05-products.md) updates a product and [appends](outbox-append.md) its versioned product event in one transaction. A later step in the same transaction fails, and the transaction rolls back. Neither the product change nor the outbox row exists, so S32 never receives an event for that update.

## Used by
<!-- used-by:start -->
- [S53](../capabilities/S53-events-projections.md): R-04
- [outbox-task-queue](../concepts/outbox-task-queue.md)
- [active-transaction](active-transaction.md)
- [event-backbone](event-backbone.md)
- [inbox-table](inbox-table.md)
- [orders-domain](orders-domain.md)
- [outbox-append](outbox-append.md)
- [outbox-relay](outbox-relay.md)
- [shop-created-event](shop-created-event.md)
- [task-row](task-row.md)
<!-- used-by:end -->
