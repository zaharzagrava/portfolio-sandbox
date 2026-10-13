---
id: no-previous-index
title: no_previous_index (409)
kind: term
status: draft
aliases: [no_previous_index]
defined_for: S32-product-search
rules_hash: e3b0c44298fc
---
# no_previous_index (409)
## Definition
`no_previous_index` is the error code that [`POST /admin/search/rollback`](reindex-rollback.md) returns with status `409`. It means no previous index is left to switch the [live name](live-index-alias.md) back to. After a run completes, the [previous search index](search-index.md) is kept for a fixed retention window. During that window, a reindex rollback is an instant atomic switch. Once the window ends, the previous index is deleted and rollback is refused with this code. It is a [conflict error](conflict-error.md): the request is valid, but the current state of the indices does not allow it.

## Example
A [reindex run](reindex-run-status.md) reaches `COMPLETED`. 24 hours later, the previous index has been deleted. An administrator then calls rollback:
```
POST /admin/search/rollback
→ 409  { "code": "no_previous_index", ... }   (other body members illustrative)
```
The live name keeps pointing at the current index.

## Known gaps
- The spec does not say this code as a rule. It appears only in behavior S32.B-19. The body members and the error catalogue detail text are not stated.
- The spec does not say whether rollback returns `no_previous_index` when there was never a previous index, such as on a first start or with a legacy concrete index. It also does not say which code wins when a run is also active (`reindex_in_progress`).
- The spec does not say which component deletes the previous index. The `search.retire-previous-index` job is the likely one, but this is not confirmed in the facts.

## Used by
<!-- used-by:start -->
- [conflict-error](conflict-error.md)
- [live-index-alias](live-index-alias.md)
- [reindex-run-status](reindex-run-status.md)
- [search-index](search-index.md)
<!-- used-by:end -->
