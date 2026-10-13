---
id: query-index-service
title: QueryIndexService
kind: term
status: draft
aliases: []
defined_for: S33-autocomplete
rules_hash: e3b0c44298fc
---
# QueryIndexService
## Definition
`QueryIndexService` keeps the [query index](query-index.md) up to date on every [serving node](serving-node.md). On each poll interval it reads the [version pointer](version-pointer.md). When the pointer names a new [snapshot](query-snapshot.md), it downloads and decodes that snapshot, then [swaps it in without downtime](hot-swap.md). If a load fails, the node keeps serving its current index and counts the failure by its [load failure reason](load-failure-reason.md). If an operator sets the pointer back, the node follows it to the older version, and concurrent refreshes on one node share a single download.

## Example
The builder publishes `autocomplete/V2` and moves the pointer from `V1` to `V2`. Within one poll (30 seconds), each node loads `V2` and swaps it in. During the swap, 200 concurrent `GET /api/suggest?q=iph` calls all return `200`, and each answer matches one version. If `autocomplete/V2` fails its checksum, the node keeps serving `V1` and increments `autocomplete_snapshot_load_failed_total{reason}`.

## Known gaps
- The spec does not list the values of the load failure `reason` label.
- The spec does not say whether the node checks the pointer once at startup or waits for the first poll. B-20 says only that a node with no pointer is ready and reports `query_index_unavailable`.
- Not confirmed in the code: whether `QueryIndexService` emits `autocomplete_snapshot_age_seconds` and `autocomplete_snapshot_load_failed_total`, or whether another component emits them.

## Used by
<!-- used-by:start -->
- [hot-swap](hot-swap.md)
- [load-failure-reason](load-failure-reason.md)
- [query-index](query-index.md)
- [query-snapshot](query-snapshot.md)
- [serving-node](serving-node.md)
- [version-pointer](version-pointer.md)
<!-- used-by:end -->
