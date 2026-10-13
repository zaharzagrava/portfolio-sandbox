---
id: search-unavailable-total
title: search_unavailable_total
kind: term
status: draft
aliases: [search_unavailable_total metric]
defined_for: S32-product-search
rules_hash: e3b0c44298fc
---
# search_unavailable_total
## Definition
`search_unavailable_total` is a metric owned by [S32](../capabilities/S32-product-search.md). Judging by its name, it counts searches that fail because the [search engine](search-engine.md) is unreachable or too slow. S32 also owns [`search_degraded_total`](search-degraded-total.md), which is a separate metric. Operators can watch this counter to see engine outages as users experience them.

## Example
During an engine outage, every call to [`GET /products/search`](product-search-route.md) returns `503` with [`code: "search_unavailable"`](search-unavailable.md). You would expect `search_unavailable_total` to rise with each of these calls (illustrative; this is not confirmed by the facts).

## Known gaps
- Not confirmed in the code: the facts list this metric by name only and do not show which code increases it or when.
- The spec does not say what labels the metric has, for example route, public search versus shop search, or reason (unreachable versus over budget).
- The spec does not say how this metric differs from `search_degraded_total`.

## Used by
<!-- used-by:start -->
- [search-engine](search-engine.md)
<!-- used-by:end -->
