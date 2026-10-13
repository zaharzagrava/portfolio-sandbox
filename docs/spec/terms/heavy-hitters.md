---
id: heavy-hitters
title: Heavy hitters
kind: term
status: draft
aliases: [heavy hitter]
defined_for: S35-trending
rules_hash: 515465e88154
---
# Heavy hitters
## Definition
Heavy hitters are the products with the highest [weighted counts](trending-event-weight.md) in the [event stream](event-backbone.md). They are the candidates for the "Trending now" rail. The [trending consumer](event-consumer.md) does not keep an exact count for every product. A [Count-Min Sketch ↗](../sw-external-terms.md#count-min-sketch) estimates each product's count, and a [top-k heap](top-k-heap.md) keeps only the products with the highest estimates. This keeps memory fixed no matter how many products appear (pattern P1102). The heavy hitters found this way are then merged into the [trending aggregate](trending-aggregate.md), both overall and per category.

## Example
A heap with a capacity of 3 receives these offers in order: `a:5, b:3, c:4, d:9, e:2, b:7`. The heavy hitters it keeps are `d 9, b 7, a 5` (S35 B-20). At full scale, a seeded stream of at least 200,000 events over 20,000 products must keep at least 9 of the exact top 10 in the heap (S35 B-19).

## Known gaps
- The spec does not say how accurate the result is beyond the top 10. Products ranked lower may be missing or out of order.
- The spec does not say what happens when hidden products use up most of the heap. The rail is never padded, so it may return fewer items than `limit` asks for.

## Used by
<!-- used-by:start -->
- [event-backbone](event-backbone.md)
- [event-consumer](event-consumer.md)
- [seeded-stream](seeded-stream.md)
- [sketch-overcount](sketch-overcount.md)
- [top-k-heap](top-k-heap.md)
- [trending-aggregate](trending-aggregate.md)
- [trending-event-weight](trending-event-weight.md)
<!-- used-by:end -->
