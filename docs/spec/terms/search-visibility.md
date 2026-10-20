---
id: search-visibility
title: Search visibility (hidden products)
kind: term
status: draft
aliases: [hidden, hide]
defined_for: search-index
rules_hash: 43907ed9b899
---
# Search visibility (hidden products)
## Definition
Search visibility is the rule that decides which products the [search index](search-index.md) may show. Products that are archived, used only for testing, or deleted are hidden. Products are also hidden while their shop is in a state that requires its products to be hidden. A hidden product must not appear in items, totals, [facets](search-facets.md) or semantic results. A deleted product stays hidden even when late events arrive with an [aggregateVersion](aggregate-version.md) at or below the delete version.

## Example
A product is deleted at version 7. A delayed update event for the same product then arrives with version 6. The index ignores and counts that event, and the product stays out of buyer and seller search answers.

## Known gaps
- The spec does not say whether hidden products are removed from the index or kept and filtered out at query time.
- The spec does not say what happens to a deleted product when an event arrives with a version above the delete version.
- The spec does not say how quickly a shop's suspension takes effect on products that are already in the index. The search.backfill-shop-state job may be involved, but the facts do not link it.

## Used by
<!-- used-by:start -->
- [J02](../capabilities/J02-seller-to-first-sale.md): B-11, B-13
- [S05](../capabilities/S05-products.md): B-13
- [S32](../capabilities/S32-product-search.md): R-16, R-45, B-01, B-09, B-10
- [S33](../capabilities/S33-autocomplete.md): R-11
- [S34](../capabilities/S34-recommendations.md): R-06, R-13, B-04, B-10
- [S35](../capabilities/S35-trending.md): R-08, R-11, B-06
- [S48](../capabilities/S48-bff.md): B-06
- [W02](../capabilities/W02-storefront-discovery.md): R-18
- [search-index](../concepts/search-index.md): C-03, C-05
- [aggregate-version](aggregate-version.md)
- [batch-products-lookup](batch-products-lookup.md)
- [catalog-category](catalog-category.md)
- [catalog-domain-layer](catalog-domain-layer.md)
- [catalog-title-source-adapter](catalog-title-source-adapter.md)
- [get-trending](get-trending.md)
- [in-process-port](in-process-port.md)
- [no-padding](no-padding.md)
- [not-found-error](not-found-error.md)
- [origin-request](origin-request.md)
- [pending-embedding](pending-embedding.md)
- [product-title-suggester](product-title-suggester.md)
- [products-ids-query](products-ids-query.md)
- [recommendation-rail](recommendation-rail.md)
- [sandbox-product](sandbox-product.md)
- [search-facets](search-facets.md)
- [search-index](search-index.md)
- [search-items](search-items.md)
- [search-totals](search-totals.md)
- [semantic-search](semantic-search.md)
- [shop-status](shop-status.md)
- [trending-limit](trending-limit.md)
- [trending-ranking-cache](trending-ranking-cache.md)
<!-- used-by:end -->
