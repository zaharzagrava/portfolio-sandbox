---
id: filter-chip
title: Filter chip
kind: term
status: draft
aliases: [chips]
defined_for: W02-storefront-discovery
rules_hash: 0951e51cd517
---
# Filter chip
## Definition
A filter chip is a small removable label for one active filter on the search page. Each active filter (a [facet value](search-facets.md) or a price range, for example) gets its own chip. Removing a chip removes that filter from the [address](search-view-url-state.md), which updates the results. "Clear all filters" removes every chip at once but keeps [`q`](autocomplete-q-parameter.md) and [`sort`](search-sort-order.md).

## Example
On `/search?q=espresso` with a brand facet and a price range active, two chips appear. Removing the brand chip keeps `q=espresso` and the price filter. "Clear all filters" leaves only `q=espresso` (and `sort`, if one was set).

## Known gaps
- The spec does not say whether removing a chip also drops the [`cursor`](pagination-cursor.md) and goes back to the first page.
- Not confirmed in the code: no component or symbol for the chip is named. Only [`clearFilters`](clear-filters.md) in `packages/web/lib/search/search-view.ts` is cited, for "Clear all filters".

## Used by
<!-- used-by:start -->
- [W02](../capabilities/W02-storefront-discovery.md): B-08
- [clear-filters](clear-filters.md)
- [search-facets](search-facets.md)
- [search-view-url-state](search-view-url-state.md)
<!-- used-by:end -->
