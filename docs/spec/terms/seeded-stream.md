---
id: seeded-stream
title: Seeded stream
kind: term
status: draft
aliases: [seeded]
defined_for: S35-trending
rules_hash: 435cb08f431c
---
# Seeded stream
## Definition
A seeded stream is a synthetic event stream made by a generator with a fixed random seed, so every test run gets exactly the same events. The accuracy test uses one to check that the [approximate top-K](top-k-heap.md) finds the true [heavy hitters](heavy-hitters.md). Because the stream repeats exactly, a test failure points to a real regression and not to random chance. Fixing the seed for this reason is design intent (not stated in the spec).

## Example
Scenario [AS-25](acceptance-scenario.md) generates at least 200,000 events over 20,000 products from a fixed seed. It feeds them through the [Count-Min Sketch ↗](../sw-external-terms.md#count-min-sketch) and the heap, then compares the heap with the [exact top 10](exact-top-k.md).

## Known gaps
- The spec does not give the seed value, the popularity distribution of the products, or the mix of views and add-to-carts.

## Used by
<!-- used-by:start -->
- [S35](../capabilities/S35-trending.md): B-19
- [acceptance-scenario](acceptance-scenario.md)
- [exact-top-k](exact-top-k.md)
- [heavy-hitters](heavy-hitters.md)
- [top-k-heap](top-k-heap.md)
<!-- used-by:end -->
