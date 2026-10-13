---
id: autocomplete-source-duration-seconds
title: autocomplete_source_duration_seconds
kind: term
status: draft
aliases: []
defined_for: S33-autocomplete
rules_hash: e3b0c44298fc
---
# autocomplete_source_duration_seconds
## Definition
`autocomplete_source_duration_seconds` is a metric that [S33](../capabilities/S33-autocomplete.md) owns. Its name suggests it records how long each [suggestion source](suggestion-source.md) takes to answer one [`GET /suggest`](get-suggest.md) call. It sits next to `autocomplete_duration_seconds`, which most likely covers the whole request instead of a single source. Use it to see which source is slow, for example when the catalog keeps reaching its [slot budget](slot-budget.md) time limit and shows up as `catalog_timeout` in [`degraded`](degraded.md). Design intent (not stated in the spec): each source has its own time budget, so a per-source timing shows which source uses up the request's time.

## Example
The engine stops answering, and `q=iph` returns within 250 ms with `degraded: ["catalog_timeout"]` (S33.B-08). A dashboard on this metric would then show catalog calls bunched at the catalog budget, while query-index lookups stay fast. The values on such a dashboard are illustrative.

## Known gaps
- The spec does not say the metric's type (histogram or summary), its buckets or its labels, for example whether a `source` label separates query, catalog and typo.
- The spec does not say whether calls that time out, fail, or are skipped because the [circuit breaker ↗](../sw-external-terms.md#circuit-breaker) is open still record a duration, or are tagged with an outcome.
- Not confirmed in the code: the facts list the metric name only under "Owns" and point to no code location that records it.

## Used by
<!-- used-by:start -->
- [slot-budget](slot-budget.md)
- [suggestion-source](suggestion-source.md)
<!-- used-by:end -->
