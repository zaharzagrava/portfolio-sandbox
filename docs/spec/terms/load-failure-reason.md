---
id: load-failure-reason
title: Load failure reason
kind: term
status: draft
aliases: [typed reason]
defined_for: S33-autocomplete
rules_hash: d76ffd4be15e
---
# Load failure reason
## Definition
A load failure reason is the label a serving node records when it cannot load the [snapshot](suggest-snapshot.md) [the pointer](autocomplete-pointer.md) names. The node keeps serving its current index and adds one to the [`autocomplete_snapshot_load_failed_total`](autocomplete-snapshot-load-failed-total.md) metric, tagged with the reason. The reasons come from [`decodeSnapshot`](decode-snapshot.md), which fails with a typed reason on any damage, and from a missing object. Operators can use the reason to tell a missing snapshot from a corrupt one.

## Example
The pointer names `autocomplete/V3` (illustrative), but that object fails its [checksum](autocomplete-checksum.md). The node keeps serving `V2` and increments a counter like this:
```
autocomplete_snapshot_load_failed_total{reason="<checksum reason>"}  # label value illustrative
```

## Known gaps
- The spec does not list the reason values, so do not hard-code alert rules against guessed labels.
- The spec does not say whether a node retries a failed version on the next poll or waits until the pointer changes.

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): R-24
- [autocomplete-checksum](autocomplete-checksum.md)
- [autocomplete-object](autocomplete-object.md)
- [autocomplete-pointer](autocomplete-pointer.md)
- [decode-snapshot](decode-snapshot.md)
- [query-index-service](query-index-service.md)
- [serving-node](serving-node.md)
- [snapshot](snapshot.md)
- [suggest-snapshot](suggest-snapshot.md)
<!-- used-by:end -->
