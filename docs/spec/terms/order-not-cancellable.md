---
id: order-not-cancellable
title: order_not_cancellable (409)
kind: term
status: draft
aliases: [order_not_cancellable]
defined_for: S10-cart-checkout
rules_hash: e3b0c44298fc
---
# order_not_cancellable (409)
## Definition
`order_not_cancellable` is the [conflict error](conflict-error.md) that `POST /orders/:orderId/cancel` returns with `409` when the order cannot be cancelled anymore. A buyer can cancel only a [`RESERVED`](order-status.md) order. If the [payment success](payment-succeeded-event.md) has already moved the order to [`PAID`](order-status.md), the buyer's cancel loses the race and gets this error. The order is left unchanged.

## Example
A buyer's cancel and the payment success event race each other. If the event wins, the order ends `PAID` and the cancel answers:
```
409 order_not_cancellable
```
If the cancel wins, the order ends `CANCELLED` and one [refund command](refund.md) is sent.

## Known gaps
- The spec does not say what cancelling an order that is already `CANCELLED` returns: this error, or a repeated `200`.
- The spec does not list any [extension members](extension-members.md) in the problem body.

## Used by
<!-- used-by:start -->
- [conflict-error](conflict-error.md)
- [extension-members](extension-members.md)
- [payment-succeeded-event](payment-succeeded-event.md)
- [refund](refund.md)
<!-- used-by:end -->
