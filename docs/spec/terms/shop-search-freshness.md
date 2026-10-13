---
id: shop-search-freshness
title: Shop search freshness
kind: term
status: draft
aliases: [at once]
defined_for: S32-product-search
rules_hash: 573518296f04
---
# Shop search freshness
## Definition
Shop search freshness is the rule that a seller's own product search shows [catalog changes](catalog-domain-layer.md) at once. A create, rename, archive, restore or delete is visible the moment it completes. This is different from public search, whose index is a [read model](read-model.md) that catches up from events. Sellers expect to see their own edits right away. That reason is design intent (not stated in the spec). The same rule keeps [sandbox shop](sandbox-shop.md) products visible only inside that shop, and it keeps no row of a deleted shop.

## Example
A seller renames "Mug" to "Blue mug" and right away calls `GET /shops/:shopId/products/search?q=blue`. The renamed product is in the results with no waiting. After the seller archives it, it is still listed, now with status [`ARCHIVED`](product-archive.md).

## Known gaps
- The spec does not say how "at once" is achieved. For example, it does not say whether the [shop search table](shop-search-table.md) is written in the [same transaction ↗](../sw-external-terms.md#database-transaction) as the catalog change.
- The spec does not say what a caller sees if that write fails.

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): R-36
- [catalog-domain-layer](catalog-domain-layer.md)
- [read-model](read-model.md)
- [sandbox-shop](sandbox-shop.md)
- [shop-search-table](shop-search-table.md)
<!-- used-by:end -->
