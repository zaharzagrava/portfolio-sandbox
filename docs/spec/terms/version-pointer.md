---
id: version-pointer
title: Version pointer
kind: term
status: draft
aliases: [pointer]
defined_for: S33-autocomplete
rules_hash: e33d775cb13d
---
# Version pointer
## Definition
The version pointer is the one stored value in [object storage ↗](../sw-external-terms.md#object-storage) that names the current [suggest snapshot](suggest-snapshot.md) version. Every serving node reads it on a regular poll and replaces its in-memory index while it keeps serving when the value changes. Only the job that builds snapshots moves it, and only forward. A person running the system may set it back by hand, and nodes then follow it backwards. If a node cannot load the snapshot the pointer names, it keeps serving its current index.

## Example
200 calls run at once while the pointer moves from `V1` to `V2`. Every call answers `200`, and each answer matches exactly one version. If no pointer exists at startup, the node still serves [catalog completions](catalog-completions.md) with [`degraded: ["query_index_unavailable"]`](degraded-marker.md).

## Known gaps
- The spec does not say how a version value is generated, or how two versions are compared to decide which is "greater".
- Not confirmed in the code: whether the pointer is advanced with an [atomic conditional write](durable-conditional-write.md). The code notes show only the [`canAdvance`](can-advance.md) check in `snapshot-pointer.ts`.

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): R-22, B-16, B-18
- [build-end-states](build-end-states.md)
- [can-advance](can-advance.md)
- [catalog-completions](catalog-completions.md)
- [durable-conditional-write](durable-conditional-write.md)
- [hot-swap](hot-swap.md)
- [node](node.md)
- [operator](operator.md)
- [published-query](published-query.md)
- [published-version](published-version.md)
- [query-index-build](query-index-build.md)
- [query-index-service](query-index-service.md)
- [query-index](query-index.md)
- [readiness](readiness.md)
- [search-build-autocomplete](search-build-autocomplete.md)
- [serving-node](serving-node.md)
- [suggest-builder](suggest-builder.md)
- [suggest-index](suggest-index.md)
- [suggest-publish](suggest-publish.md)
- [suggest-snapshot](suggest-snapshot.md)
- [suggestion-build](suggestion-build.md)
- [superseded-build](superseded-build.md)
<!-- used-by:end -->
