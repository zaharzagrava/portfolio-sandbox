---
id: co-occurrence-graph
title: Co-occurrence graph
kind: term
status: draft
aliases: [co-occurrence]
defined_for: projection-and-replay
rules_hash: a24ef6b2ec53
---
# Co-occurrence graph
## Definition
The co-occurrence graph is the data structure behind the system's "bought together" recommendations, which are built from the products in customers' order baskets. The spec's summary lists it next to the steps for adjusting raw counts and for handling products that have little or no purchase history. In general use, products are nodes and an edge links two products bought in the same basket. Edges are usually weighted by how often that happens. The spec does not confirm that this system builds it that way.

## Example
Baskets come from [`order.paid` events](order-paid-event.md), which [`OrderBasketsProjector`](order-baskets-projector.md) records. Suppose (illustrative) products `p_kettle` and `p_mug` appear together in many baskets. The graph links them, so `p_mug` can be recommended next to `p_kettle`.

## Known gaps
- The spec does not say how baskets turn into graph edges or weights, or when the graph is updated.
- The spec does not say where the graph is stored, or whether it is a [projection ↗](../sw-external-terms.md#projection) that [replay](event-replay.md) can rebuild like the [basket store](basket.md).
- The spec does not say how the graph is queried to produce recommendations.

## Used by
<!-- used-by:start -->
- [S34](../capabilities/S34-recommendations.md): R-09, R-13, R-16, B-15
- [basket-normalisation](basket-normalisation.md)
- [basket](basket.md)
- [bought-together](bought-together.md)
- [co-order-threshold](co-order-threshold.md)
- [cold-start-strategy](cold-start-strategy.md)
- [damping-factor](damping-factor.md)
- [direct-neighbour](direct-neighbour.md)
- [event-replay](event-replay.md)
- [neighbour-score](neighbour-score.md)
- [no-padding](no-padding.md)
- [order-baskets-build](order-baskets-build.md)
- [order-paid-event](order-paid-event.md)
- [order-refunded-event](order-refunded-event.md)
- [two-hop-lookup](two-hop-lookup.md)
<!-- used-by:end -->
