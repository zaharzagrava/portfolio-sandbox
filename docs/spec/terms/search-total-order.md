---
id: search-total-order
title: Total order (search results)
kind: term
status: draft
aliases: [one total order, total order]
defined_for: search-index
rules_hash: c9ab9c119c1f
---
# Total order (search results)
## Definition
The total order is the guarantee that every search answer ranks the products it returns in one fixed, complete sequence. No two results are left "equal" with an undefined position. [S32](../capabilities/S32-product-search.md) applies it to buyer search and seller search, together with ranking, filters and paging. Design intent (not stated in the spec): a fixed order means results don't repeat or go missing across pages, and the same query over the same [index data](search-index.md) returns results in the same order.

## Example
A buyer searches for "mug". Two mugs get the same relevance score (illustrative). The total order still puts one of them first, and it does so every time. When the buyer moves from page 1 to page 2, neither mug shows twice and neither is skipped.

## Known gaps
- The spec does not say which field breaks ties when ranking leaves two items equal.
- The spec does not say whether the order stays the same across a [reindex cutover](cutover.md) from the old index to the new index.
- The spec does not say how [relevance boosts](relevance-boost.md), sort options and filters combine to produce the final order.

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): R-09, R-35, B-06, B-23
- [S34](../capabilities/S34-recommendations.md): R-18, B-08
- [browse-mode](browse-mode.md)
- [cutover](cutover.md)
- [fuzzy-matching](fuzzy-matching.md)
- [hops](hops.md)
- [invalid-cursor](invalid-cursor.md)
- [min-rating](min-rating.md)
- [relevance-boost](relevance-boost.md)
- [search-index](search-index.md)
- [search-items](search-items.md)
- [search-sort-order](search-sort-order.md)
- [suggest-ordering](suggest-ordering.md)
<!-- used-by:end -->
