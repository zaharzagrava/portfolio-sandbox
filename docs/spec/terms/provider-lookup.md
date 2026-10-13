---
id: provider-lookup
title: Provider lookup by reference
kind: term
status: draft
aliases: [lookup, our reference]
defined_for: payment-lifecycle
rules_hash: 0b0088ebab91
---
# Provider lookup by reference
## Definition
A provider lookup asks the [payment provider](payment-provider.md) for a charge using the platform's own reference instead of the provider's ID. It is the only way to settle an [`UNKNOWN` payment](unknown-payment-outcome.md). If the provider cannot be reached, or still has no record of the charge once the time allowed after the attempt has run out, the payment stays `UNKNOWN`. A lookup never sends a new charge.

## Example
A charge timed out, so the payment is `UNKNOWN`. A lookup by our reference returns a successful charge whose amount, currency and [`orderId`](provider-charge-metadata.md) all match, so the payment moves to [`COMPLETED`](payment-status.md).

## Known gaps
- The spec does not say what "our reference" is, for example the payment ID or the idempotency key.
- The spec does not say how often lookups run, or what happens to a payment that is still `UNKNOWN` after the window ends.
- The spec does not say how a lookup that returns `PENDING` is followed up.

## Used by
<!-- used-by:start -->
- [S10](../capabilities/S10-cart-checkout.md): B-18
- [S13](../capabilities/S13-payment-intents.md): R-17, B-19
- [payment-lifecycle](../concepts/payment-lifecycle.md): C-06
- [crash-recovery](crash-recovery.md)
- [payment-provider](payment-provider.md)
- [payment-status](payment-status.md)
- [provider-idempotency-reference](provider-idempotency-reference.md)
- [provider-lookup-window](provider-lookup-window.md)
- [provider-operation](provider-operation.md)
- [terminal-payment-status](terminal-payment-status.md)
- [unknown-payment-outcome](unknown-payment-outcome.md)
- [unknown-payment-resolution](unknown-payment-resolution.md)
<!-- used-by:end -->
