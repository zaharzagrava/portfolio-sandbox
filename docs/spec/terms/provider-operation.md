---
id: provider-operation
title: Provider operation
kind: term
status: draft
aliases: [provider operations]
defined_for: S13-payment-intents
rules_hash: b765eb2481c9
---
# Provider operation
## Definition
A provider operation is one kind of call the payments code makes to the [payment provider](payment-provider.md). The facts mention creating a charge, cancelling an intent, refunding, and [looking up a payment by our reference](provider-lookup.md). Each operation has its own [circuit breaker ↗](../sw-external-terms.md#circuit-breaker), so trouble with one kind of call does not block the others. Each of charge, refund and cancel also has its own [provider idempotency reference](provider-idempotency-reference.md).

## Example
Charge calls start failing with `503` and the charge breaker opens (S13.B-13). The refund and cancel breakers are separate and are not opened by those failures. Each operation uses its own reference:
```
charge: <orderId>
refund: refund:<paymentId>
cancel: cancel:<paymentId>
```

## Known gaps
- The spec does not list the full set of provider operations. Whether the status refresh used by `getPaymentStatus` shares the lookup breaker is not stated.
- The spec does not give breaker thresholds for each operation. Only the charge example shows the open and [probe](circuit-breaker-probe.md) behaviour.

## Used by
<!-- used-by:start -->
- [S13](../capabilities/S13-payment-intents.md): R-10, R-12, R-19
- [charge-outcome](charge-outcome.md)
- [circuit-breaker-probe](circuit-breaker-probe.md)
- [payment-provider](payment-provider.md)
- [provider-idempotency-reference](provider-idempotency-reference.md)
- [provider-lookup](provider-lookup.md)
- [provider-raw-answer-kind](provider-raw-answer-kind.md)
<!-- used-by:end -->
