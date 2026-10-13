---
id: search-mode
title: Search mode
kind: term
status: draft
aliases: [semantic mode]
defined_for: S32-product-search
rules_hash: 4a2453bf7ed7
---
# Search mode
## Definition
The search mode tells what kind of search produced a response, and it is returned in the response. With no `q`, the mode is `browse`: items are ordered by [business score](business-score.md), highest first, then by `id` ascending. Text queries and [semantic search](semantic-search.md) are other modes. A [pagination cursor](pagination-cursor.md) is tied to its mode, so using a cursor under a different mode fails with `[invalid_cursor](invalid-cursor.md)`.

## Example
`GET /products/search` with no `q` answers with `"mode": "browse"`. If you take a `nextCursor` from that response and send it with `q=iphone`, the call fails with `invalid_cursor`.

## Known gaps
- The spec does not say the name of the mode value for plain text search, or how a caller asks for semantic mode.
- The spec does not say how semantic mode [degrades](degraded.md). Semantic search and its degradation have no tests.

## Used by
<!-- used-by:start -->
- [browse-mode](browse-mode.md)
- [business-score](business-score.md)
- [degraded](degraded.md)
- [pagination-cursor](pagination-cursor.md)
- [product-search-route](product-search-route.md)
- [search-budget](search-budget.md)
- [semantic-search](semantic-search.md)
- [zero-result-rate](zero-result-rate.md)
<!-- used-by:end -->
