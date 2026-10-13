---
id: zero-downtime-reindexing
title: Zero-downtime reindexing
kind: term
status: draft
aliases: [reindex, reindexing]
defined_for: job-scheduler-lease
rules_hash: b595dfa2da56
---
# Zero-downtime reindexing
## Definition
Zero-downtime reindexing is how [S32](../capabilities/S32-product-search.md) rebuilds its product [search index](search-index.md) while search keeps answering queries. The usual approach is to fill a new index in the background, switch queries to it, then remove the old one. That approach is general practice; the spec does not describe S32's exact steps. S32 has a [scheduler job](../capabilities/S49-job-scheduler.md) named [`search.retire-previous-index`](search-retire-previous-index.md), so the previous index is removed as a separate background job. Because that job runs on [S49](../capabilities/S49-job-scheduler.md), it gets [leases](job-lease.md) and retries without S32 having to build them.

## Example
Illustrative flow (the order of steps is not stated in the spec):
```
1. build new index, old index still serves searches
2. switch searches to the new index
3. enqueue search.retire-previous-index → a worker claims it and removes the old index
```

## Known gaps
- The spec does not say how searches are switched from the old index to the new one, for example by alias swap or by config change.
- The spec does not say how writes made while the new index is being built reach it, or how external versioning prevents stale writes during the switch.
- The spec does not say what starts a reindex, or how long the previous index is kept before `search.retire-previous-index` removes it.

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): R-18
- [search-index](../concepts/search-index.md): C-07
- [cutover](cutover.md)
- [job-lease](job-lease.md)
- [live-index-alias](live-index-alias.md)
- [reindex-rollback](reindex-rollback.md)
- [reindex-run-status](reindex-run-status.md)
- [reindex-run-transition](reindex-run-transition.md)
- [search-index](search-index.md)
- [search-retire-previous-index](search-retire-previous-index.md)
- [search-synonyms](search-synonyms.md)
- [shop-search-table](shop-search-table.md)
- [verification-failed](verification-failed.md)
<!-- used-by:end -->
