---
id: payment-succeeded-event
title: payment_succeeded event
kind: term
status: draft
aliases: [payment_succeeded]
defined_for: S13-payment-intents
rules_hash: fbbc732136ac
---
# payment_succeeded event
## Definition
`payments.payment_succeeded` is the event the [payments capability](capability.md) emits when a payment reaches [`COMPLETED`](payment-status.md). It tells other parts of the platform, mainly the order system, that the order has been paid. Like every payments event, it is [appended to the outbox](outbox-append.md) in the same transaction as the status change and [published after commit](after-commit-callback.md). It is never published directly. A payment that completes through [unknown payment resolution](unknown-payment-resolution.md) goes through the same [guarded step](guarded-update.md), so it emits this event too.

## Example
The provider answers "succeeded" for a charge. In one transaction, the payment becomes `COMPLETED`, a [history row](payment-status-history.md) is written, a [ledger posting](ledger-posting.md) is written, and one `payments.payment_succeeded` event row is added to the outbox. The [relay](outbox-relay.md) publishes the event after commit.

## Known gaps
- The spec does not say what the event payload contains.
- The spec does not name the consumers of this event or say what they do with it.

## Used by
<!-- used-by:start -->
- [S13](../capabilities/S13-payment-intents.md): B-08
- [after-commit-callback](after-commit-callback.md)
- [capability](capability.md)
- [guarded-update](guarded-update.md)
- [ledger-posting](ledger-posting.md)
- [order-not-cancellable](order-not-cancellable.md)
- [outbox-append](outbox-append.md)
- [outbox-relay](outbox-relay.md)
- [payment-status-history](payment-status-history.md)
- [unknown-payment-resolution](unknown-payment-resolution.md)
<!-- used-by:end -->
