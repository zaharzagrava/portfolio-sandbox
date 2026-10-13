---
id: order-baskets-build
title: Order baskets build
kind: term
status: draft
aliases: [build, run]
defined_for: S34-recommendations
rules_hash: b09409a2a9e6
---
# Order baskets build
## Definition
The order baskets build is the nightly run of the job `recommendations.build-bought-together`. It reads the baskets paid inside the [build window](build-window.md), counts [co-orders](co-occurrence-graph.md) and the number of different customers who bought each product pair, and scores the pairs that qualify. For each product it then replaces the [neighbour list](direct-neighbour.md) with the best edges in a single step, so readers never see a half-written list. After a fully successful run it removes the lists of products that have no edges left. Only one build runs at a time, guarded by a [lock with a lease](job-lease.md).

## Example
The [`17 3 * * *` ↗](../sw-external-terms.md#cron-expression) schedule fires and the build reads the baskets, then writes product `A`'s list containing `D`. It reports `{products, edges, removed}`. When run again on unchanged baskets, it produces the same lists and counts (S34.B-16).

## Known gaps
- The spec does not say what the job does after a failed build, for example whether it retries. It only says that nothing is deleted.
- The spec does not list every possible end state. Only `[skipped_empty](build-end-states.md)`, `[skipped_locked](skipped-locked.md)` and failure are named.

## Used by
<!-- used-by:start -->
- [S34](../capabilities/S34-recommendations.md): R-21, B-13
- [atomic-list-swap](atomic-list-swap.md)
- [bucket-count](bucket-count.md)
- [build-counts](build-counts.md)
- [build-lock](build-lock.md)
- [build-window](build-window.md)
- [co-occurrence-graph](co-occurrence-graph.md)
- [direct-neighbour](direct-neighbour.md)
- [distinct-buyers-threshold](distinct-buyers-threshold.md)
- [job-lease](job-lease.md)
- [neighbour-list](neighbour-list.md)
<!-- used-by:end -->
