---
id: autocomplete-snapshot-load-failed-total
title: autocomplete_snapshot_load_failed_total
kind: term
status: draft
aliases: []
defined_for: S33-autocomplete
rules_hash: 0d81fd2d81a0
---
# autocomplete_snapshot_load_failed_total
## Definition
`autocomplete_snapshot_load_failed_total` is the metric that counts failed snapshot loads on a serving node. A load fails when the node cannot load the snapshot that the version pointer names. When that happens, the node keeps serving its current index and adds one to this metric. Each increment carries a `reason` label, the load failure reason. Operators can use the label to tell a missing snapshot apart from a damaged one. The `_total` suffix follows the usual naming convention for counters.

## Example
The pointer moves to `autocomplete/V3` (illustrative), but that object is missing from object storage. The node keeps answering `GET /api/suggest` from `V2` and records the failure:
```
autocomplete_snapshot_load_failed_total{reason="<missing-object reason>"}  # label value illustrative
```

## Known gaps
- The spec does not list the values of the `reason` label, so do not write alert rules against guessed values.
- The spec does not say whether a node retries the same failed version on every poll, which would add one to the metric each time, or waits until the pointer changes.
- The spec does not say whether a missing pointer at startup counts as a load failure, or only produces `degraded: ["query_index_unavailable"]`.

## Used by
<!-- used-by:start -->
- [decode-snapshot](decode-snapshot.md)
<!-- used-by:end -->
