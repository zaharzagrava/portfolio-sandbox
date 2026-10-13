---
id: rejected-payment-event
title: REJECTED payment event
kind: term
status: draft
aliases: [rejected]
defined_for: order-reservation
rules_hash: dbef190c9f0d
---
# REJECTED payment event
## Definition
`REJECTED` is the status the order system stores on a [payment webhook event](verified-webhook-event.md) that doesn't match its order. An order becomes [`PAID`](order-status.md) only when a verified webhook event's payment status, amount and currency all match it. If any of the three differs, the event is kept with status `REJECTED` and does not mark the order `PAID`. `REJECTED` is not one of the [order statuses](order-status.md), so the web app never shows it as an order status. Keeping the event, rather than dropping it, leaves a record of the mismatch. That reason is design intent (not stated in the spec).

## Example
Order `A` is [`RESERVED`](order-status.md) with an amount of 49.90 EUR. A verified webhook arrives for order `A` that reports a successful payment of 49.90 USD (all values illustrative). The currency does not match, so the event is stored as `REJECTED` and order `A` is not marked `PAID`.

## Known gaps
- The spec does not say where `REJECTED` events are stored. It also does not say whether anyone is alerted, or whether a rejected event is ever re-checked or retried.
- The spec does not say what happens to an event that fails verification. It may be stored as `REJECTED` too, or dropped.
- The spec does not say what happens next to the order after a rejected event. For example, it does not say whether the hold still expires as usual with [`hold_expired`](hold-expired.md).

## Used by
<!-- used-by:start -->
- [order-status](order-status.md)
- [paid-mark](paid-mark.md)
- [verified-webhook-event](verified-webhook-event.md)
<!-- used-by:end -->
