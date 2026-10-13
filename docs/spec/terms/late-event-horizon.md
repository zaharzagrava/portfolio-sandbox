---
id: late-event-horizon
title: Late-event horizon
kind: term
status: draft
aliases: [horizon]
defined_for: S35-trending
rules_hash: b4f80c3082b2
---
# Late-event horizon
## Definition
The late-event horizon is how far back an event can arrive after its [window](trending-window.md) has already closed and still be counted. If that window is inside the horizon, the event is sent back through the process that fixes results for windows that have already closed. If the window is older, the event is thrown away and added to a count of discarded events. The horizon covers the same stretch of past windows that scores are calculated from. Design intent (not stated in the spec): a window outside that stretch no longer affects any score, so fixing it would be wasted work.

## Example
Illustrative: at `12:00`, a view with [event time ↗](../sw-external-terms.md#event-time) `11:20:15` arrives after the `11:20–11:21` window has closed. It is inside the 60-minute horizon, so it is applied once through the correction path. A view with event time `10:50:00` is older than the horizon, so it is dropped and only counted.

## Known gaps
- The spec does not say whether the horizon is measured from the [watermark](watermark.md), the latest minute boundary or the [wall clock ↗](../sw-external-terms.md#wall-clock).
- The spec does not name the metric that counts dropped late events.

## Used by
<!-- used-by:start -->
- [S35](../capabilities/S35-trending.md): R-17
- [allowed-lateness](allowed-lateness.md)
- [correction-path](correction-path.md)
- [dropped-late-event](dropped-late-event.md)
- [idle-partition](idle-partition.md)
- [ranking-span](ranking-span.md)
- [trending-minute-window](trending-minute-window.md)
- [trending-window](trending-window.md)
- [watermark](watermark.md)
<!-- used-by:end -->
