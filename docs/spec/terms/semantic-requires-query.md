---
id: semantic-requires-query
title: semantic_requires_query (422)
kind: term
status: draft
aliases: [semantic_requires_query]
defined_for: S32-product-search
rules_hash: e3b0c44298fc
---
# semantic_requires_query (422)
## Definition
`semantic_requires_query` is the error code returned with a `422` when a caller asks for [semantic search](semantic-search.md) without a [`q` parameter](shop-search-q-parameter.md). Semantic mode finds the products nearest to the meaning of the query text, so it has nothing to work with when there is no text. [Plain lexical search](search-mode.md) does not raise this error.

## Example
```
GET /products/search?semantic=true&category=shoes
→ 422  { "code": "semantic_requires_query", ... }
```
(`category=shoes` is illustrative.)

## Known gaps
- The spec does not say whether an empty `q` (`q=`) counts as missing or fails earlier with `400 validation_failed`.
- The spec does not say which error wins when `q` is missing and [`facets`](search-facets.md) or [`cursor`](pagination-cursor.md) is also sent.

## Used by
<!-- used-by:start -->
- [search-mode](search-mode.md)
- [semantic-search](semantic-search.md)
- [shop-search-q-parameter](shop-search-q-parameter.md)
<!-- used-by:end -->
