---
id: window-merge
title: Window merge
kind: term
status: draft
aliases: [merge, merges, replayed merge]
defined_for: S35-trending
rules_hash: b307fc45df38
---
# Window merge
## Definition
A window merge adds the counts of one [closed partition window](trending-window.md) into the [shared trending aggregate](trending-aggregate.md) in Redis. Each merge is identified by its partition, its window and its offsets, and it changes the aggregate exactly once. That holds even when the merge is replayed after a crash or run by two consumers that both believe they hold the same partition. The consumer [commits offsets ↗](../sw-external-terms.md#kafka-offset-commit) only up to the earliest window not yet merged, so a restart neither loses events nor double-counts them. If the aggregate store is down, the merge is retried with [backoff and jitter ↗](../sw-external-terms.md#exponential-backoff), and no later offset is committed.

## Example
Product `B` has 20 points in partition `p1` and 15 in `p2`. When both windows close and merge, the aggregate holds `B 35` (S35.B-11). If the consumer is killed before it commits offsets, the replayed merge after restart leaves `B 35` unchanged (S35.B-14).

## Known gaps
- The spec does not say how the store records that a merge identity has already been applied, or how long that record is kept.
- Not confirmed in the code: how `TrendingAggregateWriter` enforces once-only application when two owners merge the same window at the same time.

## Used by
<!-- used-by:start -->
- [S35](../capabilities/S35-trending.md): B-14
- [bounded-retention](bounded-retention.md)
- [commit-floor](commit-floor.md)
- [partition-owner](partition-owner.md)
- [shutdown-deadline](shutdown-deadline.md)
- [trending-aggregate](trending-aggregate.md)
- [trending-minute-window](trending-minute-window.md)
- [trending-window](trending-window.md)
- [watermark](watermark.md)
<!-- used-by:end -->
