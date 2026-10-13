---
id: reindex-rollback
title: Reindex rollback
kind: term
status: draft
aliases: [rollback]
defined_for: search-index
rules_hash: 51880f870d7f
---
# Reindex rollback
## Definition
A reindex rollback is an operation that undoes a [zero-downtime reindexing](zero-downtime-reindexing.md) run. It is subject to the same single-run rule as starting a reindex: while a run is active, a rollback answers [`409 reindex_in_progress`](reindex-in-progress.md). Returning search to the [previous index](search-index.md) is design intent (not stated in the spec).

## Example
An operator starts a reindex. While it is still running, they request a rollback. The request is refused with `409 reindex_in_progress`, and the active run carries on.

## Known gaps
- The spec does not say what a rollback restores, or how far back it can go.
- The spec does not say whether rollback still works after the [search.retire-previous-index](search-retire-previous-index.md) job has removed the previous index.
- The spec does not give the endpoint or the reindex run [state machine ↗](../sw-external-terms.md#state-machine). The facts mention only the [`invalid_transition`](invalid-transition.md) code.

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): R-18, B-19
- [search-index](../concepts/search-index.md): C-07
- [cutover](cutover.md)
- [live-index-alias](live-index-alias.md)
- [reindex-in-progress](reindex-in-progress.md)
- [reindex-run-status](reindex-run-status.md)
- [search-index](search-index.md)
- [search-retire-previous-index](search-retire-previous-index.md)
- [zero-downtime-reindexing](zero-downtime-reindexing.md)
<!-- used-by:end -->
