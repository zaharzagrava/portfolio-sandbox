---
id: autocomplete-checksum
title: Autocomplete checksum
kind: term
status: draft
aliases: [checksum]
defined_for: S33-autocomplete
rules_hash: 7dc0b9a04a3d
---
# Autocomplete checksum
## Definition
The autocomplete checksum is a check value stored inside every autocomplete [snapshot](suggest-snapshot.md). The builder writes it when it publishes the snapshot. A serving node checks it in [`decodeSnapshot`](decode-snapshot.md) before it loads the snapshot. If the snapshot is damaged in any way, decoding fails with a [typed reason](load-failure-reason.md). The node then keeps serving its current index and counts the failure by that reason.

## Example
A build publishes [`autocomplete/<version>`](autocomplete-object.md), and the [version pointer](autocomplete-pointer.md) now names it. A node downloads the object, the checksum verifies, and the node [hot-swaps](hot-swap.md) to the new index. If a byte of that object were corrupted, the node would keep the previous version and increase [`autocomplete_snapshot_load_failed_total{reason}`](autocomplete-snapshot-load-failed-total.md).

## Known gaps
- The spec does not say which checksum algorithm is used, or exactly which bytes of the snapshot it covers.
- The spec does not list the typed failure reasons that `decodeSnapshot` can return.

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): B-14
- [autocomplete-object](autocomplete-object.md)
- [autocomplete-pointer](autocomplete-pointer.md)
- [decode-snapshot](decode-snapshot.md)
- [hot-swap](hot-swap.md)
- [load-failure-reason](load-failure-reason.md)
- [query-index](query-index.md)
- [query-snapshot](query-snapshot.md)
- [search-build-autocomplete](search-build-autocomplete.md)
- [snapshot](snapshot.md)
- [suggest-snapshot](suggest-snapshot.md)
<!-- used-by:end -->
