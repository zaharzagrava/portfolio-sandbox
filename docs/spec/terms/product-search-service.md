---
id: product-search-service
title: ProductSearchService
kind: term
status: draft
aliases: [productsearchservice.search]
defined_for: S32-product-search
rules_hash: e3b0c44298fc
---
# ProductSearchService
## Definition
`ProductSearchService` is [S32](../capabilities/S32-product-search.md)'s [in-process port](in-process-port.md) for product search. Other parts of the same application call its `search` method directly instead of sending HTTP requests to [`GET /products/search`](product-search-route.md). It sits next to a second in-process port, [`ProductTitleSuggester.suggestTitles`](product-title-suggester.md). The design intent (not stated in the spec) is that callers inside the application get search results without going through the public route's HTTP layer.

## Example
A module inside the application needs matching products for the text "iphone". It calls `ProductSearchService.search` instead of calling `GET /products/search` over HTTP.

## Known gaps
- The spec does not say what `search` accepts or returns, or whether its result matches [`productSearchResponseSchema`](product-search-response-schema.md).
- The spec does not say whether the port applies the same visibility rules, rate limit policy and [search budget](search-budget.md) as the public route.
- Not confirmed in the code: the exported services (AS-78, AS-79) have no test that carries their scenario ids, and the facts do not explain what "R1" in the entry-point list refers to.

## Used by
<!-- used-by:start -->
- [in-process-port](in-process-port.md)
- [search-budget](search-budget.md)
- [search-unavailable](search-unavailable.md)
<!-- used-by:end -->
