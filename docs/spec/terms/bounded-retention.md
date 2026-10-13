---
id: bounded-retention
title: Bounded retention
kind: term
status: draft
aliases: [retention]
defined_for: S35-trending
rules_hash: e3b0c44298fc
---
# Bounded retention
## Definition
Bounded retention means each [trending aggregate](trending-aggregate.md) key in Redis expires after a fixed maximum lifetime. It applies to the keys kept per category and per [trending window](trending-window.md). Keys for old windows therefore disappear on their own, and the [aggregate store](aggregate-store.md) does not grow without limit. The [ranking](trending-ranking-cache.md) reads only recent windows, so expired keys are never needed for a score.

## Example
The consumer merges the 11:00 window for `audio` into its aggregate key. The key can live for at most 10,800 s (3 hours). By then the window is far outside the 60 windows that [`GET /api/trending`](get-trending.md) sums.
Keeping keys longer than the [ranking span](ranking-span.md) is design intent (not stated in the spec). The likely reason is to leave room for [late corrections](allowed-lateness.md) and [replayed merges](window-merge.md).

## Known gaps
- The spec does not say whether retention is set as a [Redis TTL ↗](../sw-external-terms.md#time-to-live) on each key or done by a cleanup step. It also does not say whether a later merge resets the lifetime. The only reference is `trending-keys.ts#aggregateKey`.
- The spec does not say how retention is proven. AS-39 (retention and key ownership) has no test carrying its id.
- The spec does not say whether the maximum lifetime comes from a [`TRENDING_*` variable](trending-configuration.md) or is fixed in code. The listed configuration defaults do not include it.

## Used by
<!-- used-by:start -->
- [aggregate-store](aggregate-store.md)
- [allowed-lateness](allowed-lateness.md)
- [outbox-purge-job](outbox-purge-job.md)
- [ranking-span](ranking-span.md)
- [trending-aggregate](trending-aggregate.md)
- [trending-configuration](trending-configuration.md)
- [trending-ranking-cache](trending-ranking-cache.md)
- [trending-window](trending-window.md)
- [window-merge](window-merge.md)
<!-- used-by:end -->
