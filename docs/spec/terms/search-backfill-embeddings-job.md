---
id: search-backfill-embeddings-job
title: search.backfill-embeddings job
kind: term
status: draft
aliases: [search.backfill-embeddings]
defined_for: S32-product-search
rules_hash: a3ba222895b7
---
# search.backfill-embeddings job
## Definition
`search.backfill-embeddings` is a search job that fills in missing vectors for products marked as pending embeddings. It calls the embedding provider for each pending product, writes the vector into the [search index](search-index.md), and clears the pending mark. The job lets indexing go ahead when the provider is down, and the vectors are caught up later, out of band. It runs on the [shared job scheduler](job.md).

## Example
The provider is down for a while and several products are indexed with no vector. When `search.backfill-embeddings` runs again after the provider recovers, it computes their vectors, and those products start appearing in [`GET /products/search?q=…&semantic=true`](product-search-route.md) again.

## Known gaps
- The spec does not say how often the job runs, or whether something else triggers it (for example the end of a provider outage).
- The spec does not say how many products one run handles, or how it retries a product that fails again.

## Used by
<!-- used-by:start -->
- [job](job.md)
- [pending-embedding](pending-embedding.md)
- [product-embedding-vector](product-embedding-vector.md)
- [search-index](search-index.md)
<!-- used-by:end -->
