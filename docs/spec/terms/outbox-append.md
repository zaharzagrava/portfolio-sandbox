---
id: outbox-append
title: Outbox append
kind: term
status: draft
aliases: [append, outbox.append]
defined_for: outbox-task-queue
rules_hash: 1b47e5585f27
---
# Outbox append
## Definition
`append` is the call a domain uses to write an event into the [outbox](inbox-table.md). It is one of the exported services of [S53](../capabilities/S53-events-projections.md), and domain code may not reach the outbox table any other way. The event row is written inside the caller's database transaction, so it commits or rolls back together with the state change that caused it. If no transaction is active, `append` rejects with `[NoActiveTransactionError](no-active-transaction-error.md)`. The [outbox relay](outbox-relay.md) later picks up the committed row and publishes it to Kafka.

## Example
[S13](../capabilities/S13-payment-intents.md) changes a payment's status and appends the matching event in the same transaction (S13.R-22). If that transaction rolls back, no outbox row is left behind.
```ts
// illustrative names: inside S13's transaction
await tx.update(payment, { status: 'SUCCEEDED' });
await outbox.append(paymentSucceededEvent); // commits with the status change
```

## Known gaps
- The spec does not say how `append` finds the caller's transaction. It could read it from the request context or take it as an argument.
- The spec does not say whether `append` itself runs the schema check and the size check that raises `[EventTooLargeError](event-too-large-error.md)`, or whether another step does.
- The spec does not say what `append` returns, for example whether it gives back the assigned `eventId`.

## Used by
<!-- used-by:start -->
- [S04](../capabilities/S04-kyc-onboarding.md): R-27, B-15
- [S05](../capabilities/S05-products.md): R-20
- [S14](../capabilities/S14-ledger-reconciliation.md): R-37
- [S53](../capabilities/S53-events-projections.md): R-01, B-01
- [billing-invoice-payment-failed-event](billing-invoice-payment-failed-event.md)
- [catalog-product-deleted-event](catalog-product-deleted-event.md)
- [catalog-product-events](catalog-product-events.md)
- [catalog-product-updated-event](catalog-product-updated-event.md)
- [client-secret](client-secret.md)
- [domain](domain.md)
- [event-backbone](event-backbone.md)
- [extraction-message](extraction-message.md)
- [fact](fact.md)
- [inbox-table](inbox-table.md)
- [ledger-reconciliation-completed-event](ledger-reconciliation-completed-event.md)
- [order-unavailable](order-unavailable.md)
- [outbox-relay](outbox-relay.md)
- [outbox-rollback](outbox-rollback.md)
- [password-changed-event](password-changed-event.md)
- [payment-succeeded-event](payment-succeeded-event.md)
- [product-lifecycle](product-lifecycle.md)
- [security-events](security-events.md)
- [shop-cell-moved-event](shop-cell-moved-event.md)
- [task-already-resolved](task-already-resolved.md)
- [unregistered-aggregate-type-error](unregistered-aggregate-type-error.md)
<!-- used-by:end -->
