---
id: heap-offer
title: Heap offer
kind: term
status: draft
aliases: [offer, offers]
defined_for: S35-trending
rules_hash: 9e74baf6fd6f
---
# Heap offer
## Definition
A heap offer submits one product and its count to the [top-k heap](top-k-heap.md). If the product is already in the heap, its count is replaced by the offered value, not added to it. If the heap has space, the product goes in. If the heap is full, the product replaces the [lightest entry](top-k-heap.md) only when its count is higher. Otherwise the offer is rejected.

## Example
A heap with capacity 3 receives the offers `a:5, b:3, c:4, d:9, e:2, b:7`:
- `d:9` evicts `b:3`.
- `e:2` is rejected because it is lower than the minimum, `c:4`.
- `b:7` evicts `c:4`.

The heap ends with `d 9, b 7, a 5`. Note that `b` ends at 7, not 10: the second offer replaced the count.

## Known gaps
- The spec does not say if the offered count is the [Count-Min Sketch ↗](../sw-external-terms.md#count-min-sketch) [estimate](sketch-overcount.md) after each event or some other value.
- The spec does not say what happens when an offer has the same count as the current minimum.

## Used by
<!-- used-by:start -->
- [S35](../capabilities/S35-trending.md): B-20
- [sketch-overcount](sketch-overcount.md)
- [top-k-heap](top-k-heap.md)
<!-- used-by:end -->
