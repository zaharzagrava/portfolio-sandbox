---
id: search-totals
title: Search totals
kind: term
status: draft
aliases: [total]
defined_for: search-index
rules_hash: 023cf4d3e65c
---
# Search totals
## Definition
Search totals are the counts of matching products reported with a search answer. They are separate from the [items](search-items.md) on the current page. Totals follow the same [visibility rule](search-visibility.md) as items, [facets](search-facets.md) and [semantic results](semantic-search.md). Hidden products are never counted. This means a total never counts a product that the buyer could not reach by paging.

## Example
A buyer searches for "mug" (illustrative). [The index](search-index.md) matches 42 products, and 2 of them are archived (illustrative values). The total in the answer is 40, and only those 40 products appear across the pages of items.

## Known gaps
- The spec does not say whether totals are exact or estimated (some search engines cap or approximate large counts).
- The spec does not say where totals appear in the response or what they are called.
- The spec does not say whether seller search totals follow the same visibility rule for a seller's own hidden products.

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): R-06, R-22, B-17
- [W02](../capabilities/W02-storefront-discovery.md): B-06
- [h1-heading](h1-heading.md)
- [sandbox-product](sandbox-product.md)
- [search-facets](search-facets.md)
- [search-index](search-index.md)
- [search-items](search-items.md)
- [search-visibility](search-visibility.md)
- [semantic-search](semantic-search.md)
<!-- used-by:end -->
