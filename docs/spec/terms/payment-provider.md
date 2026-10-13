---
id: payment-provider
title: Payment provider
kind: term
status: draft
aliases: []
defined_for: idempotency-key
rules_hash: 4d409263cf22
---
# Payment provider
## Definition
The payment provider is the outside payment service (PSP) that actually charges the customer. An in-between layer connects this system to the provider and includes a [circuit breaker ↗](../sw-external-terms.md#circuit-breaker) for PSP calls. [`POST /payments/intents`](payment-intent.md) never calls the provider during the request. It accepts the intent and answers right away, so the client checks the result later. Keeping the slow, failure-prone external call out of the request path is design intent (not stated in the spec).

## Example
`POST /payments/intents` with an [`Idempotency-Key`](idempotency-key.md) returns `202` and a `Location` header. The client follows that location to read the payment status. No call to the provider happens inside that request.

## Known gaps
- The spec does not say which provider is used.
- The spec does not say when or how the provider is called after the `202`, for example through the [outbox ↗](../sw-external-terms.md#transactional-outbox) or a job.

## Used by
<!-- used-by:start -->
- [S13](../capabilities/S13-payment-intents.md): B-08, B-11
- [idempotency-key](../concepts/idempotency-key.md): C-03
- [payment-lifecycle](../concepts/payment-lifecycle.md): C-03
- [dead-push-token](dead-push-token.md)
- [definite-decline](definite-decline.md)
- [find-mismatch](find-mismatch.md)
- [orders-events-consumer](orders-events-consumer.md)
- [paid-mark](paid-mark.md)
- [payer-id](payer-id.md)
- [payment-capture](payment-capture.md)
- [payment-command](payment-command.md)
- [payment-intent](payment-intent.md)
- [payment-processor](payment-processor.md)
- [payments-domain-layer](payments-domain-layer.md)
- [payments-provider-calls-total](payments-provider-calls-total.md)
- [provider-charge-metadata](provider-charge-metadata.md)
- [provider-idempotency-reference](provider-idempotency-reference.md)
- [provider-lookup-window](provider-lookup-window.md)
- [provider-lookup](provider-lookup.md)
- [provider-operation](provider-operation.md)
- [provider-rejected](provider-rejected.md)
- [provider-statement](provider-statement.md)
- [requires-action](requires-action.md)
- [safe-http-client](safe-http-client.md)
- [terminal-payment-status](terminal-payment-status.md)
- [unknown-payment-outcome](unknown-payment-outcome.md)
- [verified-webhook-event](verified-webhook-event.md)
<!-- used-by:end -->
