---
id: basket
title: Basket (order basket)
kind: term
status: draft
aliases: [basket store, baskets]
defined_for: projection-and-replay
rules_hash: 8540e5dc372f
---
# Basket (order basket)
## Definition
A basket is the stored record of one paid order, used as input for ["bought together"](bought-together.md) recommendations. [`OrderBasketsProjector`](order-baskets-projector.md) records exactly one basket each time an order is reported as paid. Baskets live in a store that is treated as a [projection ↗](../sw-external-terms.md#projection), so [replay](event-replay.md) can rebuild them from the log if they are lost. A basket is separate from a [cart line](cart-line.md): it comes from paid orders, not from a shopper's cart.

## Example
Order `ord_123` (illustrative) is paid with `p_kettle` and `p_mug`. `OrderBasketsProjector` records one basket for `ord_123`, and that basket links the two products.

## Known gaps
- The spec does not say what a basket contains (product ids only, quantities, shop or tenant).
- The spec does not say how baskets feed the [co-occurrence graph](co-occurrence-graph.md).
- The spec does not say whether baskets are ever removed, for example when an order is refunded or cancelled.

## Used by
<!-- used-by:start -->
- [S34](../capabilities/S34-recommendations.md): R-14, B-11, B-14, B-16
- [basket-normalisation](basket-normalisation.md)
- [bought-together](bought-together.md)
- [bucket-count](bucket-count.md)
- [build-counts](build-counts.md)
- [cart-line](cart-line.md)
- [co-occurrence-graph](co-occurrence-graph.md)
- [co-order-threshold](co-order-threshold.md)
- [direct-neighbour](direct-neighbour.md)
- [event-replay](event-replay.md)
- [order-baskets-build](order-baskets-build.md)
- [order-baskets-projector](order-baskets-projector.md)
- [order-paid-event](order-paid-event.md)
- [order-refunded-event](order-refunded-event.md)
- [recommendations-build-skipped-total](recommendations-build-skipped-total.md)
<!-- used-by:end -->
