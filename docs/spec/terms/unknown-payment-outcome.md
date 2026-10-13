---
id: unknown-payment-outcome
title: Unknown payment outcome
kind: term
status: draft
aliases: [unknown outcome]
defined_for: idempotency-key
rules_hash: d567c3c7a63a
---
# Unknown payment outcome
## Definition
An unknown payment outcome is a payment where the platform cannot tell whether the [payment provider](payment-provider.md) charged the customer. In general engineering, this happens when a provider call times out or the connection drops before a reply arrives. [S13](../capabilities/S13-payment-intents.md) lists handling unknown outcomes as one of its jobs, next to [payment intents](payment-intent.md), [idempotency ↗](../sw-external-terms.md#idempotency) and the [circuit breaker ↗](../sw-external-terms.md#circuit-breaker). A careless retry here could charge the customer twice. Treating such a payment as "not yet known" instead of "failed" is design intent (not stated in the spec).

## Example
A client sends `POST /payments/intents` with an [`Idempotency-Key` header](idempotency-key.md) and gets `202` with a [`Location` header ↗](../sw-external-terms.md#location-header). Later, S13 calls the payment provider and the call times out (illustrative scenario). S13 now has an unknown outcome: it does not know whether the charge went through.

## Known gaps
- The spec does not say what S13 counts as an unknown outcome, for example whether it covers timeouts, connection errors or [open-circuit failures ↗](../sw-external-terms.md#circuit-breaker).
- The spec does not say how S13 resolves an unknown outcome, for example by asking the provider for the status, by retrying, or by waiting for a payment webhook.
- The spec does not say what state the order and the payment status shown to the client are in while the outcome is unknown.

## Used by
<!-- used-by:start -->
- [S13](../capabilities/S13-payment-intents.md): B-12
- [idempotency-key](idempotency-key.md)
- [payment-failed-event](payment-failed-event.md)
- [payment-intent](payment-intent.md)
- [payment-provider](payment-provider.md)
- [provider-lookup](provider-lookup.md)
<!-- used-by:end -->
