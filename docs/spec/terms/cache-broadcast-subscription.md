---
id: cache-broadcast-subscription
title: Broadcast subscription (cache invalidation)
kind: term
status: draft
aliases: [broadcast subscription]
defined_for: S52-cache-toolkit
rules_hash: d41730f60dab
---
# Broadcast subscription (cache invalidation)
## Definition
Each instance keeps a subscription to the [`cache:invalidate` channel](cache-invalidate-channel.md), through [`InvalidationBroadcast`](invalidation-broadcast.md). Through it, the instance learns which [L1](l1-cache.md) copies to drop when another instance calls [`invalidate`](invalidate.md). While the subscription is closed, the instance cannot trust its L1, so reads skip L1 and go to [L2](l2-cache.md) or the [loader](loader.md). When the subscription is restored, the instance clears all of L1 before using it again, because it may have missed invalidations.

## Example
Instance B holds `K` in L1, and B's subscription is closed. Instance A calls `invalidate([K])`.
B serves `K` from L2 or the loader, not from L1. After B resubscribes, it empties its whole L1 and then uses L1 again.

## Known gaps
- The spec does not say how an instance detects that its subscription is closed, or how it retries reconnecting.
- The spec does not say whether a broadcast message can be lost while the subscription looks open. If that happens, only `l1TtlMs` limits how long a stale L1 copy is served.

## Used by
<!-- used-by:start -->
- [S52](../capabilities/S52-cache-toolkit.md): B-11
- [cache-invalidate-channel](cache-invalidate-channel.md)
- [l1-cache](l1-cache.md)
- [l2-cache](l2-cache.md)
- [loader](loader.md)
- [realtime-listener](realtime-listener.md)
<!-- used-by:end -->
