---
id: sandbox-product
title: Sandbox product
kind: term
status: draft
aliases: [sandbox products]
defined_for: search-index
rules_hash: 40195b7b27b4
---
# Sandbox product
## Definition
A sandbox product is a product in the sandbox state in the catalog. [The search index](search-index.md) treats it like an archived or deleted product. It must not appear in the list of matching products, in the result counts, in [facets](search-facets.md), or in results found by meaning.

## Example
A seller has a product marked as sandbox (illustrative). A buyer search that would otherwise match it returns no item for it, and the facet counts do not include it.

## Known gaps
- The spec does not say what a sandbox product is, who creates one, or why it exists.
- The spec does not say which catalog event or field marks a product as sandbox.
- The spec does not say whether a seller can see their own sandbox products in seller search.

## Used by
<!-- used-by:start -->
- [S05](../capabilities/S05-products.md): R-12, B-07
- [S10](../capabilities/S10-cart-checkout.md): B-09
- [S32](../capabilities/S32-product-search.md): R-06, R-15
- [S34](../capabilities/S34-recommendations.md): R-03
- [S35](../capabilities/S35-trending.md): R-08
- [W02](../capabilities/W02-storefront-discovery.md): R-18
- [search-index](../concepts/search-index.md): C-04
- [known-gaps](known-gaps.md)
- [product-not-found](product-not-found.md)
- [search-facets](search-facets.md)
- [search-index](search-index.md)
- [search-items](search-items.md)
- [search-totals](search-totals.md)
- [search-visibility](search-visibility.md)
- [semantic-search](semantic-search.md)
- [shop-search-table](shop-search-table.md)
<!-- used-by:end -->
