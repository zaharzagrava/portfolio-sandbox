---
id: order-fulfilment-changed-event
title: order.fulfilment_changed event
kind: term
status: draft
aliases: [order.fulfilment_changed]
defined_for: S10-cart-checkout
rules_hash: e3b0c44298fc
---
# order.fulfilment_changed event
## Definition
`order.fulfilment_changed` is the event the [orders domain](orders-domain.md) publishes each time a [fulfilment move](fulfilment.md) succeeds. Only [`OrderFulfilmentService.apply`](order-fulfilment-service.md) emits it, so each fulfilment move produces exactly one such event. Other capabilities subscribe to it so they can react to shipping and delivery progress. It is one of the order events, alongside `order.reserved`, [`order.paid`](order-paid-event.md), [`order.cancelled`](order-cancelled-event.md) and `order.refunded`.

## Example
`ship` succeeds on a `FULFILLING` order, and `order.fulfilment_changed` is published for that order. Illustrative only: a notification capability could listen for it and email the buyer.

## Known gaps
- The spec does not describe the event payload, for example whether it carries the new status, the previous status, the shop order or the order version.
- The spec does not say whether the event goes through the outbox in the same transaction as the move, or which consumers subscribe to it.

## Used by
<!-- used-by:start -->
- [fulfilment](fulfilment.md)
- [orders-domain](orders-domain.md)
<!-- used-by:end -->
