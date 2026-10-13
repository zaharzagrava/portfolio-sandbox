---
id: deliver-order
title: deliver (order delivery)
kind: term
status: draft
aliases: [deliver]
defined_for: S10-cart-checkout
rules_hash: e3b0c44298fc
---
# deliver (order delivery)
## Definition
`deliver` is the [order command](order-command.md) that moves a [`SHIPPED`](order-status.md) order to `DELIVERED`. It is the last step of [fulfilment](fulfilment.md). It runs only through [`OrderFulfilmentService.apply`](order-fulfilment-service.md) and emits [`order.fulfilment_changed`](order-fulfilment-changed-event.md). It is a [conditional change](durable-conditional-write.md) with one history row and `version` raised by one.

## Example
For a `PAID` order, `startFulfilment`, `ship {trackingCode}` and then `deliver` end with the order in `DELIVERED`.

## Known gaps
- The spec does not say whether a `DELIVERED` order can still be refunded. Refunds are stated only for `PAID` or `FULFILLING` orders.
- The spec does not say who or what triggers delivery (a seller action, or a carrier signal), and it lists no HTTP endpoint for it.

## Used by
<!-- used-by:start -->
- [durable-conditional-write](durable-conditional-write.md)
- [fulfilment](fulfilment.md)
- [order-command](order-command.md)
<!-- used-by:end -->
