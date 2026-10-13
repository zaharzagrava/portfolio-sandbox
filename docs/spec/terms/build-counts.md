---
id: build-counts
title: Build counts (products, edges, removed)
kind: term
status: draft
aliases: [edges, removed]
defined_for: S34-recommendations
rules_hash: 7afe75d9d5ed
---
# Build counts (products, edges, removed)
## Definition
Build counts are the three totals a successful build reports: `products`, `[edge](co-occurrence-graph.md)s` and `removed`. `removed` counts the products whose [lists](bought-together.md) [the build](order-baskets-build.md) deleted because they no longer have any edge. With unchanged [baskets](basket.md), two runs must report the same counts and write the same lists. This makes the counts a quick check that the build is [deterministic ↗](../sw-external-terms.md#deterministic-build).

## Example
```json
{ "products": 412, "edges": 3180, "removed": 1 }
```
(The values are illustrative.) Running the build again over the same baskets must return the same object (S34.B-16). A product that lost all its edges adds to `removed` (S34.B-18).

## Known gaps
- The spec does not say exactly what `products` and `edges` count. For example, it does not say whether an edge is counted once or once per direction.
- The spec does not say where the counts are reported, for example in the job result, a log or a metric.

## Used by
<!-- used-by:start -->
- [S34](../capabilities/S34-recommendations.md): B-18
- [basket](basket.md)
- [bought-together](bought-together.md)
- [distinct-buyers-threshold](distinct-buyers-threshold.md)
- [order-baskets-build](order-baskets-build.md)
<!-- used-by:end -->
