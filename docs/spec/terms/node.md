---
id: node
title: Node
kind: term
status: draft
aliases: [nodes]
defined_for: S33-autocomplete
rules_hash: ac932223c7c8
---
# Node
## Definition
A node is one running replica of the API that serves [`GET /suggest`](get-suggest.md). Each node holds the current [snapshot](suggest-snapshot.md) in memory as its [query index](query-index.md). It reads the [version pointer](version-pointer.md) on a fixed poll interval and [swaps in a new index without downtime](hot-swap.md). If a new snapshot fails to load, the node keeps serving the index it already has. A single request always sees one whole index, and concurrent refreshes on one node [share a single download ↗](../sw-external-terms.md#single-flight).

## Example
200 concurrent calls arrive while the pointer moves from `V1` to `V2`. Every call gets `200`, and each answer matches exactly one of the two versions. The polling and swapping happen in [`QueryIndexService`](query-index-service.md) (`packages/backend/libs/domains/discovery/application/query-index.service.ts`).

## Known gaps
- The spec does not say whether the build job runs on the serving nodes or on separate worker processes. It only says the build lives in its own module, [`AutocompleteWorkerModule`](autocomplete-worker-module.md).
- The spec does not say how quickly all nodes agree on a new version. Nodes poll independently, so for a short time different nodes may answer from different versions.

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): B-19
- [hot-swap](hot-swap.md)
- [operator](operator.md)
- [query-index](query-index.md)
- [suggest-snapshot](suggest-snapshot.md)
- [version-pointer](version-pointer.md)
<!-- used-by:end -->
