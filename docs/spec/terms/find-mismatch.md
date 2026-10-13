---
id: find-mismatch
title: findMismatch
kind: term
status: draft
aliases: []
defined_for: S13-payment-intents
rules_hash: e3b0c44298fc
---
# findMismatch
## Definition
`findMismatch` is a function in the [payments domain layer](payments-domain-layer.md) that checks a [provider "success" answer](payment-provider.md) before the [processor](payment-processor.md) trusts it. It compares the amount, currency, status and [`orderId` metadata](provider-charge-metadata.md) in the answer with what the payment expects. If any of them differ, the payment must not become [`COMPLETED`](payment-status.md) and becomes `UNKNOWN` instead (S13.R-13). This means a success that looks wrong, for example one meant for another order, can never complete a payment by mistake.

## Example
The processor sends a charge for order `ord_A` (illustrative ID). The provider answers "succeeded", but the `orderId` metadata says `ord_B` (illustrative). `findMismatch` in `domain/provider-outcome.ts` reports the mismatch, so the payment becomes `UNKNOWN` instead of `COMPLETED` (S13 AS-22).

## Known gaps
- The spec does not say what `findMismatch` returns, or whether the field that differed is saved as the reason on the `UNKNOWN` payment.
- The spec does not say whether the same check runs on successes found during [unknown payment resolution](unknown-payment-resolution.md) or refresh by `getPaymentStatus`, or only on the first charge answer.
- The spec does not say exactly which provider status counts as a match. It says only that a non-matching status must not complete the payment.

## Used by
<!-- used-by:start -->
- [payment-processor](payment-processor.md)
- [payment-provider](payment-provider.md)
- [payments-domain-layer](payments-domain-layer.md)
- [provider-charge-metadata](provider-charge-metadata.md)
- [unknown-payment-resolution](unknown-payment-resolution.md)
<!-- used-by:end -->
