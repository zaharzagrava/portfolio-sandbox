---
id: top-k-heap
title: Top-k heap
kind: term
status: draft
aliases: [heap]
defined_for: S35-trending
rules_hash: a3fd2a7089a8
---
# Top-k heap
## Definition
The top-k heap is the fixed-size [min-heap ↗](../sw-external-terms.md#min-heap) that keeps the heaviest products seen in a [partition window](trending-window.md). It works together with the [Count-Min Sketch ↗](../sw-external-terms.md#count-min-sketch), which estimates counts, while the heap remembers which products are currently on top (pattern P1102). Because the heap's capacity is fixed, its memory stays bounded however many distinct products appear in the stream. Its ranking is approximate, so a product near the cut-off can be missing. A min-heap keeps the lightest entry at the root, so a new candidate is compared with it in one step. That reason is design intent (not stated in the spec). The code is in `packages/backend/libs/domains/discovery/domain/top-k.ts#TopK`.

## Example
Scenario AS-25 sends a [seeded stream](seeded-stream.md) of at least 200,000 events over 20,000 products. At least 9 of the [exact top 10](exact-top-k.md) products must end up in the heap. The heap capacity comes from the [`TRENDING_*` configuration](trending-configuration.md), and its default is heap K 50.

## Known gaps
- The spec does not say how the heap orders two products that have equal counts at the [eviction boundary](heap-offer.md).
- The spec does not say if one heap is kept per category or one per window, or how heaps feed the [Redis aggregate keys](trending-aggregate.md).

## Used by
<!-- used-by:start -->
- [S35](../capabilities/S35-trending.md): B-19, B-20
- [exact-top-k](exact-top-k.md)
- [heap-offer](heap-offer.md)
- [heavy-hitters](heavy-hitters.md)
- [seeded-stream](seeded-stream.md)
- [sketch-overcount](sketch-overcount.md)
- [trending-aggregate](trending-aggregate.md)
- [trending-configuration](trending-configuration.md)
- [trending-window](trending-window.md)
<!-- used-by:end -->
