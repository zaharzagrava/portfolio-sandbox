---
id: serving-node
title: Serving node
kind: term
status: draft
aliases: [serving modules]
defined_for: S33-autocomplete
rules_hash: e3b0c44298fc
---
# Serving node
## Definition
A serving node is one process that answers [`GET /suggest`](get-suggest.md) through [`AutocompleteModule`](autocomplete-module.md). It keeps the current [suggestion snapshot](suggest-snapshot.md) in memory, and each request sees exactly one index. Its [`QueryIndexService`](query-index-service.md) polls the [version pointer](version-pointer.md) on a fixed interval and [hot-swaps](hot-swap.md) in the new index. Concurrent refreshes on one node [share a single download ↗](../sw-external-terms.md#single-flight). If a load fails, the node keeps serving its current index and counts the failure under the cause that made the load fail.

## Example
The pointer moves from `V1` to `V2` while 200 calls are in flight. Every call answers `200`, and each matches exactly one version (S33.B-18). A node that starts with no pointer is still ready. It serves [catalog completions](catalog-completions.md) with [`degraded: ["query_index_unavailable"]`](degraded-marker.md) (S33.B-20).

## Known gaps
- The spec does not say that nodes coordinate their polls. Each node polls on its own, so different nodes may serve different versions for up to one poll interval. The spec guarantees consistency only within one request.
- The spec does not say whether a serving node can also run the build job.

## Used by
<!-- used-by:start -->
- [autocomplete-module](autocomplete-module.md)
- [autocomplete-snapshot-age-seconds](autocomplete-snapshot-age-seconds.md)
- [can-advance](can-advance.md)
- [catalog-completions](catalog-completions.md)
- [hot-swap](hot-swap.md)
- [load-failure-reason](load-failure-reason.md)
- [query-index-service](query-index-service.md)
- [snapshot](snapshot.md)
- [suggest-snapshot](suggest-snapshot.md)
- [version-pointer](version-pointer.md)
- [worker-instance](worker-instance.md)
<!-- used-by:end -->
