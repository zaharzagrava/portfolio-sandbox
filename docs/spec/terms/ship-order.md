---
id: ship-order
title: ship (order shipping)
kind: term
status: draft
aliases: [ship, trackingcode]
defined_for: S10-cart-checkout
rules_hash: e3b0c44298fc
---
# ship (order shipping)
## Definition
`ship` is the order command that moves a [`FULFILLING`](order-status.md) order to `SHIPPED`. It takes a `trackingCode`. It runs only through [`OrderFulfilmentService.apply`](order-fulfilment-service.md) and emits [`order.fulfilment_changed`](order-fulfilment-changed-event.md). It is a [conditional change](guarded-update.md) with [one history row](order-status-history.md) and [`version` raised by one](order-version.md).

## Example
```
ship { "trackingCode": "TRK-12345" }   // value illustrative
```
After [`startFulfilment`](start-fulfilment.md), this moves the order from `FULFILLING` to `SHIPPED`.

## Known gaps
- The spec does not say what format `trackingCode` must have, or whether the buyer can see it through `GET /orders/:orderId`.
- The spec does not say what happens to a full [`charge.refunded`](refund.md) on a `SHIPPED` order. Refunds are stated only for `PAID` or `FULFILLING` orders.
- The spec does not say who triggers this command, and it lists no HTTP endpoint for it.

## Used by
<!-- used-by:start -->
- [guarded-update](guarded-update.md)
- [order-status-history](order-status-history.md)
- [order-version](order-version.md)
<!-- used-by:end -->
