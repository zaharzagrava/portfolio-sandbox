---
id: hot-swap
title: Hot swap
kind: term
status: draft
aliases: [hot-swap]
defined_for: S33-autocomplete
rules_hash: e3b0c44298fc
---
# Hot swap
## Definition
A hot swap is how a machine that answers queries replaces its [in-memory query index](query-index.md) with a newer saved copy of the index, without stopping or failing requests. The component that manages the index on that machine polls the [version pointer](version-pointer.md), and when the pointer names a different version, it downloads and decodes that copy, then switches the machine to it. Each request is answered from exactly one index, either the old one or the new one, never a mix. If several refreshes run at the same time on one machine, they [share a single download ↗](../sw-external-terms.md#single-flight). If the load fails, the machine keeps serving its current index and counts the failure by reason.

## Example
200 calls run at once while the pointer moves from `V1` to `V2`. Every call answers `200`, and each answer is consistent with one version only. If the pointer names a damaged or missing snapshot, the node keeps serving `V1` and increments `autocomplete_snapshot_load_failed_total{reason}`.

## Known gaps
- The spec does not say whether the node holds the old and new index in memory at the same time during a swap, so the peak memory cost of a swap is unknown.
- Not confirmed in the code: how the switch itself is done (for example, replacing one reference atomically). The code notes point only to `QueryIndexService` in `query-index.service.ts`.
- The spec does not say whether a hot swap also reloads the blocklist. It says only that a blocklist change takes effect after a restart or reload.

## Used by
<!-- used-by:start -->
- [autocomplete-checksum](autocomplete-checksum.md)
- [autocomplete-pointer](autocomplete-pointer.md)
- [node](node.md)
- [query-index-service](query-index-service.md)
- [query-index](query-index.md)
- [query-snapshot](query-snapshot.md)
- [serving-node](serving-node.md)
- [suggest-index](suggest-index.md)
- [suggest-publish](suggest-publish.md)
- [version-pointer](version-pointer.md)
<!-- used-by:end -->
