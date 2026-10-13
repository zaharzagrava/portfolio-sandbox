---
id: get-order-by-id
title: GET /orders/:orderId
kind: term
status: draft
aliases: [/orders/:orderid]
defined_for: S10-cart-checkout
rules_hash: e3b0c44298fc
---
# GET /orders/:orderId
## Definition
`GET /orders/:orderId` returns one order that belongs to the signed-in buyer. The response includes the order's items, its [shop orders](shop-order.md) and its [timeline](order-status-history.md). It lives in [`OrdersController`](orders-domain.md) in the orders domain. Anyone who is not the buyer gets the same [`404 order_not_found`](order-not-found.md) as for a missing order, even a [shop member](shop-member.md) or a [platform admin](platform-admin.md). That makes it an [identical 404](identical-not-found.md). Internal fields, such as the [idempotency key](idempotency-key.md), the [request hash](request-fingerprint.md), the user ID and the [order version](order-version.md), are never returned.

## Example
The buyer's checkout created order `ord_123` (illustrative). The buyer calls `GET /orders/ord_123` and gets the order with its items, one shop order per seller and the timeline. A shop member of one of those sellers calls the same URL and gets `404 order_not_found`. A seller sees their own part of the order through [`GET /shops/:shopId/orders`](get-shop-orders.md) instead.

## Known gaps
- The spec does not give the full list of hidden internal fields. The rule text (S10.R-36) is cut off after "payment re…".
- The spec does not say what this route answers for a malformed `orderId` or a missing session. S10.R-35 gives `400` and `401` only for the cancel route, and these may not apply here.
- The spec does not describe the format of the timeline, for example whether it comes from the order status history.

## Used by
<!-- used-by:start -->
- [idempotency-key](idempotency-key.md)
- [identical-not-found](identical-not-found.md)
- [order-status-history](order-status-history.md)
- [order-version](order-version.md)
- [platform-admin](platform-admin.md)
- [request-fingerprint](request-fingerprint.md)
- [shop-member](shop-member.md)
- [shop-order](shop-order.md)
<!-- used-by:end -->
