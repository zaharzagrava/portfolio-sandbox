---
id: charge-outcome
title: Charge outcomes
kind: term
status: draft
aliases: [ambiguous, invalid, not_sent, rejected]
defined_for: S13-payment-intents
rules_hash: 1e603176509e
---
# Charge outcomes
## Definition
A charge outcome is the single class that [`classifyCharge`](classify-charge.md) gives to one [charge call](provider-operation.md) to the provider. The possible values are `succeeded`, `declined`, `requires_action`, `rejected`, `not_sent`, `ambiguous` and `invalid`. The outcome decides the next payment status, through the same [guarded update](guarded-update.md) as every other status change. It is also the `outcome` label for charges in [`payments_provider_calls_total`](payments-provider-calls-total.md). These are the mappings the spec gives:
- `declined` leads to `FAILED`.
- `rejected` leads to `FAILED(provider_rejected)`.
- `requires_action` keeps the payment `PENDING` with [`requiresAction`](requires-action.md).
- `ambiguous` (a timeout or `5xx` after sending) leads to `UNKNOWN`.

## Example
The provider answers `400` to a charge request. The outcome is `rejected`, and the payment becomes `FAILED(provider_rejected)`. If the provider instead says nothing for 8 s, the outcome is `ambiguous`, the payment becomes `UNKNOWN(provider_timeout)`, and the charge is not sent again.

## Known gaps
- The spec does not say what `not_sent` covers. One guess is a charge refused by an open breaker before any request went out, but this is not confirmed.
- The spec does not say what `invalid` covers. One guess is a provider success that fails [`findMismatch`](find-mismatch.md) and becomes `UNKNOWN`, but this is not confirmed.
- The spec does not say whether a `succeeded` outcome is counted before or after the mismatch check.

## Used by
<!-- used-by:start -->
- [guarded-update](guarded-update.md)
- [provider-operation](provider-operation.md)
- [provider-raw-answer-kind](provider-raw-answer-kind.md)
<!-- used-by:end -->
