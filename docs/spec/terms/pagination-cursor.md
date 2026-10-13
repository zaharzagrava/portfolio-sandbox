---
id: pagination-cursor
title: Pagination cursor (nextCursor)
kind: term
status: draft
aliases: [cursor, nextcursor]
defined_for: S03-shops-rbac
rules_hash: d5c41912858b
---
# Pagination cursor (nextCursor)
## Definition
`nextCursor` is an [opaque value](pagination-cursor.md) returned with a page of a [cursor-paginated list](pagination-cursor.md). The client sends it back to get the next page. It must not parse it or build it by hand. When there are no more items, `nextCursor` is `null`.

## Example
A user belongs to three [shops](shop-tenant.md). [`GET /shops/mine?limit=2`](get-shops-mine.md) returns two shops and a `nextCursor` (for example `"eyJ..."`, illustrative). Requesting the next page with that cursor returns the third shop and `"nextCursor": null`.

## Known gaps
- The spec does not name the query parameter that carries the cursor back.
- The spec does not say how items are ordered, whether a cursor expires, or what the default and maximum `limit` are.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): B-04
- [S05](../capabilities/S05-products.md): R-10
- [S32](../capabilities/S32-product-search.md): R-10
- [get-shops-mine](get-shops-mine.md)
- [invalid-cursor](invalid-cursor.md)
- [payments-domain-layer](payments-domain-layer.md)
- [product-search-route](product-search-route.md)
- [search-mode](search-mode.md)
- [search-page](search-page.md)
- [search-sort-order](search-sort-order.md)
- [shop-tenant](shop-tenant.md)
<!-- used-by:end -->
