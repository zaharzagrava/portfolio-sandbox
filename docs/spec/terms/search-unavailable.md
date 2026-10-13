---
id: search-unavailable
title: search_unavailable (503)
kind: term
status: draft
aliases: [search_unavailable]
defined_for: S32-product-search
rules_hash: e3b0c44298fc
---
# search_unavailable (503)
## Definition
`search_unavailable` is the error code public search returns with `503` when it cannot get an answer from the [search engine](search-engine.md) in time. This happens when the engine is unreachable or the query runs past the [search budget](search-budget.md). The response carries a [`Retry-After` header ↗](../sw-external-terms.md#retry-after), so clients know when to try again. Search [fails fast ↗](../sw-external-terms.md#fail-fast) with a clear error and does not hang. This is design intent (not stated in the spec): it keeps engine outages from piling up slow requests.

## Example
The engine does not answer within the 1 s search budget:
```
HTTP/1.1 503 Service Unavailable
Retry-After: 1

{ "code": "search_unavailable", ... }
```

## Known gaps
- Not confirmed in the code: the [`search_unavailable_total`](search-unavailable-total.md) metric is listed in [S32's metrics](../capabilities/S32-product-search.md), but the facts do not show that it counts these responses.
- The spec does not say whether the shop search route and the in-process [`ProductSearchService.search` port](product-search-service.md) report engine failure the same way.

## Used by
<!-- used-by:start -->
- [product-search-service](product-search-service.md)
- [search-budget](search-budget.md)
- [search-engine](search-engine.md)
<!-- used-by:end -->
