---
id: search-degraded-total
title: search_degraded_total
kind: term
status: draft
aliases: []
defined_for: S32-product-search
rules_hash: e3b0c44298fc
---
# search_degraded_total
## Definition
`search_degraded_total` is a metric that S32 owns. Its name suggests it counts searches that were answered in a reduced form rather than failing. It is a different metric from `search_unavailable_total`, which tracks searches that fail with `search_unavailable`. S32 lists semantic search "and its degradation" as known behavior, so this counter most likely tracks that fallback. That link is a guess from the names and the spec does not state it.

## Example
A caller uses semantic mode on `GET /products/search`. Building the query's embedding takes longer than the embedding budget. You would expect the search to still answer `200` in a reduced form, and `search_degraded_total` to go up by one. This scenario is illustrative and the facts do not confirm it.

## Known gaps
- Not confirmed in the code: the facts give this metric's name only. They do not show which code increases it, or what event or condition counts as "degraded".
- The spec does not say how a degraded search shows up in the response, for example whether it carries a marker. The degradation scenarios (AS-18 to AS-21) have no tests.
- The spec does not say what labels the metric has, for example route, mode or reason.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
