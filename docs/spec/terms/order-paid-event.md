---
id: order-paid-event
title: order.paid event
kind: term
status: draft
aliases: [order.paid]
defined_for: projection-and-replay
rules_hash: d32613bfda5d
---
# order.paid event
## Definition
`order.paid` is the [domain event](event-definition.md) that signals an order has been paid. It travels on the [event backbone](event-backbone.md) like every other event. [S34](../capabilities/S34-recommendations.md) consumes it: [`OrderBasketsProjector`](order-baskets-projector.md) records one [basket](basket.md) for each `order.paid` event. Because the basket store is a [projection ↗](../sw-external-terms.md#projection), the log must keep every `order.paid` event so that [replay](event-replay.md) can rebuild it.

## Example
`OrderBasketsProjector` receives an `order.paid` event for order `ord_123` (illustrative id) and records one basket for that order. If the same event is [delivered again](at-least-once-delivery.md), it must still produce only one basket.

## Known gaps
- The spec does not say which service publishes `order.paid`, or exactly when in the order's life it is emitted.
- The spec does not give the [payload schema](event-payload.md), for example whether it lists the order's products.

## Used by
<!-- used-by:start -->
- [J02](../capabilities/J02-seller-to-first-sale.md): B-18
- [S34](../capabilities/S34-recommendations.md): B-11
- [at-least-once-delivery](at-least-once-delivery.md)
- [basket](basket.md)
- [bought-together](bought-together.md)
- [co-occurrence-graph](co-occurrence-graph.md)
- [direct-neighbour](direct-neighbour.md)
- [event-backbone](event-backbone.md)
- [event-definition](event-definition.md)
- [event-payload](event-payload.md)
- [event-replay](event-replay.md)
- [model-registration](model-registration.md)
- [order-baskets-projector](order-baskets-projector.md)
- [orm-association](orm-association.md)
- [webhook-signature-signing](webhook-signature-signing.md)
<!-- used-by:end -->
