---
id: payment-method-token
title: Payment method token
kind: term
status: draft
aliases: []
defined_for: S13-payment-intents
rules_hash: 1714f01aca73
---
# Payment method token
## Definition
The payment method token stands for the buyer's way of paying, such as a saved card. The platform passes it on to the payment provider when it charges a payment, and does not hold the card details itself. It counts as a secret, like the [provider secret](provider-secret.md) and the `clientSecret`. It must never appear in logs, [outbox payloads](event-payload.md), events, [realtime pushes](realtime-event.md) or [error bodies](problem-body.md). Raw card fields are not accepted in the [payment intent](payment-intent.md) body. A body with a card field answers [`validation_failed`](validation-failed-error.md).

## Example
The buyer starts a payment with this body:
```json
{ "orderId": "ord_123", "paymentMethodId": "pm_abc" }
```
(The ID values are illustrative.) The log lines for the new `paymentId` carry its `paymentId` and `orderId`, but never the payment method token.

## Known gaps
- The spec does not say whether the payment method token is the `paymentMethodId` value in the request body, or a different value the provider derives from it.
- The spec does not say where the token is stored, or whether it is kept after the payment reaches a [terminal status](terminal-payment-status.md).
- The spec does not say how the platform checks that the token belongs to the buyer.

## Used by
<!-- used-by:start -->
- [client-secret](client-secret.md)
- [event-payload](event-payload.md)
- [payment-intent](payment-intent.md)
- [problem-body](problem-body.md)
- [provider-secret](provider-secret.md)
- [realtime-event](realtime-event.md)
- [terminal-payment-status](terminal-payment-status.md)
<!-- used-by:end -->
