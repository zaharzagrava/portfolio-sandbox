---
id: clear-filters
title: clearFilters
kind: term
status: draft
aliases: [clear all filters, clear filters]
defined_for: W02-storefront-discovery
rules_hash: e3b0c44298fc
---
# clearFilters
## Definition
`clearFilters` is the function behind the "Clear all filters" action on the search page. It removes every active filter from the search view, which also removes every [filter chip](filter-chip.md). It keeps the query [`q`](autocomplete-q-parameter.md) and the [`sort`](search-sort-order.md) choice. [The address holds the whole search view](search-view-url-state.md), so the change appears as a new address. The page then loads results for that address.

## Example
A shopper is on `/search?q=espresso&sort=price-asc` with a brand facet and a price range active. That makes two chips (the filter values are illustrative).
After "Clear all filters", the address is `/search?q=espresso&sort=price-asc`. The page shows unfiltered results for "espresso" in the same order.

## Known gaps
- The spec does not say whether `clearFilters` also removes [`cursor`](pagination-cursor.md) and returns the shopper to the first page.
- The spec does not say whether `clearFilters` keeps or removes [`semantic`](semantic-search.md) (the "Match by meaning" switch).
- Not confirmed in the code: the function's signature (what it takes and returns) is not given. The facts only cite `packages/web/lib/search/search-view.ts#clearFilters` for rule W02.R-12.

## Used by
<!-- used-by:start -->
- [filter-chip](filter-chip.md)
- [search-view-url-state](search-view-url-state.md)
<!-- used-by:end -->
