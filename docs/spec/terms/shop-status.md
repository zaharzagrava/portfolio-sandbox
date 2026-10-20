---
id: shop-status
title: Shop status
kind: term
status: draft
aliases: [`deleted`, `deleting`, deleted, deleting, suspended]
defined_for: search-index
rules_hash: 90fa10f76c1e
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
- [J02](../capabilities/J02-seller-to-first-sale.md): R-13, B-13
- [J04](../capabilities/J04-catalog-sync-to-search.md): R-10, R-19, B-20
- [S03](../capabilities/S03-shops-rbac.md): R-01, R-26, B-14, B-22, B-23, B-24
- [S05](../capabilities/S05-products.md): R-10, R-23, B-01, B-20
- [S32](../capabilities/S32-product-search.md): R-16
- [S34](../capabilities/S34-recommendations.md): R-03
- [search-index](../concepts/search-index.md): C-05
- [apply-verification](apply-verification.md)
- [batch-shops-lookup](batch-shops-lookup.md)
- [catalog-imports-queue](catalog-imports-queue.md)
- [event-definition](event-definition.md)
- [get-product-by-id](get-product-by-id.md)
- [get-shop-export](get-shop-export.md)
- [live-shop](live-shop.md)
- [near-me-index](near-me-index.md)
- [platform-admin](platform-admin.md)
- [post-shops](post-shops.md)
- [product-not-found](product-not-found.md)
- [role-permission-matrix](role-permission-matrix.md)
- [scheduled-pull](scheduled-pull.md)
- [search-facets](search-facets.md)
- [search-index](search-index.md)
- [search-visibility](search-visibility.md)
- [semantic-search](semantic-search.md)
- [shop-offboarding](shop-offboarding.md)
- [shop-purge-due](shop-purge-due.md)
- [shop-purge-job](shop-purge-job.md)
- [shop-status-changed-event](shop-status-changed-event.md)
- [shop-status-consumer](shop-status-consumer.md)
- [shop-status-history](shop-status-history.md)
- [shop-verification](shop-verification.md)
- [shopify-import](shopify-import.md)
- [shopify-push-pull](shopify-push-pull.md)
- [shopify-scheduled-pull](shopify-scheduled-pull.md)
- [tenancy-domain-layer](tenancy-domain-layer.md)
- [view-count-flush](view-count-flush.md)
<!-- used-by:end -->
