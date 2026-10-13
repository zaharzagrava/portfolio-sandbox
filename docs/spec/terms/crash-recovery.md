---
id: crash-recovery
title: crash_recovery
kind: term
status: draft
aliases: []
defined_for: S13-payment-intents
rules_hash: 243bc24370f4
---
# crash_recovery
## Definition
`crash_recovery` is the reason stored when the [processor](payment-processor.md) gets a charge command and finds a [charge attempt](checkout-attempt.md) already recorded but no result saved. This usually means an earlier run crashed after sending the charge. The provider may or may not have charged, so the processor does not send the charge again. It marks the payment [`UNKNOWN(crash_recovery)`](unknown-payment-outcome.md) instead. The [periodic sweep](unknown-payment-resolution.md) then settles the payment through a [provider lookup by our reference](provider-lookup.md).

## Example
The processor records an attempt for a payment, sends the charge, and crashes before saving the answer. [`payments-charge`](payment-command.md) delivers the command again. The processor sees the open attempt and sets the payment to `UNKNOWN(crash_recovery)` without calling the provider (S13.R-16). Later, the lookup by the order ID returns `COMPLETED`, `FAILED` or `PENDING`.

## Known gaps
- Not confirmed in the code: where the "attempt recorded" mark is stored, or whether it is written before the provider call in its own committed step.

## Used by
<!-- used-by:start -->
- [S13](../capabilities/S13-payment-intents.md): R-30
- [checkout-attempt](checkout-attempt.md)
- [merge-cycle](merge-cycle.md)
- [payment-processor](payment-processor.md)
- [provider-lookup](provider-lookup.md)
- [reconciliation-run](reconciliation-run.md)
- [unknown-payment-resolution](unknown-payment-resolution.md)
<!-- used-by:end -->
