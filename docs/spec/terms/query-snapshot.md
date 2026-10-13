---
id: query-snapshot
title: Query snapshot
kind: term
status: draft
aliases: [snapshot]
defined_for: S33-autocomplete
rules_hash: 3ae6c91e075e
---
# Query snapshot
## Definition
The query snapshot is the versioned output of the hourly [`search.build-autocomplete` job](autocomplete-build.md). It is stored in [object storage ↗](../sw-external-terms.md#object-storage) as `autocomplete/<version>` and holds only [`{query, searchers}` pairs](distinct-searchers.md) and the build parameters, along with a value computed from its contents for detecting damage. Decoding fails with a typed reason if the snapshot is damaged. Every serving node polls the [version pointer](autocomplete-pointer.md), loads the snapshot it names into an in-memory index, and [hot-swaps](hot-swap.md) it in.

## Example
A build succeeds. Object `autocomplete/<version>` exists, the pointer equals `<version>`, and the checksum verifies (S33.B-14). If no pointer exists yet, `q=iph` still answers `200`, and [`degraded`](degraded.md) includes [`query_index_unavailable`](degraded-marker.md) (S33.B-10, S33.B-20).

## Known gaps
- The spec does not say how `<version>` is formed, for example as a timestamp or a counter. It only says versions are ordered and the pointer moves forward only in the builder.
- The spec does not say where the version pointer is stored.
- Retention keeps the latest few versions, and the pointed version is never deleted. The spec does not say what removes old objects or when.

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): B-10
- [autocomplete-blocklist](autocomplete-blocklist.md)
- [autocomplete-build](autocomplete-build.md)
- [autocomplete-checksum](autocomplete-checksum.md)
- [autocomplete-pointer](autocomplete-pointer.md)
- [distinct-searchers](distinct-searchers.md)
- [hot-swap](hot-swap.md)
- [query-index-service](query-index-service.md)
- [query-log](query-log.md)
- [query-suggestions](query-suggestions.md)
<!-- used-by:end -->
