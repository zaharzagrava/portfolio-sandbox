---
id: neighbour-score
title: Neighbour score
kind: term
status: draft
aliases: [entry score, seed score]
defined_for: S34-recommendations
rules_hash: e268d95ad5b7
---
# Neighbour score
## Definition
The neighbour score is the number attached to each item that says how strongly it is linked to the requested product. For a [direct neighbour](direct-neighbour.md), it is the edge's [cosine score ↗](../sw-external-terms.md#cosine-similarity) from the [co-occurrence graph](co-occurrence-graph.md). For an indirect item, it is the seed's score times the entry's score times a fixed reduction that makes indirect links count for less. The score orders items within the same [`hops`](hops.md) value. A stored score outside the allowed range is skipped and counted as a [corrupt entry](corrupt-entry.md).

## Example
Dataset D, product `M`: `C` (0.2067, hops 1) ranks before `P` (0.1794, hops 1). In S34.B-08, direct `Z` (0.2) still ranks above indirect `W` (0.36), because `hops` is compared first.

## Known gaps
- The spec does not say how precisely scores are written in the response body. The examples show four decimals, but no rounding rule is stated.

## Used by
<!-- used-by:start -->
- [S34](../capabilities/S34-recommendations.md): R-08, R-10
- [best-path](best-path.md)
- [co-occurrence-graph](co-occurrence-graph.md)
- [corrupt-entry](corrupt-entry.md)
- [damping-factor](damping-factor.md)
- [direct-neighbour](direct-neighbour.md)
- [neighbour-list](neighbour-list.md)
- [product-id](product-id.md)
- [redis-neighbour-lists-adapter](redis-neighbour-lists-adapter.md)
<!-- used-by:end -->
