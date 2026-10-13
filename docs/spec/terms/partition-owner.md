---
id: partition-owner
title: Partition owner
kind: term
status: draft
aliases: [owner, owners]
defined_for: S35-trending
rules_hash: 9edb3c2df62b
---
# Partition owner
## Definition
A [partition ↗](../sw-external-terms.md#kafka-partition) owner is the [consumer instance](worker-instance.md) in group [`discovery-trending-topk`](consumer-group.md) that is currently assigned a given partition of [`analytics.events`](analytics-events-topic.md). It keeps that partition's [open windows](trending-window.md) in memory, closes them and merges them into the [aggregate](trending-aggregate.md). During a [rebalance ↗](../sw-external-terms.md#kafka-rebalance) or a restart, two instances can briefly act as owner and run the same merge. That is why the merge must be [idempotent ↗](../sw-external-terms.md#idempotency), which is design intent (not stated in the spec). On a termination signal, the owner merges all its open windows and [commits the matching offsets ↗](../sw-external-terms.md#kafka-offset-commit) before it exits.

## Example
Instance 1 merges the 11:42 window of `p3` and is then replaced before it commits. Instance 2 takes `p3`, rebuilds the window from the earliest unmerged offset and merges it again. The aggregate changes only once (S35 B-14, B-15; the window time is illustrative).

## Known gaps
- The spec does not say how ownership is assigned or [fenced](attempt-fencing.md). It relies only on idempotent merges.
- Not confirmed in the code: any lock or ownership check in the merge path.

## Used by
<!-- used-by:start -->
- [S35](../capabilities/S35-trending.md): R-20
- [attempt-fencing](attempt-fencing.md)
- [trending-aggregate](trending-aggregate.md)
- [trending-window](trending-window.md)
- [window-merge](window-merge.md)
- [worker-instance](worker-instance.md)
<!-- used-by:end -->
