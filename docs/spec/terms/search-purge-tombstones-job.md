---
id: search-purge-tombstones-job
title: search.purge-tombstones job
kind: term
status: draft
aliases: [search.purge-tombstones]
defined_for: S32-product-search
rules_hash: e3b0c44298fc
---
# search.purge-tombstones job
## Definition
`search.purge-[tombstones](shop-tombstone.md)` is one of the [scheduled jobs](job.md) that the product search capability runs. [The job scheduler](scheduler-leader.md) runs it like any other job. Its name says it removes tombstones from the search side. A tombstone is most likely the record of a deleted product that keeps the delete version. [The search projector](search-projector.md) would check that version to keep the product hidden when [late events](dropped-late-event.md) arrive. This reading is design intent (not stated in the spec).

## Example
A product is deleted at version 9 (illustrative). A late [`catalog.product_updated`](catalog-product-updated-event.md) event then arrives with version 8 (illustrative). The projector ignores it and the product stays hidden. Later, `search.purge-tombstones` removes the stored delete record for that product.

## Known gaps
- The spec does not say what a tombstone is, what it holds, or whether it lives in the [search index](search-index.md) or in a separate table.
- The spec does not say when the job runs or how old a tombstone must be before the job removes it.
- The spec does not say what happens to a late event that arrives after its tombstone is purged. Such an event could bring a deleted product back into search results.

## Used by
<!-- used-by:start -->
- [dropped-late-event](dropped-late-event.md)
- [job](job.md)
- [scheduler-leader](scheduler-leader.md)
- [search-document](search-document.md)
- [search-index](search-index.md)
- [search-projector](search-projector.md)
<!-- used-by:end -->
