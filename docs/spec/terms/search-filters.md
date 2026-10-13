---
id: search-filters
title: Search filters
kind: term
status: draft
aliases: [filter]
defined_for: S32-product-search
rules_hash: 2feb73266d1c
---
# Search filters
## Definition
Search filters narrow the results to products that meet extra conditions, such as a minimum rating ([`minRating`](min-rating.md)). When several filters are given, a product must pass all of them, so they [combine with AND ↗](../sw-external-terms.md#boolean-operators). A filter only removes items: the items that remain keep the same order they had without the filter. Invalid filter values are rejected with [`validation_failed`](validation-failed-error.md).

## Example
`GET /products/search?q=iphone&minRating=4` returns only matching products rated 4 or higher, in the same relative order as `q=iphone` alone. `minRating=7` answers `400 validation_failed`, because the allowed range is 0–5.

## Known gaps
- The spec does not list every filter parameter. `minRating` is the only one named.
- The spec does not say how filters affect [search facets](search-facets.md), and facets have no tests.

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): R-08
- [W02](../capabilities/W02-storefront-discovery.md): B-08
- [major-units](major-units.md)
- [min-rating](min-rating.md)
- [parse-price-input](parse-price-input.md)
- [product-search-route](product-search-route.md)
- [search-facets](search-facets.md)
- [zero-result-rate](zero-result-rate.md)
<!-- used-by:end -->
