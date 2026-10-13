---
id: trending-minute-window
title: Trending minute window
kind: term
status: draft
aliases: [minute boundary, one-minute windows]
defined_for: S35-trending
rules_hash: 6d70ebc64134
---
# Trending minute window
## Definition
A [trending window](trending-window.md) is a one-minute bucket of [event time ↗](../sw-external-terms.md#event-time). The consumer uses it to count views and add-to-carts for each partition. An event belongs to the window that contains its event time, which is the earlier of `ts` and `received_at`. A window closes when the [watermark](watermark.md) passes its end, and its counts are then added to the [Redis aggregate](trending-aggregate.md) exactly once, even if that step is replayed. Late events for a window that is already closed but still inside the [horizon](late-event-horizon.md) are handled by a separate path that fixes the counts already added.

## Example
A view at 11:00:30 falls into the 11:00–11:01 window. A call at 11:59:20 still counts it. A call at 12:01:05 no longer does.

## Known gaps
- The spec does not give a state model for a window. It only says a window is open, then closed and merged.

## Used by
<!-- used-by:start -->
- [S35](../capabilities/S35-trending.md): R-05
- [correction-path](correction-path.md)
- [idle-partition](idle-partition.md)
- [late-event-horizon](late-event-horizon.md)
- [ranking-span](ranking-span.md)
- [trending-aggregate](trending-aggregate.md)
- [trending-score](trending-score.md)
- [trending-window](trending-window.md)
- [watermark](watermark.md)
- [window-merge](window-merge.md)
<!-- used-by:end -->
