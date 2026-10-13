---
id: requires-action
title: requiresAction
kind: term
status: draft
aliases: [requires action]
defined_for: S13-payment-intents
rules_hash: 65d3812e2b5b
---
# requiresAction
## Definition
`requiresAction` marks a [`PENDING`](payment-status.md) payment for which the [provider needs](payment-provider.md) the customer to do something before the charge can finish. In general PSP terms, this is usually an authentication step with the customer's bank. The payment status does not change and no event is emitted. If the order is cancelled while the payment waits for the customer, the [provider intent](payment-intent.md) is cancelled once ([provider idempotency reference `cancel:<paymentId>`](provider-idempotency-reference.md)) and the payment becomes `CANCELLED`.

## Example
The charge call returns a "needs customer action" result. `GET /payments/:paymentId` then shows the payment as `PENDING` with `requiresAction` set, and nothing is sent to [`orders.events`](orders-events-topic.md) or the outbox.

## Known gaps
- The spec does not say what `requiresAction` contains (a boolean, a redirect URL, or provider data) or how the buyer's client completes the action.
- The spec does not say how the payment leaves this state after the customer acts (a provider callback, the status refresh, or the resolution sweep).
- The spec does not say whether a realtime `payment.status` message is published when the flag is set, because no status change happens.

## Used by
<!-- used-by:start -->
- [S13](../capabilities/S13-payment-intents.md): B-17
- [payment-intent](payment-intent.md)
- [payment-provider](payment-provider.md)
- [provider-idempotency-reference](provider-idempotency-reference.md)
<!-- used-by:end -->
