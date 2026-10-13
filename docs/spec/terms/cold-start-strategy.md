---
id: cold-start-strategy
title: Cold-start strategy
kind: term
status: draft
aliases: [cold start, cold-start]
defined_for: projection-and-replay
rules_hash: e3b0c44298fc
---
# Cold-start strategy
## Definition
The cold-start strategy is how [S34](../capabilities/S34-recommendations.md) produces ["bought together"](bought-together.md) recommendations for a product that has few or no direct [co-purchases](co-occurrence-graph.md) yet. S34's summary describes it as a ["2-hop"](two-hop-lookup.md) cold start. In general use, that means following the [co-occurrence graph](co-occurrence-graph.md) through an intermediate product to reach products two steps away. The spec does not confirm the exact rule.

## Example
Illustrative: a new product `p_teapot` has been bought only with `p_kettle`. With a 2-hop lookup, `p_teapot` can also get `p_mug`, because `p_mug` is often bought with `p_kettle`.

## Known gaps
- The spec does not say when a product counts as "cold", or when the strategy stops being used.
- The spec does not say how 2-hop results are scored or ranked compared with [direct neighbours](direct-neighbour.md).

## Used by
<!-- used-by:start -->
- [basket-normalisation](basket-normalisation.md)
- [bought-together](bought-together.md)
- [co-occurrence-graph](co-occurrence-graph.md)
- [direct-neighbour](direct-neighbour.md)
- [rank-badge](rank-badge.md)
- [two-hop-lookup](two-hop-lookup.md)
<!-- used-by:end -->
