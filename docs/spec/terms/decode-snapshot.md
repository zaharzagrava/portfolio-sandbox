---
id: decode-snapshot
title: decodeSnapshot
kind: term
status: draft
aliases: []
defined_for: S33-autocomplete
rules_hash: e3b0c44298fc
---
# decodeSnapshot
## Definition
`decodeSnapshot` turns a stored [autocomplete snapshot](autocomplete-object.md) back into the data it holds. That data is the [`{query, searchers}` pairs](distinct-searchers.md) and the [build parameters](autocomplete-build.md). It checks the snapshot's [checksum](autocomplete-checksum.md). If the snapshot is damaged in any way, decoding fails with a [typed reason](load-failure-reason.md) instead of returning partial data. That typed reason is what lets a [load failure](autocomplete-snapshot-load-failed-total.md) be counted by reason.

## Example
The pointer names `autocomplete/V3` (illustrative), and one byte of that object was corrupted in storage. `decodeSnapshot` rejects it with a typed reason, and the node keeps serving `V2` (S33.B-19). A healthy object decodes to pairs like `{query: "iphone case", searchers: 42}` (count illustrative).

## Known gaps
- The spec does not say whether `decodeSnapshot` throws an error or returns a failure value, or what the typed reasons are called.
- The spec does not describe the snapshot's byte format or which checksum algorithm it uses.
- Not confirmed in the code: that `QueryIndexService` calls `decodeSnapshot` when a node loads a snapshot. The facts link the function only to the snapshot rule, S33.R-21.

## Used by
<!-- used-by:start -->
- [autocomplete-build](autocomplete-build.md)
- [autocomplete-checksum](autocomplete-checksum.md)
- [autocomplete-object](autocomplete-object.md)
- [autocomplete-snapshot-load-failed-total](autocomplete-snapshot-load-failed-total.md)
- [distinct-searchers](distinct-searchers.md)
- [load-failure-reason](load-failure-reason.md)
<!-- used-by:end -->
