---
id: min-rating
title: minRating
kind: term
status: draft
aliases: []
defined_for: S32-product-search
rules_hash: e3b0c44298fc
---
# minRating
## Definition
`minRating` is a query parameter of the public product search route, [`GET /products/search`](product-search-route.md). It is one of the [search filters](search-filters.md): it keeps only products whose rating reaches the given minimum. Like every filter, it combines with the other filters using AND. It only removes items, so the remaining items keep their [relative order](search-total-order.md). A value outside the allowed range is rejected with [`validation_failed`](validation-failed-error.md).

## Example
`GET /products/search?q=iphone&minRating=4` returns only matching products rated at least 4. They come back in the same relative order as `q=iphone` without the filter. The value 4 is illustrative.
`GET /products/search?q=iphone&minRating=7` answers `400 validation_failed`, because `minRating` must be between 0 and 5.

## Known gaps
- The spec does not say whether the minimum is inclusive, or whether decimal values such as `3.5` are accepted.
- The spec does not say how products with no rating yet are handled. They may be excluded, or treated as rating 0.
- The spec does not say whether the shop search route, [`GET /shops/:shopId/products/search`](shop-product-search-route.md), also accepts `minRating`.

## Used by
<!-- used-by:start -->
- [search-filters](search-filters.md)
- [search-total-order](search-total-order.md)
<!-- used-by:end -->
