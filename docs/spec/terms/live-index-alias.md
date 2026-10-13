---
id: live-index-alias
title: Live index name (alias)
kind: term
status: draft
aliases: [live alias, live name]
defined_for: S32-product-search
rules_hash: 2a6b59ca5423
---
# Live index name (alias)
## Definition
The live name is the single stable name that every search reads through. It points at exactly one versioned search index at a time. A completed [reindex](zero-downtime-reindexing.md) switches the live name to the new index ([cutover](cutover.md)). A [reindex rollback](reindex-rollback.md) switches it back to the previous index in one [atomic step ↗](../sw-external-terms.md#atomicity). The application never alters an existing index on startup; a mapping change is applied by building a new index and moving the live name to it.

## Example
These index names are illustrative: the live name points at `products_v7`, and after a reindex it points at `products_v8`. `POST /admin/search/rollback` points it back at `products_v7`. Once [`search.retire-previous-index`](search-retire-previous-index.md) deletes the previous index, rollback answers `409 no_previous_index`.

## Known gaps
- The spec does not give the live name itself or the naming scheme for versioned indices.
- Not confirmed in the code: that the switch uses the search engine's own alias feature.

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): R-20, B-19
- [cutover](cutover.md)
- [no-previous-index](no-previous-index.md)
- [product-search-route](product-search-route.md)
- [reindex-history](reindex-history.md)
- [reindex-rollback](reindex-rollback.md)
- [search-projector](search-projector.md)
- [shop-search-table](shop-search-table.md)
- [verification-gate](verification-gate.md)
- [zero-downtime-reindexing](zero-downtime-reindexing.md)
<!-- used-by:end -->
