---
id: reindex-in-progress
title: reindex_in_progress (409)
kind: term
status: draft
aliases: [reindex_in_progress]
defined_for: search-index
rules_hash: e3b0c44298fc
---
# reindex_in_progress (409)
## Definition
`[reindex](zero-downtime-reindexing.md)_in_progress` is the [error code](error-code.md) returned with HTTP 409 when someone asks to start or [roll back a reindex](reindex-rollback.md) while another run is active. It enforces the rule that at most one reindex run is active at a time. It is a [conflict error](conflict-error.md), so the caller should wait for the current run to finish and then retry.

## Example
A second "start reindex" request while a run is active gets this response (the body shape is illustrative):
```json
{ "status": 409, "code": "reindex_in_progress" }
```

## Known gaps
- The spec does not give the endpoints for starting or rolling back a reindex.
- The spec does not say whether the response names the active run or says when it will finish.
- The spec does not say how "active" is tracked across instances, for example with a [lock ↗](../sw-external-terms.md#distributed-lock) or a database row.

## Used by
<!-- used-by:start -->
- [conflict-error](conflict-error.md)
- [error-code](error-code.md)
- [reindex-rollback](reindex-rollback.md)
<!-- used-by:end -->
