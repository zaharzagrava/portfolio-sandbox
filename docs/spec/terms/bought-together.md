---
id: bought-together
title: Bought together
kind: term
status: draft
aliases: [bought-together]
defined_for: projection-and-replay
rules_hash: c95ad40fc12d
---
# Bought together
## Definition
"Bought together" is a recommendation feature: for a given product, it suggests other products that shoppers bought in the same order. A dedicated service records the set of products in each paid order. It then builds a [co-occurrence graph](co-occurrence-graph.md) from those recorded sets. The graph's raw counts are adjusted before use, and a fallback approach covers products that have few co-purchases.

## Example
Illustrative: orders containing both `p_kettle` and `p_mug` are paid. Each order.paid event becomes a basket, and the pair adds to the co-occurrence between the two products. A shopper viewing `p_kettle` can then be shown `p_mug` as "bought together".

## Known gaps
- The spec does not say how recommendations are served: the endpoint, response shape or how many products are returned.
- The spec does not say how the normalised co-occurrence turns into a final ranking.
- The spec does not say how cancelled or refunded orders affect baskets that were already recorded.

## Used by
<!-- used-by:start -->
- [S34](../capabilities/S34-recommendations.md): B-10, B-14, B-15
- [W02](../capabilities/W02-storefront-discovery.md): B-19
- [basket-normalisation](basket-normalisation.md)
- [basket](basket.md)
- [build-counts](build-counts.md)
- [co-occurrence-graph](co-occurrence-graph.md)
- [cold-start-strategy](cold-start-strategy.md)
- [direct-neighbour](direct-neighbour.md)
- [get-product-recommendations](get-product-recommendations.md)
- [hops](hops.md)
- [no-padding](no-padding.md)
- [order-baskets-projector](order-baskets-projector.md)
- [order-paid-event](order-paid-event.md)
- [recommendations-build-skipped-total](recommendations-build-skipped-total.md)
- [recommendations-unavailable](recommendations-unavailable.md)
- [two-hop-lookup](two-hop-lookup.md)
<!-- used-by:end -->
