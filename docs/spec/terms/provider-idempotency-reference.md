---
id: provider-idempotency-reference
title: Provider idempotency reference
kind: term
status: draft
aliases: [idempotency reference]
defined_for: S13-payment-intents
rules_hash: de97590e0aad
---
# Provider idempotency reference
## Definition
The provider idempotency reference is the value the platform sends with each operation to the [payment provider](payment-provider.md), so that the provider treats a repeated request as the same operation. Each operation has a fixed reference format. A [charge](payment-intent.md) uses the order ID, a [refund](refund.md) uses `refund:<paymentId>`, and a [cancel](payment-cancel.md) uses `cancel:<paymentId>`. Because the charge reference is the order ID, a [redelivered or retried charge command](payment-command.md) maps to the same provider charge and cannot create a second one. The [provider lookup](provider-lookup.md) uses this same reference to settle [`UNKNOWN`](unknown-payment-outcome.md) payments.

Why each format is built this way (design intent, not stated in the spec): the charge uses the order ID because there is one payment per order. The prefixes keep a refund and a cancel separate from the charge, and from each other.

## Example
For order `ord_42` and payment `pay_7` (illustrative), the references are `ord_42` for the charge, `refund:pay_7` for the refund and `cancel:pay_7` for the cancel.

## Known gaps
- The spec does not say which provider field or header carries the reference.
- Not confirmed in the code: where the reference is built. The spec gives no `[code]` link for this rule.

## Used by
<!-- used-by:start -->
- [S13](../capabilities/S13-payment-intents.md): R-11
- [classify-charge](classify-charge.md)
- [orders-refund-requested-event](orders-refund-requested-event.md)
- [payment-cancel](payment-cancel.md)
- [payment-command](payment-command.md)
- [payment-intent](payment-intent.md)
- [payment-provider](payment-provider.md)
- [provider-lookup](provider-lookup.md)
- [provider-operation](provider-operation.md)
- [refund](refund.md)
- [requires-action](requires-action.md)
<!-- used-by:end -->
