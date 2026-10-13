---
id: invalid-cursor
title: invalid_cursor
kind: term
status: draft
aliases: []
defined_for: S32-product-search
rules_hash: e3b0c44298fc
---
# invalid_cursor
## Definition
`invalid_cursor` is the error code that public product search returns when a paging cursor cannot be used. Each [opaque cursor](pagination-cursor.md) is tied to the `(q, [filters](search-filters.md), sort, [mode](search-mode.md))` of the search that produced it. If a client edits the cursor, or sends it with a different query, filters, sort or mode, the call fails with this code. It does not fall back to the first page. The reason is design intent (not stated in the spec): a cursor reused under different conditions could skip or repeat items, which would break the [total order](search-total-order.md).

## Example
A client searches `GET /products/search?q=iphone&limit=20` and receives a [`nextCursor`](pagination-cursor.md). The client then calls `GET /products/search?q=airpods&cursor=<that nextCursor>`. The query changed, so the call fails with `code: "invalid_cursor"`.

## Known gaps
- The spec does not say which HTTP status `invalid_cursor` uses.
- The spec does not say whether the shop route `GET /shops/:shopId/products/search` uses the same cursor binding and the same error code.
- The spec does not say whether a cursor expires.

## Used by
<!-- used-by:start -->
- [pagination-cursor](pagination-cursor.md)
- [search-total-order](search-total-order.md)
<!-- used-by:end -->
