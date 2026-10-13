---
id: payment-intent
title: Payment intent (POST /payments/intents)
kind: term
status: draft
aliases: [intent, payment intents, post /payments/intents]
defined_for: idempotency-key
rules_hash: 3743e33911c5
---
# Payment intent (POST /payments/intents)
## Definition
A payment intent is a client's request to start a payment, sent as `POST /payments/intents` to the payment service. The route requires an [`Idempotency-Key`](idempotency-key.md), so a retry with the same key creates no second charge. The server accepts the intent and replies at once with a [`Location` ↗](../sw-external-terms.md#location-header) where the client can check the result later. [The payment provider](payment-provider.md) is never called during this request. Answering right away and finishing the payment in the background is design intent (not stated in the spec).

## Example
```
POST /payments/intents
Idempotency-Key: pay-7f3a9c21e4        (illustrative value)

→ [202 Accepted ↗](../sw-external-terms.md#http-202-accepted)
Location: <status URL, not given in the spec>
```

## Known gaps
- The spec does not say what the request body contains or what the `Location` URL looks like.
- The spec does not say which status values the client sees when it follows `Location`.
- The spec does not say whether the key length limit that [`POST /checkout`](post-checkout.md) uses also applies to this route.

## Used by
<!-- used-by:start -->
- [S13](../capabilities/S13-payment-intents.md): B-17
- [check-payment-money](check-payment-money.md)
- [order-reserved-event](order-reserved-event.md)
- [orders-events-topic](orders-events-topic.md)
- [payment-cancel](payment-cancel.md)
- [payment-provider](payment-provider.md)
- [payments-domain-layer](payments-domain-layer.md)
- [provider-idempotency-reference](provider-idempotency-reference.md)
- [requires-action](requires-action.md)
- [unknown-payment-outcome](unknown-payment-outcome.md)
<!-- used-by:end -->
