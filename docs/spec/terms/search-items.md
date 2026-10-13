---
id: search-items
title: Search items
kind: term
status: draft
aliases: [item]
defined_for: search-index
rules_hash: 6899751155af
---
# Search items
## Definition
Search items are the products returned in a search answer, in the order of results. [S32](../capabilities/S32-product-search.md) serves them for both buyer search and seller search, with paging, ranking and filters. Each answer follows one [total order](search-total-order.md). Items never include [hidden products](search-visibility.md): archived, [sandbox](sandbox-product.md) and deleted products, or products of [`SUSPENDED`](shop-status.md), `DELETING` or `DELETED` shops.

## Example
A buyer searches for "mug" (illustrative). The index matches three mugs, and one of them belongs to a shop whose status is `SUSPENDED`. The items in the answer list only the other two mugs, in the answer's total order.

## Known gaps
- The spec does not say what fields each item carries or what the response looks like.
- The spec does not say how paging works, such as the page size or whether it uses cursors or offsets.
- The spec does not say which field breaks ties so that the order stays total.

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): B-21
- [image-url](image-url.md)
- [product-search-response-schema](product-search-response-schema.md)
- [sandbox-product](sandbox-product.md)
- [search-total-order](search-total-order.md)
- [search-totals](search-totals.md)
- [search-visibility](search-visibility.md)
- [sponsorship-event](sponsorship-event.md)
<!-- used-by:end -->
