---
id: commit-floor
title: Commit floor
kind: term
status: draft
aliases: []
defined_for: S35-trending
rules_hash: 171ba0dad297
---
# Commit floor
## Definition
The commit floor is the furthest [offset ↗](../sw-external-terms.md#kafka-offset-commit) the [trending consumer](event-consumer.md) may commit for a [partition ↗](../sw-external-terms.md#kafka-partition). It sits at the earliest offset that still belongs to a [window not yet merged](window-merge.md) into the [trending aggregate](trending-aggregate.md). Because nothing past that point is committed, a restart replays every event of every unmerged window. Window merges are [idempotent ↗](../sw-external-terms.md#idempotency), so the replay loses nothing and double-counts nothing. Design intent (not stated in the spec): this lets the open windows stay in memory only, since the event stream can rebuild them.

## Example
Illustrative: a partition has three open windows, 11:02, 11:03 and 11:04. The first event of the 11:02 window is at offset 5,120, and everything before it is already merged. The consumer commits only up to 5,120. It crashes, restarts at 5,120 and rebuilds all three windows (S35.B-15).
While the aggregate store is down at window close, the floor stays where it is: "no later offset is committed" (S35.B-17).

## Known gaps
- The spec does not say whether the committed offset is the first unmerged event itself or the one just before it. Check `commitFloor` in `packages/backend/libs/domains/discovery/domain/commit-floor.ts`.
- The spec does not say whether a late event still waiting on the correction path holds the floor back.

## Used by
<!-- used-by:start -->
- [event-consumer](event-consumer.md)
- [shutdown-deadline](shutdown-deadline.md)
- [trending-aggregate](trending-aggregate.md)
- [window-merge](window-merge.md)
<!-- used-by:end -->
