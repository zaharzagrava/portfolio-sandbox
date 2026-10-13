---
id: search-synonyms
title: Search synonyms
kind: term
status: draft
aliases: [synonym]
defined_for: job-scheduler-lease
rules_hash: 0d4cfec07224
---
# Search synonyms
## Definition
Search synonyms let a query match products that describe the same thing with a different word. They are one feature of the [S32 product search](../capabilities/S32-product-search.md) capability, alongside [relevance boosts](relevance-boost.md), [facets](search-facets.md) and [k-NN search ↗](../sw-external-terms.md#knn-search). The spec names the feature but does not describe how synonyms are defined or applied.

## Example
Illustrative only. A shopper searches for "sneakers". A synonym entry links "sneakers" to "trainers", so a product titled "Lightweight trainers" also appears in the results.

## Known gaps
- The spec does not say where synonym lists are stored or who maintains them (platform, shops or admins).
- The spec does not say whether synonyms apply when a query is run or when products are indexed. If they apply at indexing, a change may need a [reindex](zero-downtime-reindexing.md) before it takes effect.
- The spec does not say whether synonyms are global or set per shop or per tenant.

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): R-31, B-26
- [relevance-boost](relevance-boost.md)
- [search-facets](search-facets.md)
- [search-index](search-index.md)
- [zero-downtime-reindexing](zero-downtime-reindexing.md)
- [zero-result-rate](zero-result-rate.md)
<!-- used-by:end -->
