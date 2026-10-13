---
id: product-embedding-vector
title: Product embedding vector
kind: term
status: draft
aliases: [embedding, vector]
defined_for: S32-product-search
rules_hash: a0493d3d8e1b
---
# Product embedding vector
## Definition
A product embedding vector is a numeric representation of a product's meaning. It is computed by an external [embedding provider](embedding-provider.md) from the product's title, description, brand, category and tags. It is stored in the [search index](search-index.md) and used by [semantic search](semantic-search.md) to find the products nearest to the query. It is recomputed only when one of those fields changes, and it never appears in any API response. If the provider fails, the product is indexed without a vector and marked [pending](pending-embedding.md) until the [`search.backfill-embeddings` job](search-backfill-embeddings-job.md) fills it in.

## Example
A seller renames a product from "Kettle" to "Glass electric kettle 1.7 L" (an illustrative title). The [`catalog.product_updated` event](catalog-product-updated-event.md) triggers a new vector. A price-only change does not.
If the provider is down at that moment, the product is still searchable by text, but it is missing from semantic results until the backfill job runs.

## Known gaps
- The spec does not name the embedding provider or model, or give the vector's size.
- The spec does not say how many attempts the `search.backfill-embeddings` job makes, or what happens to a product whose vector never succeeds.
- Not confirmed in the code: whether a product that is pending a vector keeps its old vector, or has none, until the backfill completes.

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): R-24
- [catalog-product-updated-event](catalog-product-updated-event.md)
- [embedding-provider](embedding-provider.md)
- [pending-embedding](pending-embedding.md)
- [price-only-update](price-only-update.md)
- [search-backfill-embeddings-job](search-backfill-embeddings-job.md)
- [search-document](search-document.md)
- [search-index](search-index.md)
- [semantic-search](semantic-search.md)
<!-- used-by:end -->
