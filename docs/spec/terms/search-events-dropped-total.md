---
id: search-events-dropped-total
title: search_events_dropped_total
kind: term
status: draft
aliases: []
defined_for: S32-product-search
rules_hash: e3b0c44298fc
---
# search_events_dropped_total
## Definition
`search_events_dropped_total` is a [counter metric ↗](../sw-external-terms.md#counter-metric). It rises when a search or click event cannot be emitted because [the event stream is down](event-backbone.md). Search and click requests do not fail in that case: a search still answers `200` and a click still answers `202`. The metric is how operators find out that analytics events were lost. Keeping search available matters more than recording analytics, which is design intent (not stated in the spec).

## Example
The event stream is unreachable for a while, and during that time 50 buyers call [`GET /products/search`](product-search-route.md). All of them get `200` with results, and `search_events_dropped_total` goes up by 50. (The numbers are illustrative.)

## Known gaps
- The spec does not say whether dropped events are buffered and retried later, or lost for good.
- The spec does not say what [labels ↗](../sw-external-terms.md#metric-labels) the metric has, for example whether it separates [`search.performed`](search-performed-event.md) from [`search.result_clicked`](search-result-clicked-event.md).

## Used by
<!-- used-by:start -->
- [event-backbone](event-backbone.md)
<!-- used-by:end -->
