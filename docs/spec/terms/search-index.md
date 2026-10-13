---
id: search-index
title: Search index
kind: term
status: draft
aliases: [new index, old index, previous index, product search index]
defined_for: job-scheduler-lease
rules_hash: f878570d3f80
---
# Search index
## Definition
The search index is the store that [S32](../capabilities/S32-product-search.md) queries to answer product searches. S32 keeps it in sync with product data and uses [external versioning ↗](../sw-external-terms.md#external-versioning) so that an older write cannot overwrite a newer one. Ranking adjustments, matching on equivalent words, filtering by product attributes and [k-NN ↗](../sw-external-terms.md#knn-search) all work on top of it. During zero-downtime reindexing, S32 fills a new index while the previous one keeps answering searches. Afterwards, the `search.retire-previous-index` job removes the old index.

## Example
Illustrative only: the spec does not describe the steps in this order.
```
shopper searches "running shoes" → S32 answers from the current search index (boosts + facets applied)
reindex starts → new index fills in the background, the current one still answers
after the switch → search.retire-previous-index removes the old index
```

## Known gaps
- The spec does not say which search engine holds the index or how indexes are named.
- The spec does not say whether there is one index for the whole platform or one per tenant or shop.
- The spec does not say how searches are switched from the old index to the new one, for example by alias swap or by config change.

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): R-15, R-20, B-07, B-14, B-15, B-18, B-19
- [cutover](cutover.md)
- [event-replay](event-replay.md)
- [no-previous-index](no-previous-index.md)
- [product-search-route](product-search-route.md)
- [reindex-rollback](reindex-rollback.md)
- [reindex-run-status](reindex-run-status.md)
- [relevance-boost](relevance-boost.md)
- [sandbox-product](sandbox-product.md)
- [search-facets](search-facets.md)
- [search-retire-previous-index](search-retire-previous-index.md)
- [search-synonyms](search-synonyms.md)
- [search-total-order](search-total-order.md)
- [search-totals](search-totals.md)
- [search-visibility](search-visibility.md)
- [shop-product-search-route](shop-product-search-route.md)
- [shop-search-table](shop-search-table.md)
- [shop-status](shop-status.md)
- [verification-failed](verification-failed.md)
- [zero-downtime-reindexing](zero-downtime-reindexing.md)
<!-- used-by:end -->
