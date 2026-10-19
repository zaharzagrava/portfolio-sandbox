---
id: guarded-update
title: Guarded update
kind: term
status: draft
aliases: []
defined_for: payment-lifecycle
rules_hash: 7e6c67bc34ce
---
# Guarded update
## Definition
A guarded update is how every payment status change is written. It is a single update that only succeeds if the payment still has the status and [version](aggregate-version.md) the writer last read. The same [transaction ↗](../sw-external-terms.md#database-transaction) writes one record of the status change and appends any event to the [outbox](inbox-table.md). If another writer changed the payment first, the update matches no row and does nothing. This is also how final statuses, which must never change, are protected from being changed again.

## Example
The processor reads a payment as `UNKNOWN` at version 3 and tries to write `COMPLETED` at version 4. A lookup has already completed it, so the version is now 4 and the processor's update changes nothing. (Versions are illustrative.)

## Known gaps
- Not confirmed in the code: whether payments use the shared [versionGuard](version-guard.md) helper or their own conditional update.
- The spec does not say what a writer should do after its guarded update loses, for example re-read the payment, log it, or raise an error.

## Used by
<!-- used-by:start -->
- [S10](../capabilities/S10-cart-checkout.md): R-31, R-33
- [S13](../capabilities/S13-payment-intents.md): R-20, B-12
- [payment-lifecycle](../concepts/payment-lifecycle.md): C-07
- [aggregate-version](aggregate-version.md)
- [best-effort-push](best-effort-push.md)
- [charge-outcome](charge-outcome.md)
- [decide-payment-status](decide-payment-status.md)
- [inbox-table](inbox-table.md)
- [last-owner](last-owner.md)
- [moderation-task-status](moderation-task-status.md)
- [onboarding-verify-pending-job](onboarding-verify-pending-job.md)
- [optimistic-concurrency](optimistic-concurrency.md)
- [order-command](order-command.md)
- [order-version](order-version.md)
- [payment-event-outcome](payment-event-outcome.md)
- [payment-status-history](payment-status-history.md)
- [payment-status](payment-status.md)
- [payment-succeeded-event](payment-succeeded-event.md)
- [payments-events-consumer](payments-events-consumer.md)
- [payments-events-topic](payments-events-topic.md)
- [post-webhooks-stripe](post-webhooks-stripe.md)
- [second-factor-service](second-factor-service.md)
- [ship-order](ship-order.md)
- [terminal-payment-status](terminal-payment-status.md)
- [totp-replay-protection](totp-replay-protection.md)
- [unknown-payment-resolution](unknown-payment-resolution.md)
- [version-guard](version-guard.md)
- [webhook-redelivery](webhook-redelivery.md)
<!-- used-by:end -->
