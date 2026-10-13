---
id: autocomplete-pointer
title: Autocomplete pointer
kind: term
status: draft
aliases: [pointer]
defined_for: S33-autocomplete
rules_hash: 6fcbedf744b2
---
# Autocomplete pointer
## Definition
The autocomplete pointer is the single stored value that names the snapshot that autocomplete currently serves. Only the job that builds snapshots moves it forward, and only to a version greater than the current one. A build that loses this comparison deletes its own object and ends `[superseded](superseded-build.md)`. Every serving node polls the pointer and [hot-swaps](hot-swap.md) its in-memory index when the pointer changes. Nodes also follow it backwards when an [operator](operator.md) sets it back.

## Example
Two builds overlap and the older one finishes last. The pointer stays at the newer version, and the older build ends `superseded` (S33.B-15). If no pointer exists at startup, a node serves [catalog completions](catalog-completions.md) only, with `degraded: ["query_index_unavailable"]` (S33.B-20).

## Known gaps
- The spec does not say where the pointer is stored (for example, in object storage beside the snapshots or in another store).
- The spec does not say how an operator sets the pointer back (no command or endpoint is named).
- Not confirmed in the code: whether the version check and the pointer write are a single atomic conditional write. `canAdvance` shows only the comparison.

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): B-14, B-15
- [autocomplete-checksum](autocomplete-checksum.md)
- [autocomplete-object](autocomplete-object.md)
- [autocomplete-retention](autocomplete-retention.md)
- [autocomplete-snapshot-age-seconds](autocomplete-snapshot-age-seconds.md)
- [catalog-completions](catalog-completions.md)
- [failure-counter](failure-counter.md)
- [hot-swap](hot-swap.md)
- [load-failure-reason](load-failure-reason.md)
- [operator](operator.md)
- [published-version](published-version.md)
- [query-snapshot](query-snapshot.md)
- [snapshot](snapshot.md)
- [suggest-builder](suggest-builder.md)
- [unreferenced-object](unreferenced-object.md)
<!-- used-by:end -->
