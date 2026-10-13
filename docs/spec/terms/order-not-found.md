---
id: order-not-found
title: order_not_found (404)
kind: term
status: draft
aliases: [order_not_found]
defined_for: S13-payment-intents
rules_hash: e3b0c44298fc
---
# order_not_found (404)
## Definition
`order_not_found` is the error that [`POST /payments/intents`](payment-intent.md) returns with `404` when the buyer cannot pay for the order they named. The same answer covers an order that does not exist and an order that belongs to another buyer, so the caller cannot tell the two apart. It is also returned when the [order copy](order-copy.md) has not arrived from the order system within the short wait the endpoint allows. The error is raised as `OrderNotFoundError`.

## Example
Buyer V posts `{"orderId": "<buyer U's order>", "paymentMethodId": "pm_1"}` (illustrative IDs) with a new [`Idempotency-Key`](idempotency-key.md). The answer is `404 order_not_found`, the same answer V would get for an ID that does not exist.

## Known gaps
- The spec does not say how the endpoint waits for a late [`order.reserved`](order-reserved-event.md) event (for example, polling the order copy or subscribing to it). It gives only the wait limit in S13.B-06.
- The spec does not list the members of the [`404` problem body](exact-body-members.md) beyond the code.

## Used by
<!-- used-by:start -->
- [exact-body-members](exact-body-members.md)
- [order-copy](order-copy.md)
<!-- used-by:end -->
