---
id: ranking-span
title: Ranking span
kind: term
status: draft
aliases: []
defined_for: S35-trending
rules_hash: 855b8020cec4
---
# Ranking span
## Definition
The ranking span is the stretch of [event time ↗](../sw-external-terms.md#event-time) that the [trending ranking](trending-ranking-cache.md) covers. A product's [trending score](trending-score.md) is the sum of its [weighted counts](trending-event-weight.md) over every [trending minute window](trending-minute-window.md) inside the span. The span ends at the latest [minute boundary](trending-minute-window.md) and slides forward each minute, so the oldest window drops out. The response reports the span's length as [`windowMinutes`](window-minutes.md). The [late-event horizon](late-event-horizon.md) is the same length as the ranking span.

## Example
A view has event time `11:00:30`, so it falls in the `11:00–11:01` window. This follows S35.B-09:
- At `11:59:20`, the span is `10:59–11:59`. It includes that window, so the view counts.
- At `12:01:05`, the span is `11:01–12:01`. That window has dropped out, so the view no longer counts.

## Known gaps
- The spec does not say whether "latest minute boundary" comes from the [wall clock ↗](../sw-external-terms.md#wall-clock) at request time or from the [watermark](watermark.md). The watermark trails event time by the [allowed lateness](allowed-lateness.md), so the newest windows in the span may not be closed and merged yet.
- The spec does not list a separate configuration variable for the span's length. The `TRENDING_*` window setting is the length of one window, not the length of the span.
- The spec does not say whether `windowMinutes` comes from configuration or is a fixed value in the response.

## Used by
<!-- used-by:start -->
- [allowed-lateness](allowed-lateness.md)
- [bounded-retention](bounded-retention.md)
- [late-event-horizon](late-event-horizon.md)
- [trending-event-weight](trending-event-weight.md)
- [trending-minute-window](trending-minute-window.md)
- [trending-ranking-cache](trending-ranking-cache.md)
- [trending-score](trending-score.md)
- [watermark](watermark.md)
- [window-minutes](window-minutes.md)
<!-- used-by:end -->
