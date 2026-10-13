---
id: terminal-payment-status
title: Terminal payment status
kind: term
status: draft
aliases: [terminal]
defined_for: payment-lifecycle
rules_hash: 36d151d9fc8c
---
# Terminal payment status
## Definition
A terminal [payment status](payment-status.md) is a final payment status. Once a payment reaches one, the payment never changes status again. Every payment ends in a terminal status. Each status change is a [guarded update](guarded-update.md) on status and [version](aggregate-version.md), so a change aimed at a payment that already has a terminal status is not applied. Design intent (not stated in the spec): finished payments stay final, so a late [provider](payment-provider.md) result or a [redelivered command](payment-command.md) cannot reopen them or lead to a second charge.

## Example
The [processor](payment-processor.md) re-checks the order before calling the provider and finds it is no longer `[RESERVED](reservation-status.md)`. The payment becomes `CANCELLED`, and the provider is called 0 times. If `CANCELLED` is terminal, a redelivered command for that payment cannot move it back to `PENDING`. The spec does not list which statuses are terminal, so this assumption is illustrative.

## Known gaps
- The spec does not say which payment statuses are terminal. `UNKNOWN` can still change through a [lookup](provider-lookup.md), so it does not look terminal, but no full list is given.
- The spec does not say how a [refund](refund.md) of a `COMPLETED` payment is recorded. If `COMPLETED` is terminal, the refund cannot be a later status of the same payment.
- The spec does not say what the caller gets when it tries to change a payment with a terminal status. It could be a silent [no-op ↗](../sw-external-terms.md#no-op), an error or a logged conflict.

## Used by
<!-- used-by:start -->
- [S10](../capabilities/S10-cart-checkout.md): R-30
- [S13](../capabilities/S13-payment-intents.md): R-20
- [aggregate-version](aggregate-version.md)
- [decide-payment-status](decide-payment-status.md)
- [guarded-update](guarded-update.md)
- [payment-command](payment-command.md)
- [payment-processor](payment-processor.md)
- [payment-provider](payment-provider.md)
- [payment-status](payment-status.md)
- [provider-lookup](provider-lookup.md)
- [refund](refund.md)
<!-- used-by:end -->
