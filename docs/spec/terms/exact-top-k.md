---
id: exact-top-k
title: Exact top 10
kind: term
status: draft
aliases: [exact top]
defined_for: S35-trending
rules_hash: 435cb08f431c
---
# Exact top 10
## Definition
The exact top 10 is the true list of the ten highest-scoring products, worked out by counting every event in the test stream exactly. It is the reference that the [accuracy test](acceptance-scenario.md) compares against the approximate [top-K heap](top-k-heap.md). The test passes when the heap contains almost all of the exact list. A small miss is allowed because the [sketch ↗](../sw-external-terms.md#count-min-sketch) and heap trade exactness for fixed memory.

## Example
Over the [seeded stream](seeded-stream.md), exact counting ranks ten products first. The heap, which holds 50 entries by default, must contain at least 9 of those 10 products.

## Known gaps
- The spec does not say how [ties at 10th place](suggest-ordering.md) are broken in the exact list.
- The spec does not say whether only membership in the heap is checked, or the order of the products too.

## Used by
<!-- used-by:start -->
- [S35](../capabilities/S35-trending.md): B-19
- [acceptance-scenario](acceptance-scenario.md)
- [seeded-stream](seeded-stream.md)
- [suggest-ordering](suggest-ordering.md)
- [top-k-heap](top-k-heap.md)
<!-- used-by:end -->
