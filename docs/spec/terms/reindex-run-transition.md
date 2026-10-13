---
id: reindex-run-transition
title: Reindex run transitions
kind: term
status: draft
aliases: [legal pairs, run state machine]
defined_for: S32-product-search
rules_hash: 043778af73a1
---
# Reindex run transitions
## Definition
A [reindex run](zero-downtime-reindexing.md) transition moves a reindex run from one [status](reindex-run-status.md) to the next. The legal statuses are `QUEUED`, `BUILDING`, [`CATCHING_UP`](reindex-run-status.md), `COMPLETED`, `FAILED` and `CANCELLED`. A worker moves a run forward, and an administrator may cancel an active run. Only the legal pairs of the [run state machine ↗](../sw-external-terms.md#state-machine) are allowed. Any other pair is refused with [`invalid_transition`](invalid-transition.md). The status list is defined as `REINDEX_STATUSES` in `packages/contracts/src/search/admin.ts`.

## Example
A normal run goes `QUEUED → BUILDING → CATCHING_UP → COMPLETED`. Cancelling a run in `BUILDING` is legal (`BUILDING → CANCELLED`). Moving a `COMPLETED` run back to `BUILDING` is not on the known list of legal pairs and would fail with `invalid_transition`.

## Known gaps
- The spec does not say the full list of legal pairs. The facts cut the list off after `CATCHING_UP → FAILED`, so it is unknown whether, for example, `CATCHING_UP → CANCELLED` is legal.
- The spec does not say which HTTP status an admin gets when a cancel hits an illegal transition.

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): R-19
- [reindex-run-status](reindex-run-status.md)
- [zero-downtime-reindexing](zero-downtime-reindexing.md)
<!-- used-by:end -->
