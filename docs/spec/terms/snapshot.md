---
id: snapshot
title: Snapshot
kind: term
status: draft
aliases: [snapshots]
defined_for: S33-autocomplete
rules_hash: ac932223c7c8
---
# Snapshot
## Definition
A snapshot is the [versioned file](suggest-snapshot.md) that the hourly build job [`search.build-autocomplete`](search-build-autocomplete.md) publishes to [object storage ↗](../sw-external-terms.md#object-storage). It holds only the popular past queries as [`{query, searchers}` pairs](distinct-searchers.md), plus the parameters of the build that made it. Each snapshot carries a [checksum](autocomplete-checksum.md), so if the file is damaged, decoding fails with a [typed reason](load-failure-reason.md) instead of loading bad data. Every [serving node](serving-node.md) loads the snapshot that the [version pointer](autocomplete-pointer.md) names and keeps it in memory as its [query index](query-index.md). Only the latest few versions are kept, and the one the pointer names is never deleted.

## Example
After a successful build, the object `autocomplete/<version>` exists, the version pointer equals `<version>`, and its checksum verifies. Suppose the pointer later names a version whose object is missing or damaged. Nodes reject that version and keep serving the one they already hold.

## Known gaps
- The spec does not say what a version identifier looks like (a timestamp, a counter, or something else). It only says versions are compared, and the pointer moves to a greater one.
- The spec does not list the typed reasons that `decodeSnapshot` can return.
- The spec does not say which file format or encoding is used inside the snapshot.

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): B-19
- [autocomplete-checksum](autocomplete-checksum.md)
- [autocomplete-pointer](autocomplete-pointer.md)
- [distinct-searchers](distinct-searchers.md)
- [load-failure-reason](load-failure-reason.md)
- [operator](operator.md)
- [query-index](query-index.md)
- [serving-node](serving-node.md)
- [suggest-snapshot](suggest-snapshot.md)
- [unreferenced-object](unreferenced-object.md)
<!-- used-by:end -->
