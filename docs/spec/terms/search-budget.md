---
id: search-budget
title: Search budget
kind: term
status: draft
aliases: [1 s search budget]
defined_for: S32-product-search
rules_hash: 51e7d71b871b
---
# Search budget
## Definition
The search budget is the maximum time a product search may wait for the [search engine](search-engine.md). It is set in [S32's configuration](../capabilities/S32-product-search.md) and is separate from the time limit used for turning text into vectors. If the engine does not answer within the budget, or cannot be reached, the search stops waiting and returns [`search_unavailable`](search-unavailable.md). The design intent (not stated in the spec) is that a slow engine causes a quick, clear failure instead of requests piling up.

## Example
A buyer calls `GET /products/search?q=iphone`. The engine is still working after the 1 s budget, so the call returns this:
```
HTTP/1.1 503 Service Unavailable
Retry-After: 1

{ "code": "search_unavailable", ... }
```

## Known gaps
- The spec does not say whether the budget covers only the engine call or the whole request, including validation and logging.
- The spec does not say whether the shop search route `GET /shops/:shopId/products/search` and the in-process `ProductSearchService.search` port use the same budget.
- The spec does not say how the search budget and the embedding budget work together in [semantic mode](search-mode.md).

## Used by
<!-- used-by:start -->
- [S34](../capabilities/S34-recommendations.md): R-13
- [S35](../capabilities/S35-trending.md): R-13
- [embedding-budget](embedding-budget.md)
- [in-process-port](in-process-port.md)
- [product-search-route](product-search-route.md)
- [product-search-service](product-search-service.md)
- [search-engine](search-engine.md)
- [search-mode](search-mode.md)
- [search-unavailable](search-unavailable.md)
- [suggestion-source](suggestion-source.md)
<!-- used-by:end -->
