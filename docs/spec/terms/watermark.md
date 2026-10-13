---
id: watermark
title: Watermark
kind: term
status: draft
aliases: [watermarks]
defined_for: S35-trending
rules_hash: 06fe05f08058
---
# Watermark
## Definition
The watermark is the trending consumer's estimate of how far [event time ↗](../sw-external-terms.md#event-time) has progressed. It equals the highest event time seen so far minus a fixed allowance for lateness. Each partition of the input stream keeps its own watermark, and a [trending window](trending-window.md) closes once the watermark passes the window's end. The lateness allowance lets events that arrive out of order still land in the right minute before the window closes.

## Example
With the configured lateness of 120 s, suppose the latest event time seen on a partition is `11:03:10`. The watermark is then `11:01:10`. The `11:00–11:01` window closes and is [merged](window-merge.md), and the `11:01–11:02` window stays open.

## Known gaps
- The spec does not say whether "passes its end" means strictly greater than the end or greater than or equal to it.
- Not confirmed in the code: whether the watermark is persisted or rebuilt from replay after a restart. S35.B-15 only says open windows are rebuilt from the earliest unmerged offset.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-40
- [S35](../capabilities/S35-trending.md): R-15, R-16
- [allowed-lateness](allowed-lateness.md)
- [analytics-events-topic](analytics-events-topic.md)
- [dropped-late-event](dropped-late-event.md)
- [event-ts](event-ts.md)
- [idle-partition](idle-partition.md)
- [idle-timeout](idle-timeout.md)
- [late-event-horizon](late-event-horizon.md)
- [mark-all-read](mark-all-read.md)
- [post-notifications-read](post-notifications-read.md)
- [ranking-span](ranking-span.md)
- [received-at](received-at.md)
- [trending-minute-window](trending-minute-window.md)
- [trending-window](trending-window.md)
- [window-merge](window-merge.md)
<!-- used-by:end -->
