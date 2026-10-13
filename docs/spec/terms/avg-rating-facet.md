---
id: avg-rating-facet
title: avgRating facet
kind: term
status: draft
aliases: [avgrating]
defined_for: S32-product-search
rules_hash: e3b0c44298fc
---
# avgRating facet
## Definition
`avgRating` is one member of the [`facets` object](search-facets.md) of a product search response. It holds the mean rating of every product that matches the search, not only those on the current page. It is rounded and is `null` when nothing matches. It is not a [selectable group](facet-self-exclusion.md), so it respects every [active filter](search-filters.md), including [`inStock`](in-stock-filter.md) and [`minRating`](min-rating.md).

## Example
`GET /products/search?q=kettle&facets=true&minRating=4` → `"avgRating": 4.37` (illustrative)
`GET /products/search?q=zzzzqx&facets=true` → `"avgRating": null` (nothing matches)

## Known gaps
- The spec does not say whether products with no ratings count as zero or are left out of the mean.
- The spec does not say whether the mean is over each product's average rating or over all individual reviews.

## Used by
<!-- used-by:start -->
- [facet-self-exclusion](facet-self-exclusion.md)
- [search-facets](search-facets.md)
- [search-filters](search-filters.md)
<!-- used-by:end -->
