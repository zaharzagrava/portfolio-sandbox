---
id: classify-charge
title: classifyCharge
kind: term
status: draft
aliases: []
defined_for: S13-payment-intents
rules_hash: 53e404798755
---
# classifyCharge
## Definition
`classifyCharge` is the function that turns the payment provider's answer to a charge into an outcome the payment can act on. It sits in the [payments domain layer](payments-domain-layer.md), in `packages/backend/libs/domains/payments/domain/provider-outcome.ts`. A [definite decline](definite-decline.md) maps to [`FAILED`](payment-status.md) with the decline reason, for example `card_declined`. If the provider rejects the request itself, the payment becomes [`FAILED(provider_rejected)`](provider-rejected.md). The [payment processor](payment-processor.md) uses the result to pick the next payment status.

## Example
The processor sends a charge whose [provider idempotency reference](provider-idempotency-reference.md) is the order ID.
- The provider answers that the card was declined. `classifyCharge` returns a decline, and the payment becomes `FAILED(card_declined)` (S13.R-14, S13.B-09).
- The provider answers `401` because the provider key is wrong. The payment becomes `FAILED(provider_rejected)` (S13.R-14).

## Known gaps
- Not confirmed in the code: whether `classifyCharge` also handles timeouts and `5xx` answers (which become `UNKNOWN`, S13.R-15) or customer-action answers (`PENDING` with `requiresAction`). Only the two `FAILED` cases are tied to it.
- Not confirmed in the code: whether `classifyCharge` calls `findMismatch`, which is in the same file. That check turns a mismatched success into `UNKNOWN` instead of `COMPLETED` (S13.R-13).
- The spec does not say which provider decline codes besides `card_declined` count as definite declines.

## Used by
<!-- used-by:start -->
- [S13](../capabilities/S13-payment-intents.md): R-27
- [definite-decline](definite-decline.md)
- [payment-processor](payment-processor.md)
- [payments-domain-layer](payments-domain-layer.md)
- [provider-idempotency-reference](provider-idempotency-reference.md)
<!-- used-by:end -->
