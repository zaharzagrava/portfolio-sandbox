---
id: pending-embedding
title: Pending embedding
kind: term
status: draft
aliases: [pending]
defined_for: S32-product-search
rules_hash: e05792ded003
---
# Pending embedding
## Definition
A pending embedding is the state of an indexed product that has no vector yet, because the embedding provider failed when the product was indexed. The product still appears in [lexical search](lexical-search.md) with the usual [search visibility](search-visibility.md). [Semantic search](semantic-search.md) only returns products that have a vector, so a pending product cannot be found that way until it gets one. The [`search.backfill-embeddings` job](search-backfill-embeddings-job.md) computes the missing vector and clears the pending state.

## Example
A seller renames a product, which fires a `catalog.product_updated` event. The provider fails, so the product is reindexed with its new title but no vector, and marked pending. A later `search.backfill-embeddings` run adds the vector, and from then on the product can show up in `semantic=true` results.

## Known gaps
- The spec does not say how the pending mark is stored (a field name, a flag, or a separate table).
- The spec does not say what happens to a product whose vector keeps failing across many backfill runs.

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): R-26
- [embedding-provider](embedding-provider.md)
- [lexical-search](lexical-search.md)
- [product-embedding-vector](product-embedding-vector.md)
- [search-backfill-embeddings-job](search-backfill-embeddings-job.md)
- [search-visibility](search-visibility.md)
- [semantic-search](semantic-search.md)
<!-- used-by:end -->
