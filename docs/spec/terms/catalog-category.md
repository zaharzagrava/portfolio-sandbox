---
id: catalog-category
title: Catalog category
kind: term
status: draft
aliases: [category]
defined_for: S35-trending
rules_hash: 4a084e0e2a90
---
# Catalog category
## Definition
The catalog category is the category that the product catalog records for a product. [The trending endpoint](get-trending.md) treats it as the authority, not the category a client attached to an event. It is read on every [origin request](origin-request.md), so [only the ranking is cached](trending-ranking-cache.md). A product whose catalog category differs from the requested `category` is [left out](search-visibility.md), and each returned item shows its catalog category.

## Example
A client sends a view of a headphone product tagged `garden` (illustrative). `GET /api/trending?category=garden` does not list that product, because its catalog category is `audio`.

## Known gaps
- The spec does not say whether a product counted under the wrong category also gets those points under its real catalog category.
- The spec does not say whether a left-out item is replaced by the next visible one, as [hidden items](search-visibility.md) are.

## Used by
<!-- used-by:start -->
- [S35](../capabilities/S35-trending.md): R-09, B-02
- [all-bucket](all-bucket.md)
- [category-tracking](category-tracking.md)
- [get-trending](get-trending.md)
- [origin-request](origin-request.md)
- [search-visibility](search-visibility.md)
- [trending-ranking-cache](trending-ranking-cache.md)
<!-- used-by:end -->
