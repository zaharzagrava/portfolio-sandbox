---
id: in-stock-filter
title: inStock filter
kind: term
status: draft
aliases: [instock]
defined_for: S32-product-search
rules_hash: e3b0c44298fc
---
# inStock filter
## Definition
`inStock` is a search filter on `GET /products/search` that keeps only products that are currently in stock. Like every filter, it [combines with the others using AND](search-filters.md) and does not change the relative order of the remaining items. Unlike the category, brand and price groups, it applies to every [search facet](search-facets.md), including the facet of the group being counted.

## Example
`GET /products/search?q=lamp&category=lighting&inStock=true&facets=true` (the `category` value is illustrative)
[The `categories` facet ignores `category=lighting`](facet-self-exclusion.md), but it still counts only in-stock lamps.

## Known gaps
- The spec does not say what "in stock" means exactly (stock above zero, or [stock minus reservations](all-or-nothing-reservation.md)), or how quickly stock changes reach [the search index](search-index.md).
- The spec does not list the accepted values of `inStock` (for example whether `false` means "out of stock only" or "no filter").

## Used by
<!-- used-by:start -->
- [all-or-nothing-reservation](all-or-nothing-reservation.md)
- [facet-self-exclusion](facet-self-exclusion.md)
- [search-facets](search-facets.md)
- [search-filters](search-filters.md)
- [search-index](search-index.md)
<!-- used-by:end -->
