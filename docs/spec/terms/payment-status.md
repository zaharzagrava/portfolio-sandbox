---
id: payment-status
title: Payment status
kind: term
status: draft
aliases: [cancelled, completed, pending, unknown]
defined_for: payment-lifecycle
rules_hash: a92fad1a24a7
---
# Payment status
## Definition
The payment status is the current state of a payment in its lifecycle. Statuses named in the rules include `PENDING`, `UNKNOWN`, `COMPLETED` and `CANCELLED`. Every status change is one [guarded update](guarded-update.md) and writes one record of that change. Once a payment reaches a final status, its status never changes again. Other parts of the platform react to status changes through events sent via the [outbox](inbox-table.md).

## Example
A payment is `PENDING` and its [provider charge](provider-charge-metadata.md) times out, so it becomes `UNKNOWN`. A later [provider lookup](provider-lookup.md) finds the charge and moves the payment to `COMPLETED`, which is terminal.

## Known gaps
- The spec does not give the full list of payment statuses or say which ones are terminal.
- The spec does not say how a payment that is still `PENDING` after a lookup is resolved later.
- The spec does not say how payment statuses map to the W03 pay step phases.

## Used by
<!-- used-by:start -->
- [S10](../capabilities/S10-cart-checkout.md): R-27
- [S13](../capabilities/S13-payment-intents.md): B-17, B-19
- [W03](../capabilities/W03-cart-checkout-orders.md): B-17
- [payment-lifecycle](../concepts/payment-lifecycle.md): C-07
- [guarded-update](guarded-update.md)
- [inbox-table](inbox-table.md)
- [payment-status-history](payment-status-history.md)
- [provider-charge-metadata](provider-charge-metadata.md)
- [provider-lookup](provider-lookup.md)
- [terminal-payment-status](terminal-payment-status.md)
<!-- used-by:end -->
