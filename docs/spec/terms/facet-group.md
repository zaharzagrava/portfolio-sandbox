---
id: facet-group
title: Facet group
kind: term
status: draft
aliases: [facet groups, group]
defined_for: S32-product-search
rules_hash: 794c58b36c8c
---
# Facet group
## Definition
A facet group is a filter dimension that has its own [facet count](search-facets.md) in the search response. The spec names three groups: category, brand and price. Each group pairs a filter the caller can select with a facet: `categories`, `brands` or `priceRanges`. Facet self-exclusion works per group: a group's facet ignores the caller's selection in that same group but still applies every other filter. [`inStock`](in-stock-filter.md) and [`minRating`](min-rating.md) are filters but not facet groups, so they apply to every facet.

## Example
`GET /products/search?q=lamp&facets=true&category=lighting&inStock=true` (the `category` parameter name and all values are illustrative):
- `facets.categories` belongs to the category group, so it ignores `category=lighting`. It still counts only in-stock products.
- `facets.brands` and `facets.priceRanges` apply both `category=lighting` and `inStock=true`.

## Known gaps
- The spec does not say the query parameter names for the category, brand and price selections.
- The spec does not say whether the `avgRating` facet belongs to a group. It is a facet, but the spec names only category, brand and price as groups.
- The spec does not say whether a caller can select several values in one group, or how the counts work if they do.

## Used by
<!-- used-by:start -->
- [facet-self-exclusion](facet-self-exclusion.md)
- [search-facets](search-facets.md)
<!-- used-by:end -->
