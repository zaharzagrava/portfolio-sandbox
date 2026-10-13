---
id: search-sort-order
title: Search sort order
kind: term
status: draft
aliases: [newest, price-asc, price-desc]
defined_for: S32-product-search
rules_hash: a836c759dd46
---
# Search sort order
## Definition
The sort order is the `sort` parameter that the caller picks for a search. The named orders are `price-asc`, `price-desc` and `newest`. Every order ends in `id` ascending, so equal values always come back in the same [total order](search-total-order.md). [The opaque cursor is bound to the sort](pagination-cursor.md), so changing `sort` partway through paging fails with `[invalid_cursor](invalid-cursor.md)`.

## Example
Products priced 100, 100, 250, 500 and 900 are searched with `sort=price-asc`. The result is 100, 100, 250, 500, 900, and the two 100s are ordered by `id` ascending.

## [Known gaps](known-gaps.md)
- The spec does not list the full set of sort values, and it does not name the default order when `q` is present and no `sort` is given.
- The spec does not say which field `newest` is based on (for example, creation time or publish time).

## Used by
<!-- used-by:start -->
- [W02](../capabilities/W02-storefront-discovery.md): B-07
- [browse-mode](browse-mode.md)
- [known-gaps](known-gaps.md)
- [pagination-cursor](pagination-cursor.md)
- [product-search-route](product-search-route.md)
- [search-total-order](search-total-order.md)
<!-- used-by:end -->
