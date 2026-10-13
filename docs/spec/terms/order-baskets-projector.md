---
id: order-baskets-projector
title: OrderBasketsProjector
kind: term
status: draft
aliases: []
defined_for: projection-and-replay
rules_hash: e3b0c44298fc
---
# OrderBasketsProjector
## Definition
`OrderBasketsProjector` is [S34](../capabilities/S34-recommendations.md)'s [event consumer](event-consumer.md) that builds the [basket store](basket.md). It records one basket for each [`order.paid` event](order-paid-event.md). The basket store is treated as a [projection ↗](../sw-external-terms.md#projection): it is built only from events and never from the orders table, so [replay](event-replay.md) can rebuild it if it is lost. Like every consumer, it must declare a deduplication mode, and it commits offsets only after its effects.

## Example
An `order.paid` event for `ord_123` (illustrative) arrives, and the projector stores one basket for `ord_123`. If the event is redelivered after a disconnect, it must not create a second basket.

## Known gaps
- The spec does not say which deduplication mode `OrderBasketsProjector` declares (`inbox`, `versionGuard` or `natural`), so it is not clear how a second basket is prevented when an event is delivered again.
- The spec does not give its consumer group name.
- The spec does not say whether it also updates the co-occurrence graph or only the basket store.

## Used by
<!-- used-by:start -->
- [basket](basket.md)
- [bought-together](bought-together.md)
- [event-consumer](event-consumer.md)
- [event-replay](event-replay.md)
- [order-paid-event](order-paid-event.md)
<!-- used-by:end -->
