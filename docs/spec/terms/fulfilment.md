---
id: fulfilment
title: Fulfilment
kind: term
status: draft
aliases: []
defined_for: S10-cart-checkout
rules_hash: baa0ee6560bb
---
# Fulfilment
## Definition
Fulfilment is the part of an order's life after payment, when the order is prepared, shipped and delivered. It moves through the [order commands](order-command.md) [`startFulfilment`](start-fulfilment.md), [`ship`](ship-order.md) and [`deliver`](deliver-order.md). While an order is [`FULFILLING`](order-status.md), a full refund can still move it to refunded. Every fulfilment move goes through [`OrderFulfilmentService.apply`](order-fulfilment-service.md) and publishes `order.fulfilment_changed`.

## Example
After `order.paid`, `startFulfilment` moves the order from `PAID` to `FULFILLING`. Later, `ship` and `deliver` move it on. Each of these three steps emits one `order.fulfilment_changed` event.

## Known gaps
- The spec does not say whether fulfilment applies to the whole order or to each shop order separately. This matters because one order can contain several sellers.
- The spec does not say who triggers the fulfilment steps, for example a seller-facing endpoint or another service. It lists no entry point for them.
- The spec does not name the statuses after `ship` and `deliver`.

## Used by
<!-- used-by:start -->
- [deliver-order](deliver-order.md)
- [order-command](order-command.md)
- [order-fulfilment-changed-event](order-fulfilment-changed-event.md)
<!-- used-by:end -->
