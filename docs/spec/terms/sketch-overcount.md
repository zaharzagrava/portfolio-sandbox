---
id: sketch-overcount
title: Sketch overcount (no undercount)
kind: term
status: draft
aliases: [undercount]
defined_for: S35-trending
rules_hash: 17c5781ae5df
---
# Sketch overcount (no undercount)
## Definition
The [Count-Min Sketch ↗](../sw-external-terms.md#count-min-sketch) estimates how often each product was seen, using a small fixed table of counters instead of one counter per product. [Hash collisions ↗](../sw-external-terms.md#hash-collision) can make an estimate too high, but the rule says it must never be too low. Counters stop at their maximum value (they [saturate ↗](../sw-external-terms.md#saturating-counter)). They never wrap back to a small number, because wrapping would turn a huge count into an undercount. [The heap](top-k-heap.md) uses these estimates to decide which products to keep as [heavy hitters](heavy-hitters.md).

## Example
Products `A` and `Z` share a counter in one row of the sketch. `A`'s estimate may read 12 when its true count is 9, but it never reads 8. A counter at its maximum stays there when more events arrive. (The values are illustrative.)

## Known gaps
- The spec does not say the counter width, the maximum value or the sketch width. It gives only the depth, through the [`TRENDING_*` configuration](trending-configuration.md).
- The spec does not state an error bound for overcounts. The only accuracy check is S35 B-19 (at least 9 of the exact top 10 are in the heap).

## Used by
<!-- used-by:start -->
- [S35](../capabilities/S35-trending.md): R-19
- [heap-offer](heap-offer.md)
- [heavy-hitters](heavy-hitters.md)
- [top-k-heap](top-k-heap.md)
- [trending-configuration](trending-configuration.md)
<!-- used-by:end -->
