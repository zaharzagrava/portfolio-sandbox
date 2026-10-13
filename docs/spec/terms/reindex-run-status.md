---
id: reindex-run-status
title: Reindex run status
kind: term
status: draft
aliases: [building, catching_up, completed, queued]
defined_for: S32-product-search
rules_hash: e3b0c44298fc
---
# Reindex run status
## Definition
The reindex run status is the state of one [zero-downtime reindex](zero-downtime-reindexing.md) run. The statuses are `QUEUED`, `BUILDING`, `CATCHING_UP`, `COMPLETED`, `FAILED` and `CANCELLED`. A worker moves the run forward, and an administrator may cancel an active run. Only the legal pairs of the [state machine ↗](../sw-external-terms.md#state-machine) are allowed; any other move is `[invalid_transition](invalid-transition.md)`. While a run is active, starting another run or [a rollback](reindex-rollback.md) answers `[reindex_in_progress](reindex-in-progress.md)`.

## Example
`POST /admin/search/reindex` → `202 QUEUED`. The run then moves `QUEUED → BUILDING → CATCHING_UP → COMPLETED`. Products changed during `BUILDING` are all in [the new index](search-index.md) when the run completes.

## Known gaps
- The spec does not give the full list of legal moves; the facts cut it off after `CATCHING_UP → FAILED`.
- The spec does not say whether `CATCHING_UP` can be cancelled. `CATCHING_UP → CANCELLED` is not among the listed moves.
- Cancel behavior is referenced only by proof ids, and no rule here states it.

## Known gaps

## Used by
<!-- used-by:start -->
- [no-previous-index](no-previous-index.md)
- [reindex-history](reindex-history.md)
- [reindex-rollback](reindex-rollback.md)
- [reindex-run-transition](reindex-run-transition.md)
- [search-index](search-index.md)
- [verification-gate](verification-gate.md)
- [zero-downtime-reindexing](zero-downtime-reindexing.md)
<!-- used-by:end -->
