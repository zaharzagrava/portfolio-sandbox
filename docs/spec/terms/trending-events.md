---
id: trending-events
title: trendingEvents
kind: term
status: draft
aliases: []
defined_for: S35-trending
rules_hash: e3b0c44298fc
---
# trendingEvents
## Definition
`trendingEvents` is a metric owned by the trending capability, declared next to [`trendingMerges`](trending-merges.md) and "related counters". From its name, it covers the events the [trending consumer](event-consumer.md) reads from the [analytics.events topic](analytics-events-topic.md). Its likely purpose is to show operators how incoming events are handled: counted, ignored, duplicate or dropped. That purpose is design intent (not stated in the spec).

## Example
The same [`event_id`](event-id.md) is delivered three times (S35 AS-29). The [weighted total](weighted-total.md) rises once, and the two copies are counted as `duplicate`.
Illustrative only: the spec does not confirm that this count is recorded in `trendingEvents`.

## Known gaps
- The spec does not say what `trendingEvents` counts or which labels it has. It also does not tie the `ignored`, `duplicate` or dropped counts to this metric by name.
- The spec does not show this metric is tested. AS-36 (metrics and privacy) has no test with its id.
- Not confirmed in the code: the metric's type and exported name. The notes cite only `trending-metrics.ts#trendingEvents`.

## Used by
<!-- used-by:start -->
- [analytics-events-topic](analytics-events-topic.md)
- [event-consumer](event-consumer.md)
- [weighted-total](weighted-total.md)
<!-- used-by:end -->
