---
id: aggregate-store
title: Aggregate store
kind: term
status: draft
aliases: []
defined_for: S35-trending
rules_hash: 48225308dd83
---
# Aggregate store
## Definition
The aggregate store is the shared store that holds the merged trending counts. They are kept per category and per window, in Redis keys that expire so old data does not pile up. The [stream consumer](event-consumer.md) writes [closed partition windows](trending-window.md) into it through an [idempotent merge](partition-window-merge.md). The trending endpoint reads it to build the ranking. If the store fails or runs over its budget, the endpoint answers [`trending_unavailable`](trending-unavailable.md).

## Example
The consumer closes the 11:42 window for partition `p1` and merges `B 20` into the `audio` key for that window. Later, `GET /api/trending?category=audio` reads the keys for the last 60 windows and sums them. If Redis is down at that moment, the caller gets `503` with `Retry-After: 5`.

## Known gaps
- The spec does not say the exact key layout. The only reference is `trending-keys.ts#aggregateKey`, and the format is not quoted.
- Not confirmed in the code: which store operation makes a replayed merge change the aggregate only once. The spec states the rule (S35.R-20) and names `TrendingAggregateWriter`, but does not describe how it works.

## Used by
<!-- used-by:start -->
- [S35](../capabilities/S35-trending.md): B-17
- [bounded-retention](bounded-retention.md)
- [event-consumer](event-consumer.md)
- [merge-cycle](merge-cycle.md)
- [partition-window-merge](partition-window-merge.md)
- [trending-window](trending-window.md)
<!-- used-by:end -->
