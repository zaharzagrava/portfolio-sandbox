---
id: basket-normalisation
title: Normalisation (bought-together)
kind: term
status: draft
aliases: [normalization]
defined_for: projection-and-replay
rules_hash: b3180a155860
---
# Normalisation (bought-together)
## Definition
Normalisation is a step in [S34](../capabilities/S34-recommendations.md)'s "bought together" recommendations, listed next to the [co-occurrence graph](co-occurrence-graph.md) and the [cold-start strategy](cold-start-strategy.md). In general use, it adjusts raw co-occurrence counts so that very popular products do not appear as "bought together" with everything. The spec does not confirm the method this system uses.

## Example
Illustrative: a best-selling item `p_batteries` appears in many [baskets](basket.md) with `p_kettle`. A product that appears in fewer baskets overall, `p_descaler`, appears with `p_kettle` less often. Normalisation can still rank `p_descaler` higher for `p_kettle`, because their pairing is more specific.

## Known gaps
- The spec does not say which normalisation formula is used.
- The spec does not say whether normalisation happens when the graph is built or when it is queried.

## Used by
<!-- used-by:start -->
- [S34](../capabilities/S34-recommendations.md): R-15
- [basket](basket.md)
- [bought-together](bought-together.md)
- [co-occurrence-graph](co-occurrence-graph.md)
- [cold-start-strategy](cold-start-strategy.md)
- [direct-neighbour](direct-neighbour.md)
<!-- used-by:end -->
