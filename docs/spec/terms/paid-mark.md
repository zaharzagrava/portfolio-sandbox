---
id: paid-mark
title: Paid mark
kind: term
status: draft
aliases: [paid]
defined_for: order-reservation
rules_hash: e3b0c44298fc
---
# Paid mark
## Definition
The paid mark is the move of an order to the [`PAID`](order-status.md) order status. [S10](../capabilities/S10-cart-checkout.md) sets it, and only from a [verified webhook event](verified-webhook-event.md) sent by the [payment provider](payment-provider.md). The event's payment status, amount and currency must all match the order. If any of them does not match, the order is not marked paid and the event is stored as a [REJECTED payment event](rejected-payment-event.md). The paid mark applies to the whole order, not to each shop order.

## Example
Order `ord_123` is `RESERVED`, and W03 shows it as "Awaiting payment". A verified webhook event arrives with a successful payment status, amount 49.90 and currency EUR, which match the order (all values are illustrative). S10 moves the order to `PAID`, and W03 now shows "Paid". If the same event had said 39.90, the order would stay `RESERVED` and the event would be stored as `REJECTED`.

## Known gaps
- The spec does not say what happens when a matching webhook event arrives after the order was already cancelled with `hold_expired`.
- The spec does not say how S13's payment result (charge outcome, unknown outcome) changes the order, apart from the webhook path.
- The spec does not say whether a duplicate webhook event for an order that is already `PAID` is ignored, or whether that is guaranteed by the inbox.

## Used by
<!-- used-by:start -->
- [payment-provider](payment-provider.md)
- [provider-charge-metadata](provider-charge-metadata.md)
- [rejected-payment-event](rejected-payment-event.md)
- [shop-order](shop-order.md)
- [verified-webhook-event](verified-webhook-event.md)
<!-- used-by:end -->
