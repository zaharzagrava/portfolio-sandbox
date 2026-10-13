---
id: parse-search-view
title: parseSearchView
kind: term
status: draft
aliases: []
defined_for: W02-storefront-discovery
rules_hash: e3b0c44298fc
---
# parseSearchView
## Definition
`parseSearchView` reads the search page's address and turns it into the search view: query, [facets](search-facets.md), sort and page. It is the code behind the rule that [the address bar fully describes the view](search-view-url-state.md). That rule is why reload, new tab, back and forward all restore the same view. It is also the code behind the rule that the page cleans unknown, [legacy](legacy-url-parameter.md), repeated and out-of-range parameters by [replacing the address ↗](../sw-external-terms.md#history-replace). It lives in `packages/web/lib/search/search-view.ts`, next to [`clearFilters`](clear-filters.md) and [`SEARCH_PAGE_SIZE`](search-page-size.md).

## Example
A shopper reloads `/search?q=espresso&sort=price-asc`. `parseSearchView` reads the query `espresso` and the sort `price-asc`, so the same results come back in the same order.
A shopper opens `/search?q=espresso&q=tea` (illustrative). Because the parameter is repeated, the page replaces the address with a clean one.

## Known gaps
- The spec does not give the function's signature or the exact shape of the view it returns.
- The spec does not say whether `parseSearchView` replaces the address itself or only reports what needs cleaning so the page can do it.
- The spec does not say which value is kept when a parameter is repeated, or how an out-of-range value is handled.

## Used by
<!-- used-by:start -->
- [legacy-url-parameter](legacy-url-parameter.md)
- [search-facets](search-facets.md)
- [search-view-url-state](search-view-url-state.md)
<!-- used-by:end -->
