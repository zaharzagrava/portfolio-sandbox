---
id: product-search-route
title: GET /products/search
kind: term
status: draft
aliases: [/products/search]
defined_for: S32-product-search
rules_hash: b3c56a43ed20
---
# GET /products/search
## Definition
`GET /products/search` is the public product search route, used by buyers to find products by text. It supports full-text matching with [typo tolerance](fuzzy-matching.md), [search filters](search-filters.md), [sort orders](search-sort-order.md), [cursor paging](pagination-cursor.md), [facets](search-facets.md) and [semantic mode](search-mode.md). Anonymous callers are allowed and see exactly what authenticated callers see. The route reads only from the [search index](search-index.md) through the [live index name](live-index-alias.md) and never reads the catalog's table. It rejects unknown or invalid parameters, and it answers `[search_unavailable](search-unavailable.md)` when the search engine is unreachable or exceeds the [search budget](search-budget.md).

## Example
An anonymous caller searches with a typo and still finds the product:
```
GET /products/search?q=iphnoe
→ 200
[Cache-Control: private, no-store ↗](../sw-external-terms.md#cache-control-no-store)
{ "items": [ …the iPhone case… ], "[searchId](search-id.md)": "…", "nextCursor": null }
```
`GET /products/search?q=iphone&limit=80` answers `400 validation_failed`, because `limit` must be between 1 and 50.

## Known gaps
- Not confirmed in the code: facets and semantic mode. No test carries their scenario ids (AS-15 to AS-21).
- The spec does not list every accepted query parameter. Only `q`, `limit` and `minRating` are named. The names of the sort and mode parameters are not stated.
- Not confirmed in the code: the facts include no excerpts for the search controller or for `ProductSearchService`. Most rules for this route are backed only by scenario proofs.

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): R-01
- [fuzzy-matching](fuzzy-matching.md)
- [live-index-alias](live-index-alias.md)
- [pagination-cursor](pagination-cursor.md)
- [search-budget](search-budget.md)
- [search-facets](search-facets.md)
- [search-filters](search-filters.md)
- [search-index](search-index.md)
- [search-mode](search-mode.md)
- [search-sort-order](search-sort-order.md)
<!-- used-by:end -->
