---
id: invalidation-broadcast
title: InvalidationBroadcast
kind: term
status: draft
aliases: []
defined_for: S52-cache-toolkit
rules_hash: e3b0c44298fc
---
# InvalidationBroadcast
## Definition
`InvalidationBroadcast` is the [toolkit](cache-toolkit.md) component that subscribes each instance to the [`cache:invalidate` channel](cache-invalidate-channel.md). It lets an instance drop [L1](l1-cache.md) copies when another instance calls `invalidate`. If its subscription closes, reads skip L1 and go to [L2](l2-cache.md) or the [loader](loader.md). Once the subscription is back, all of L1 is cleared before it is used again. The likely reason is that invalidations may have been missed while the subscription was down (design intent, not stated in the spec).

## Example
B's broadcast subscription is closed when instance A calls `invalidate([K])`.
B serves `K` from L2 or the loader, not from L1. After B resubscribes, it empties its whole L1, then uses L1 again.
Code: `packages/backend/libs/infrastructure/cache/broadcast.ts#InvalidationBroadcast`.

## Known gaps
- The spec does not say how `InvalidationBroadcast` detects that its subscription is closed, or how it retries reconnecting.
- The spec does not say what methods `InvalidationBroadcast` exposes, or whether code outside `CacheService` may publish through it.

## Used by
<!-- used-by:start -->
- [cache-invalidate-channel](cache-invalidate-channel.md)
- [cache-toolkit](cache-toolkit.md)
- [l1-cache](l1-cache.md)
- [l2-cache](l2-cache.md)
- [loader](loader.md)
<!-- used-by:end -->
