---
id: weighted-total
title: Weighted total
kind: term
status: draft
aliases: []
defined_for: S35-trending
rules_hash: d905a5b9fe91
---
# Weighted total
## Definition
The weighted total is the sum of a product's counted events, each multiplied by its [event-type weight](trending-event-weight.md). An add-to-cart carries a higher weight than a view. Summed over the [ranking horizon](trending-window.md) of windows, this total is the product's [trending score](trending-score.md). Only events that pass the filters change it. Duplicates, ignored event names, events over the [per-visitor cap](per-visitor-view-cap.md) and invalid messages add nothing.

## Example
Illustrative: within the horizon, product `B` gets 3 counted views and 1 counted add-to-cart. Its weighted total is 3×1 + 1×5 = 8. If the same [`event_id`](event-id.md) arrives three times, the total rises only once and the two copies are counted as [`duplicate`](consumer-outcomes.md) (S35.B-12).

## Known gaps
- Not confirmed in the code: whether the weighted total is applied once per event in the [Count-Min Sketch ↗](../sw-external-terms.md#count-min-sketch), or whether the weights are applied later at [merge time](partition-window-merge.md).

## Used by
<!-- used-by:start -->
- [S35](../capabilities/S35-trending.md): B-12
- [partition-window-merge](partition-window-merge.md)
- [per-visitor-view-cap](per-visitor-view-cap.md)
- [trending-event-weight](trending-event-weight.md)
- [trending-events](trending-events.md)
- [trending-score](trending-score.md)
- [trending-window](trending-window.md)
<!-- used-by:end -->
