---
id: lexical-search
title: Lexical search
kind: term
status: draft
aliases: []
defined_for: S32-product-search
rules_hash: 298f099c1fd8
---
# Lexical search
## Definition
Lexical search finds products by matching the words in [`q`](autocomplete-q-parameter.md) against product text. It is the opposite of [semantic search](semantic-search.md), which matches by meaning using vectors. Lexical search uses [fuzzy matching](fuzzy-matching.md) and ranks exact matches above fuzzy ones. [Field weights](field-weights.md) put title first, then brand, description and tags. It is also the fallback when a semantic search cannot reach the embedding provider in time. The response then carries `mode: "lexical"` and [a degraded marker](degraded-marker.md).

## Example
A normal text search is lexical. [Operators in `q` are matched as plain words](search-query-sanitisation.md):
`GET /products/search?q=wireless headphones&facets=true`

If `GET /products/search?q=wireless headphones&semantic=true` hits a slow embedding provider, the route still answers `200` with lexical results and counts `search_degraded_total`:
```json
{ "mode": "lexical", "degraded": ["semantic_unavailable"], "items": [ ... ] }
```

## Known gaps
- The spec does not say whether a normal lexical search (no `semantic=true`) also returns a `mode` member in its response. It only shows `mode: "lexical"` in the semantic fallback. The `search.performed` event always carries `mode`.
- The spec does not say whether the lexical fallback for a semantic call uses the same `limit` and filters as the semantic request.
- The spec does not say which engine feature or scoring formula does the lexical matching.

## Used by
<!-- used-by:start -->
- [degraded-marker](degraded-marker.md)
- [field-weights](field-weights.md)
- [fuzzy-matching](fuzzy-matching.md)
- [pending-embedding](pending-embedding.md)
- [search-query-sanitisation](search-query-sanitisation.md)
- [semantic-search](semantic-search.md)
<!-- used-by:end -->
