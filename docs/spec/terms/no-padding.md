---
id: no-padding
title: No padding of neighbour lists
kind: term
status: draft
aliases: [padded]
defined_for: S34-recommendations
rules_hash: 317780b122d4
---
# No padding of neighbour lists
## Definition
When a product has fewer [visible neighbours](search-visibility.md) than [`limit`](suggest-limit.md), the endpoint returns a shorter list. It does not fill the gap with hidden [neighbours](direct-neighbour.md), popular products or any other filler. A hidden neighbour is replaced only by the next visible one from the same [candidate list](co-occurrence-graph.md). A short or empty [rail](recommendation-rail.md) is a valid `200` answer. Design intent (not stated in the spec): every item shown should be a real [co-purchase signal](bought-together.md).

## Example
Product `Y` has only hidden neighbours. The answer is `200` with `items: []` and the [standard cache header ↗](../sw-external-terms.md#cache-control) (S34.B-05).

## Known gaps
- The spec does not say whether hidden neighbours count when deciding that direct neighbours are "fewer than `limit`". That count decides whether the 2-hop lookup runs.

## Used by
<!-- used-by:start -->
- [S34](../capabilities/S34-recommendations.md): R-07
- [S35](../capabilities/S35-trending.md): R-08
- [bought-together](bought-together.md)
- [co-occurrence-graph](co-occurrence-graph.md)
- [direct-neighbour](direct-neighbour.md)
- [recommendation-rail](recommendation-rail.md)
- [search-visibility](search-visibility.md)
- [trending-limit](trending-limit.md)
<!-- used-by:end -->
