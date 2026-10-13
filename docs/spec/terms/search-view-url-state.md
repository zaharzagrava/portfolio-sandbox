---
id: search-view-url-state
title: Search view URL state
kind: term
status: draft
aliases: [address, address bar]
defined_for: W02-storefront-discovery
rules_hash: 7472346a6855
---
# Search view URL state
## Definition
Search view URL state means the address of [`/search`](search-page.md) holds everything needed to rebuild the current search view. That includes the query, the active [facets](search-facets.md), the sort and the page. Reloading, opening a new tab, or pressing back or forward must restore the same view. `parseSearchView` in `packages/web/lib/search/search-view.ts` reads the address. If the address is messy, the same function cleans it. The decision behind this is stated in the spec: views can be shared and restored.

## Example
```
/search?q=espresso&sort=price-asc&[cursor](pagination-cursor.md)=<nextCursor>
```
This address shows results for "espresso", sorted by price, on the page that follows the cursor. The `sort` value is illustrative. When the default sort is chosen, `sort` is left out of the address. "Clear all filters" removes the facets but keeps `q` and `sort`.

## Known gaps
- The spec does not name the query parameters used for each facet or for the price range.
- The spec does not say whether "Available for pickup near me" is recorded in the address. [Pickup coordinates](pickup-coordinates.md) themselves stay in memory and are never written to the address.
- The spec only shows "[Match by meaning](semantic-search.md)" as `semantic=true`. It does not confirm that this is a parameter in the page address, as opposed to the API request.

## Used by
<!-- used-by:start -->
- [W02](../capabilities/W02-storefront-discovery.md): R-08
- [clear-filters](clear-filters.md)
- [filter-chip](filter-chip.md)
- [legacy-url-parameter](legacy-url-parameter.md)
- [major-units](major-units.md)
- [parse-search-view](parse-search-view.md)
- [pickup-coordinates](pickup-coordinates.md)
- [pickup-near-me](pickup-near-me.md)
- [search-facets](search-facets.md)
- [semantic-search](semantic-search.md)
- [server-rendered-search](server-rendered-search.md)
<!-- used-by:end -->
