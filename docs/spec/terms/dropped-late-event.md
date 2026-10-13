---
id: dropped-late-event
title: Dropped late event
kind: term
status: draft
aliases: [dropped and counted]
defined_for: S35-trending
rules_hash: c188b2eaa058
---
# Dropped late event
## Definition
A dropped late event is a [`product_view`](product-view-event.md) or [`add_to_cart`](add-to-cart-signal.md) event that arrives after its [window](trending-window.md) has closed and is also older than the [ranking horizon](late-event-horizon.md). [The consumer](event-consumer.md) does not apply it to any window or to the [aggregate](trending-aggregate.md). It only adds to a counter, so operators can see how much late data was lost. A late event that still falls inside the horizon is not dropped: it goes through the [correction path](correction-path.md) and is applied once.

## Example
At 12:00 the ranking covers the windows from 11:00 to 12:00. A `product_view` with [event time ↗](../sw-external-terms.md#event-time) 10:50 arrives after its window has closed. It changes no score, and the drop counter goes up by one. (The times are illustrative.)

## Known gaps
- The spec does not say which metric or label counts dropped late events. It names only [`trendingEvents`](trending-events.md) "and related counters".
- The spec does not say whether a dropped late event is also [dead-lettered ↗](../sw-external-terms.md#dead-letter-queue).

## Used by
<!-- used-by:start -->
- [S35](../capabilities/S35-trending.md): R-17
- [correction-path](correction-path.md)
- [event-consumer](event-consumer.md)
- [late-event-horizon](late-event-horizon.md)
- [trending-aggregate](trending-aggregate.md)
- [trending-window](trending-window.md)
- [watermark](watermark.md)
<!-- used-by:end -->
