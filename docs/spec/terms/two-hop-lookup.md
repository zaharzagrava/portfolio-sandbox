---
id: two-hop-lookup
title: 2-hop lookup
kind: term
status: draft
aliases: [2-hop, two-hop]
defined_for: projection-and-replay
rules_hash: fc2463626360
---
# 2-hop lookup
## Definition
A 2-hop lookup is a way of handling products that have little purchase history yet, and it is named in the summary of the spec's order-basket data ("2-hop cold start"). In general graph terms, it starts at a product and walks the [co-occurrence graph](co-occurrence-graph.md) through an intermediate product. That reaches products two steps away, not only [direct neighbours](direct-neighbour.md). It lets a product with few co-purchases still get suggestions of other items that people often buy with it. The spec does not confirm the exact rule that the order-basket data uses.

## Example
Illustrative: `p_teapot` has only been bought with `p_kettle`, and `p_kettle` is often bought with `p_mug`.
Hop 1: `p_teapot` → `p_kettle`. Hop 2: `p_kettle` → `p_mug`. So `p_mug` becomes a candidate for `p_teapot`.

## Known gaps
- The spec does not say when a product is cold enough to trigger the 2-hop lookup, or when it stops being used.
- The spec does not say how 2-hop candidates are scored or ranked against direct neighbours.
- The spec does not say whether the lookup is computed when a request arrives or precomputed into the co-occurrence graph.

## Used by
<!-- used-by:start -->
- [S34](../capabilities/S34-recommendations.md): R-09, R-10, R-11, B-07, B-08, B-09
- [atomic-list-swap](atomic-list-swap.md)
- [best-path](best-path.md)
- [bought-together](bought-together.md)
- [co-occurrence-graph](co-occurrence-graph.md)
- [cold-start-strategy](cold-start-strategy.md)
- [damping-factor](damping-factor.md)
- [direct-neighbour](direct-neighbour.md)
- [get-product-recommendations](get-product-recommendations.md)
- [hops](hops.md)
- [neighbour-list](neighbour-list.md)
- [recommendation-rail](recommendation-rail.md)
- [recommendations-unavailable](recommendations-unavailable.md)
- [redis-neighbour-lists-adapter](redis-neighbour-lists-adapter.md)
<!-- used-by:end -->
