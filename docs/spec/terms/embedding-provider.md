---
id: embedding-provider
title: Embedding provider
kind: term
status: draft
aliases: []
defined_for: S32-product-search
rules_hash: f3dd9aa4e0a3
---
# Embedding provider
## Definition
The embedding provider is the external service that turns product text and search queries into vectors for [semantic search](semantic-search.md). The system calls it when a product's title, description, brand, category or tags change, and when a semantic search runs. If it is too slow or fails during a search, the search falls back to [lexical results](search-mode.md) and is marked [`degraded`](degraded.md); it never returns an error. If it fails while a product is being indexed, the product is still indexed, without a vector, and is marked as a [pending embedding](pending-embedding.md).

## Example
A buyer calls `GET /products/search?q=running+shoes&semantic=true`. The provider does not answer within the [embedding budget](embedding-budget.md), so the response is `200` with `mode: "lexical"` and `degraded: ["semantic_unavailable"]`, and [`search_degraded_total`](search-degraded-total.md) goes up by one.

## Known gaps
- The spec does not name the provider or the embedding model.
- The spec does not say whether calls made while indexing have the same time budget as calls made during a search.
- The spec does not say if the system limits or retries provider calls at index time; it only says the [`search.backfill-embeddings`](search-backfill-embeddings-job.md) job fills them in later.

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): R-25, B-24
- [embedding-budget](embedding-budget.md)
- [pending-embedding](pending-embedding.md)
- [price-only-update](price-only-update.md)
- [product-embedding-vector](product-embedding-vector.md)
- [search-mode](search-mode.md)
- [semantic-search](semantic-search.md)
<!-- used-by:end -->
