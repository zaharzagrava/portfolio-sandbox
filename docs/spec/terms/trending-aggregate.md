---
id: trending-aggregate
title: Trending aggregate
kind: term
status: draft
aliases: [aggregate, aggregate store]
defined_for: S35-trending
rules_hash: 36e8a32efed9
---
# Trending aggregate
## Definition
The trending aggregate is the stored set of per-product counts, where each event adds an amount set by its type. Redis keeps it per category and per minute. The [stream consumer](event-consumer.md) folds each finished minute of a partition's events into it, and each fold is identified by partition, minute and offsets, so a replay or a second consumer working the same partition at the same time changes the aggregate only once. The endpoint reads the minutes inside the [trending horizon](trending-window.md), sums them and orders the products. Keys have bounded retention.

## Example
Product `B` scores 20 points in partition `p1` and 15 in `p2` for the same window. When both windows close and merge, the aggregate holds `B 35`. If the consumer crashes before committing offsets and replays the merge, it still holds `B 35`.

## Known gaps
- The spec does not say the exact Redis key format. It is built in `packages/backend/libs/domains/discovery/infra/trending-keys.ts#aggregateKey`.
- The spec does not say whether retention and key ownership are enforced: AS-39 has no test carrying its id.
- Per partition window, only a capped number of categories are tracked. Products in other categories count in `all` only, so a category page can miss them.

## Used by
<!-- used-by:start -->
- [S35](../capabilities/S35-trending.md): R-13, R-20
- [add-to-cart-signal](add-to-cart-signal.md)
- [bounded-retention](bounded-retention.md)
- [cold-request](cold-request.md)
- [commit-floor](commit-floor.md)
- [correction-path](correction-path.md)
- [dataset-t](dataset-t.md)
- [dropped-late-event](dropped-late-event.md)
- [event-consumer](event-consumer.md)
- [get-trending](get-trending.md)
- [heavy-hitters](heavy-hitters.md)
- [partition-owner](partition-owner.md)
- [partition-window-merge](partition-window-merge.md)
- [shutdown-deadline](shutdown-deadline.md)
- [top-k-heap](top-k-heap.md)
- [trending-event-weight](trending-event-weight.md)
- [trending-minute-window](trending-minute-window.md)
- [trending-score](trending-score.md)
- [trending-unavailable](trending-unavailable.md)
- [trending-window](trending-window.md)
- [window-merge](window-merge.md)
<!-- used-by:end -->
