---
id: search-facets
title: Search facets
kind: term
status: draft
aliases: [facet]
defined_for: job-scheduler-lease
rules_hash: 7fa48066c6a9
---
# Search facets
## Definition
Search facets are the filter groups shown next to search results, built from product attributes. Each value usually shows how many matching products have it. They are one feature of the [S32 product search](../capabilities/S32-product-search.md) capability. Other features of that capability include ranking certain results higher, matching words with the same meaning, and [k-NN search ↗](../sw-external-terms.md#knn-search). The spec names the feature but does not list the attributes used as facets.

## Example
Illustrative only. A search for "running shoes" returns results plus facets such as `brand: Acme (12), Zoom (7)` and `size: 42 (5), 43 (9)`. Picking "Acme" narrows the results to those 12 products.

## Known gaps
- The spec does not say which product attributes are available as facets, or whether shops can add their own.
- The spec does not say whether facet counts are exact or approximate.
- The spec does not say how facets behave with k-NN (vector) search results.

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): R-06
- [W02](../capabilities/W02-storefront-discovery.md): R-08, R-10, B-12
- [search-index](../concepts/search-index.md): C-04
- [business-score](business-score.md)
- [category-shortcuts](category-shortcuts.md)
- [filter-chip](filter-chip.md)
- [parse-search-view](parse-search-view.md)
- [product-search-route](product-search-route.md)
- [relevance-boost](relevance-boost.md)
- [sandbox-product](sandbox-product.md)
- [search-filters](search-filters.md)
- [search-index](search-index.md)
- [search-page](search-page.md)
- [search-synonyms](search-synonyms.md)
- [search-totals](search-totals.md)
- [search-view-url-state](search-view-url-state.md)
- [search-visibility](search-visibility.md)
- [shop-status](shop-status.md)
<!-- used-by:end -->
