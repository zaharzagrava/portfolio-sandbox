---
id: facet-self-exclusion
title: Facet ignores its own group
kind: term
status: draft
aliases: [ignores its own group]
defined_for: S32-product-search
rules_hash: 711540e1cbbe
---
# Facet ignores its own group
## Definition
Facet self-exclusion is how a [search facet](search-facets.md) counts while filters are applied. Each [facet group](facet-group.md) (category, brand or price) leaves out the caller's own selection in that group. It still applies every other active filter. The [`inStock`](in-stock-filter.md) and [`minRating`](min-rating.md) filters are not facet groups, so they apply to every facet. Search items and totals still use all filters, because only the facet counts leave out their own group. Design intent (not stated in the spec): the caller can still see the other options in the group they filtered on, and how many products each option would return.

## Example
`GET /products/search?q=headphones&facets=true&brand=Acme&inStock=true` (the `brand` parameter name and all values are illustrative):
- `facets.brands` ignores `brand=Acme`, so other brands still show counts. Those counts include only in-stock products.
- `facets.categories` and `facets.priceRanges` apply both `brand=Acme` and `inStock=true`.

## Known gaps
- The spec does not say the query parameter names for the category, brand and price filters.
- The spec does not say whether the `avgRating` facet ignores any selection. It only names category, brand and price as the groups that ignore their own selection.
- The spec does not say how this works when one request selects several values in the same group, or whether it allows that.

## Used by
<!-- used-by:start -->
- [avg-rating-facet](avg-rating-facet.md)
- [facet-group](facet-group.md)
- [in-stock-filter](in-stock-filter.md)
- [price-ranges-facet](price-ranges-facet.md)
- [search-facets](search-facets.md)
<!-- used-by:end -->
