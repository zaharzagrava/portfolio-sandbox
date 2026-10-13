---
id: verification-failed
title: verification_failed
kind: term
status: draft
aliases: []
defined_for: search-index
rules_hash: e3b0c44298fc
---
# verification_failed
## Definition
`verification_failed` is the failure result of a [zero-downtime reindexing run](zero-downtime-reindexing.md). Before [cutover](cutover.md), the run checks that the new index holds at least as many documents as the [event history](event-replay.md) requires. If it holds fewer, the run fails with this code and the [live search index](search-index.md) stays untouched. Buyers and sellers keep searching the old index. Design intent (not stated in the spec): this stops an incomplete index from replacing a complete one, because products would silently disappear from search.

## Example
A reindex run in [S32](../capabilities/S32-product-search.md) builds a new index from catalog events. The new index holds 9,800 documents, but the history requires 10,000 (both numbers are illustrative). The run ends with `verification_failed`. Search keeps answering from the previous index.

## Known gaps
- The spec does not say how "the documents the history requires" is counted. For example, it does not say whether hidden products (archived, sandbox, deleted, or from suspended shops) count toward it.
- The spec does not say whether `verification_failed` is returned as an HTTP problem response, or only stored as the run's final state. It also does not say whether a new run can start straight away after one.
- The spec does not say what happens to the failed new index: whether it is kept for inspection or removed, for example by the search.retire-previous-index job.

## Used by
<!-- used-by:start -->
- [cutover](cutover.md)
- [event-replay](event-replay.md)
- [search-index](search-index.md)
- [zero-downtime-reindexing](zero-downtime-reindexing.md)
<!-- used-by:end -->
