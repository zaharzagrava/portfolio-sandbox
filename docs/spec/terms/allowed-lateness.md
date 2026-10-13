---
id: allowed-lateness
title: Allowed lateness
kind: term
status: draft
aliases: [lateness]
defined_for: S35-trending
rules_hash: e3b0c44298fc
---
# Allowed lateness
## Definition
Allowed lateness is how far the [watermark](watermark.md) trails the highest [event time ↗](../sw-external-terms.md#event-time) a partition has seen. A [trending window](trending-window.md) closes and is merged only after the watermark passes the window's end. So an event that arrives out of order, but within the allowed lateness, still counts in its own minute through the normal path. An event for a window that has already closed goes through the [correction path](correction-path.md) if it is inside the [late-event horizon](late-event-horizon.md); otherwise it is dropped and counted. A longer lateness catches more stragglers but delays every window close; that trade-off is design intent (not stated in the spec).

## Example
The allowed lateness is 2 minutes (S35.R-16; `TRENDING_*` lateness 120 s), and the window is `11:00–11:01`:
- The highest event time is `11:02:30`, so the watermark is `11:00:30`. The window is still open, and a view stamped `11:00:50` counts normally.
- The highest event time reaches `11:03:10`, so the watermark is `11:01:10`. The window closes and is merged. A view stamped `11:00:50` that arrives after this takes the correction path.

## Known gaps
- The spec does not say how lateness applies when an [idle partition](idle-partition.md) advances its watermark with the wall clock. It could be wall clock minus lateness, or the wall clock alone.
- The spec does not say whether the window closes when the watermark reaches its end exactly or only once it is strictly past it.
- Not confirmed in the code: the lateness is applied per partition. `PartitionWindows` and the idle-partition rule suggest it is, but the facts do not say so outright.

## Used by
<!-- used-by:start -->
- [bounded-retention](bounded-retention.md)
- [correction-path](correction-path.md)
- [idle-partition](idle-partition.md)
- [late-event-horizon](late-event-horizon.md)
- [ranking-span](ranking-span.md)
- [trending-configuration](trending-configuration.md)
- [trending-window](trending-window.md)
- [watermark](watermark.md)
<!-- used-by:end -->
