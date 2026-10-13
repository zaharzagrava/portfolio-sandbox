---
id: provider-charge-metadata
title: Provider charge metadata
kind: term
status: draft
aliases: [orderid metadata]
defined_for: payment-lifecycle
rules_hash: d3edfca52332
---
# Provider charge metadata
## Definition
Provider charge metadata is data the platform attaches to a charge at the payment [provider](payment-provider.md), including the `orderId`. When the provider reports success, the platform compares the amount, currency, status and `orderId` metadata with its own payment. If any of them differs, the payment is not [completed](payment-status.md) and becomes [`UNKNOWN`](unknown-payment-outcome.md). Design intent (not stated in the spec): this stops a success that belongs to another order, or to a different amount, from being [counted as paid](paid-mark.md).

## Example
The provider reports success for a charge whose `orderId` metadata is `ord_999`, but our payment is for `ord_123`. The payment becomes `UNKNOWN` and is not completed. (IDs are illustrative.)

## Known gaps
- The spec does not say which metadata fields besides `orderId` are sent to the provider, or what they are called on the provider's side.
- The spec does not say what "status does not match" means for each provider status.

## Used by
<!-- used-by:start -->
- [S13](../capabilities/S13-payment-intents.md): R-13
- [payment-lifecycle](../concepts/payment-lifecycle.md): C-05
- [find-mismatch](find-mismatch.md)
- [order-id](order-id.md)
- [paid-mark](paid-mark.md)
- [payment-provider](payment-provider.md)
- [payment-status](payment-status.md)
<!-- used-by:end -->
