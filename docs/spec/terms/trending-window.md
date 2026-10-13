---
id: trending-window
title: Trending window
kind: term
status: draft
aliases: [window, windows]
defined_for: S35-trending
rules_hash: 4ede39d29dc3
---
# Trending window
## Definition
A trending window is a one-minute tumbling bucket of [event time ↗](../sw-external-terms.md#event-time). It is kept per [partition of `analytics.events`](analytics-events-topic.md). While it is open, it collects weighted counts of `product_view` and `add_to_cart` per product and category, capped per visitor. When the point up to which events are taken as complete passes its end, the window closes and its counts are merged once into the running totals kept in Redis. The endpoint's score is the sum of the most recent windows that fall inside the [ranking span](trending-ranking-cache.md).

## Example
A view with event time `11:00:30` falls in the `11:00–11:01` window. It still counts in a request at `11:59:20`, but not in one at `12:01:05` (S35.B-09). If product `B` has 20 points in partition `p1` and 15 in `p2` for the same minute, the aggregate holds `B 35` once both windows close (S35.B-11).

## Known gaps
- The spec does not describe the window lifecycle as a model. It only says a window is open, then closed and merged.
- The spec does not say how a window's counts are held in memory before the merge (Count-Min Sketch plus top-K heap, according to the Decisions), or what happens when the memory budget is reached.

## Used by
<!-- used-by:start -->
- [S35](../capabilities/S35-trending.md): R-16, R-17, R-18, B-05, B-09
- [aggregate-store](aggregate-store.md)
- [allowed-lateness](allowed-lateness.md)
- [analytics-events-topic](analytics-events-topic.md)
- [bounded-retention](bounded-retention.md)
- [category-tracking](category-tracking.md)
- [correction-path](correction-path.md)
- [dataset-t](dataset-t.md)
- [dropped-late-event](dropped-late-event.md)
- [event-ts](event-ts.md)
- [late-event-horizon](late-event-horizon.md)
- [merge-cycle](merge-cycle.md)
- [partition-owner](partition-owner.md)
- [partition-window-merge](partition-window-merge.md)
- [product-view-event](product-view-event.md)
- [received-at](received-at.md)
- [shutdown-deadline](shutdown-deadline.md)
- [top-k-heap](top-k-heap.md)
- [trending-aggregate](trending-aggregate.md)
- [trending-configuration](trending-configuration.md)
- [trending-event-weight](trending-event-weight.md)
- [trending-minute-window](trending-minute-window.md)
- [trending-ranking-cache](trending-ranking-cache.md)
- [trending-score](trending-score.md)
- [visitor](visitor.md)
- [watermark](watermark.md)
- [weighted-total](weighted-total.md)
- [window-merge](window-merge.md)
<!-- used-by:end -->
