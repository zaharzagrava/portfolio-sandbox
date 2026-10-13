---
id: price-ranges-facet
title: priceRanges facet
kind: term
status: draft
aliases: [priceranges]
defined_for: S32-product-search
rules_hash: e3b0c44298fc
---
# priceRanges facet
## Definition
`priceRanges` is one group inside the [`facets`](search-facets.md) object of a product search response. It counts matching products in fixed price buckets. The buckets are always present and always in the same order, even when a bucket matches nothing. Counts cover all matches, not just the current page. [The facet ignores the caller's own price selection](facet-self-exclusion.md) but respects every other filter, including [`inStock`](in-stock-filter.md) and [`minRating`](min-rating.md).

## Example
`GET /products/search?q=headphones&facets=true&maxPrice=50` (the parameter `maxPrice` and all counts are illustrative):
```json
"priceRanges": [
  { "key": "under_25", "count": 14 },
  { "key": "25_to_50", "count": 31 },
  { "key": "50_to_100", "count": 22 },
  { "key": "over_100", "count": 9 }
]
```
The buckets above the price selection still show counts because the facet ignores its own group.

## Known gaps
- The spec does not say whether a bucket's boundaries are inclusive or exclusive. For example, it does not say which bucket a product priced exactly 25 falls into.
- The spec does not say whether the bucket boundaries are in [major units](major-units.md) or minor units, or which currency they assume.
- The spec does not give the exact JSON shape of a bucket entry (array of `{key, count}` or a keyed object). The shape shown above is illustrative.

## Used by
<!-- used-by:start -->
- [facet-self-exclusion](facet-self-exclusion.md)
- [major-units](major-units.md)
<!-- used-by:end -->
