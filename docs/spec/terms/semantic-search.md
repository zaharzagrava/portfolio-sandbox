---
id: semantic-search
title: Semantic search
kind: term
status: draft
aliases: [semantic results, semantic_query]
defined_for: search-index
rules_hash: e743cf3dafd9
---
# Semantic search
## Definition
Semantic search is the part of product search that finds products by meaning rather than exact words. [S32](../capabilities/S32-product-search.md) lists [k-NN ↗](../sw-external-terms.md#knn-search) among its features. Semantic results follow the same [search visibility rule](search-visibility.md) as text results, so hidden products must not appear in them.

## Example
A buyer searches for "warm winter jacket" (illustrative). The semantic results may include close matches that use different words, but never an archived product or a product of a [`SUSPENDED` shop](shop-status.md).

## Known gaps
- The spec does not say how the vectors are produced or stored, or how many neighbours a query returns.
- The spec does not say how semantic results are combined with text results and [relevance boosts](relevance-boost.md) in the [single total order](search-totals.md).

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): R-06
- [W02](../capabilities/W02-storefront-discovery.md): B-11, B-12
- [search-index](../concepts/search-index.md): C-04
- [embedding-budget](embedding-budget.md)
- [embedding-provider](embedding-provider.md)
- [h1-heading](h1-heading.md)
- [lexical-search](lexical-search.md)
- [pending-embedding](pending-embedding.md)
- [price-only-update](price-only-update.md)
- [product-embedding-vector](product-embedding-vector.md)
- [relevance-boost](relevance-boost.md)
- [sandbox-product](sandbox-product.md)
- [search-mode](search-mode.md)
- [search-page-size](search-page-size.md)
- [search-page](search-page.md)
- [search-totals](search-totals.md)
- [search-view-url-state](search-view-url-state.md)
- [search-visibility](search-visibility.md)
- [semantic-requires-query](semantic-requires-query.md)
- [shop-status](shop-status.md)
- [unsupported-combination](unsupported-combination.md)
<!-- used-by:end -->
