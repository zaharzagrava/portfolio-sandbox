---
id: shop-status
title: Shop status
kind: term
status: draft
aliases: [`deleted`, `deleting`, deleted, deleting, suspended]
defined_for: search-index
rules_hash: b3e053258306
---
# Shop status
## Definition
Shop status is the lifecycle state of a shop, and the [search index](search-index.md) uses it to [hide products](search-visibility.md). When a shop is `SUSPENDED`, `DELETING` or `DELETED`, all of its products are hidden from search. A suspended or offboarding shop also hides products that are created later. The index learns of these changes from [catalog events](event-definition.md) and never reads the catalog's table.

## Example
Shop "shop-42" (illustrative) moves to `SUSPENDED`. Its existing products disappear from items, totals, [facets](search-facets.md) and [semantic results](semantic-search.md). A product the shop creates afterwards never shows up either.

## Known gaps
- The spec does not list every shop status, or which status means a shop can be shown.
- The spec does not say whether "offboarding" is the same thing as `DELETING`.
- The spec does not say whether products show again when a shop leaves `SUSPENDED`.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): R-01, R-15, B-01, B-14
- [S05](../capabilities/S05-products.md): B-01
- [S32](../capabilities/S32-product-search.md): R-16
- [S34](../capabilities/S34-recommendations.md): R-03
- [search-index](../concepts/search-index.md): C-05
- [apply-verification](apply-verification.md)
- [batch-shops-lookup](batch-shops-lookup.md)
- [event-definition](event-definition.md)
- [live-shop](live-shop.md)
- [post-shops](post-shops.md)
- [product-not-found](product-not-found.md)
- [role-permission-matrix](role-permission-matrix.md)
- [search-facets](search-facets.md)
- [search-index](search-index.md)
- [search-visibility](search-visibility.md)
- [semantic-search](semantic-search.md)
- [shop-verification](shop-verification.md)
- [tenancy-domain-layer](tenancy-domain-layer.md)
- [view-count-flush](view-count-flush.md)
<!-- used-by:end -->
