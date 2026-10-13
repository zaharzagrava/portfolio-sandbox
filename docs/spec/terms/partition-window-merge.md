---
id: partition-window-merge
title: Partition window merge
kind: term
status: draft
aliases: [merge]
defined_for: S35-trending
rules_hash: 8778022fa954
---
# Partition window merge
## Definition
A [partition ↗](../sw-external-terms.md#kafka-partition) [window](trending-window.md) merge happens when a window closes on one partition of `analytics.events`. The consumer adds that window's [weighted counts](trending-event-weight.md) to the [aggregate in Redis](trending-aggregate.md), which is keyed by category and window. Each merge is identified by its partition, window and offsets, and it changes the aggregate only once, even if it is replayed or two owners run it at the same time. [Offsets are committed ↗](../sw-external-terms.md#kafka-offset-commit) only up to the earliest unmerged window, so a crash loses nothing. If the store is down, the merge is retried with [backoff and jitter ↗](../sw-external-terms.md#exponential-backoff), and no later offset is committed.

## Example
Product `B` has 20 points in the closed window of partition `p1` and 15 points in the same window of `p2`. After both merges, the aggregate holds `B 35` (S35 B-11). If the `p1` merge is replayed after a crash, it still holds `B 35`.

## Known gaps
- Not confirmed in the code: how the Redis write enforces once-only application. The facts name only the `TrendingAggregateWriter` port.
- The spec does not say what happens when all retry attempts in a cycle fail and later cycles keep failing.

## Used by
<!-- used-by:start -->
- [S35](../capabilities/S35-trending.md): R-20
- [aggregate-store](aggregate-store.md)
- [trending-aggregate](trending-aggregate.md)
- [trending-event-weight](trending-event-weight.md)
- [trending-window](trending-window.md)
- [weighted-total](weighted-total.md)
<!-- used-by:end -->
