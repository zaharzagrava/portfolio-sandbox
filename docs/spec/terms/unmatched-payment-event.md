---
id: unmatched-payment-event
title: UNMATCHED payment event
kind: term
status: draft
aliases: [unmatched]
defined_for: S10-cart-checkout
rules_hash: e3b0c44298fc
---
# UNMATCHED payment event
## Definition
`UNMATCHED` is the status given to a stored payment event that cannot be tied to an order. This happens when the event has no [`orderId`](order-id.md), or when its `orderId` refers to an order that does not exist. The event is kept, not thrown away, but it does not change any order. It is one of the [outcomes of processing an event](payment-event-outcome.md). The other outcomes in the rules are [`REJECTED`](rejected-payment-event.md) and [`IGNORED`](ignored-payment-event.md).

## Example
A [verified webhook event](verified-webhook-event.md) `payments.payment_succeeded` arrives with `orderId: "ord_unknown_123"` (illustrative), and no such order exists. The event is stored as `UNMATCHED`, and no order moves to `PAID`.

## Known gaps
- The spec does not say whether an `UNMATCHED` event is ever processed again, for example if the order shows up later.
- The spec does not say whether anyone is alerted about `UNMATCHED` events, or how operators find them.
- The spec does not say whether events from the `payments.events` topic consumer are also stored as `UNMATCHED`, or only webhook events.

## Used by
<!-- used-by:start -->
- [payment-event-outcome](payment-event-outcome.md)
- [verified-webhook-event](verified-webhook-event.md)
<!-- used-by:end -->
