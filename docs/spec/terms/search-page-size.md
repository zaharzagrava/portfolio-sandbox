---
id: search-page-size
title: SEARCH_PAGE_SIZE
kind: term
status: draft
aliases: [search page size]
defined_for: W02-storefront-discovery
rules_hash: e3b0c44298fc
---
# SEARCH_PAGE_SIZE
## Definition
`SEARCH_PAGE_SIZE` is the constant that sets how many results the search page shows on one page. It is the code behind rule W02.R-13, which fixes the page size and requires paging through a [`cursor`](pagination-cursor.md) in the address. It lives in `packages/web/lib/search/search-view.ts`, next to [`parseSearchView`](parse-search-view.md) and [`clearFilters`](clear-filters.md). The page size never appears in the address, so a shopper cannot change it. Only the cursor moves the view from one page to the next.

## Example
`/search?q=espresso` shows the first 24 result cards. The response also includes a [`nextCursor`](pagination-cursor.md), so "Next page" opens:
```
/search?q=espresso&cursor=eyJvIjoyNH0   (cursor value is illustrative)
```

## Known gaps
- The spec does not say whether `SEARCH_PAGE_SIZE` is sent to the search API as the request limit, or only used by the page.
- The spec does not say whether "[Match by meaning](semantic-search.md)" uses the same size for its single page of closest matches.

## Used by
<!-- used-by:start -->
- [semantic-search](semantic-search.md)
<!-- used-by:end -->
