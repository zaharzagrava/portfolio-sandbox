---
id: embedding-budget
title: Embedding budget
kind: term
status: draft
aliases: []
defined_for: S32-product-search
rules_hash: e3b0c44298fc
---
# Embedding budget
## Definition
The embedding budget is a time limit in [S32's](../capabilities/S32-product-search.md) configuration for the embedding step of [semantic search](semantic-search.md). It is a separate setting from the [search budget](search-budget.md). The spec names it only as a configuration value and does not say which embedding call it limits. Design intent (not stated in the spec): a separate limit keeps a slow embedding step from using up the whole search budget.

## Example
S32's configuration has two separate time limits:
```
search budget:    1 s
embedding budget: 300 ms
```
A semantic-mode call to [`GET /products/search`](product-search-route.md) is the kind of request this limit is meant for.

## Known gaps
- The spec does not say what happens when the embedding budget runs out. Semantic degradation is covered only by scenarios AS-18 to AS-21, and no test carries those ids. The spec also does not say whether the [`search_degraded_total`](search-degraded-total.md) metric counts this case.
- The spec does not say whether the budget applies to embedding the query at search time, to embeddings made at indexing time, or to both.
- The spec does not say whether the embedding budget counts inside the search budget or adds time on top of it.

## Used by
<!-- used-by:start -->
- [embedding-provider](embedding-provider.md)
- [search-budget](search-budget.md)
- [semantic-search](semantic-search.md)
<!-- used-by:end -->
