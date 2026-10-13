---
id: l2-cache
title: L2 cache (shared store)
kind: term
status: draft
aliases: [l2]
defined_for: cache-layers
rules_hash: 43d0694f62d4
---
# L2 cache (shared store)
## Definition
L2 is the shared cache layer that all instances read from and write to. [`getOrLoad`](get-or-load.md) checks it after looking in the process's own in-memory copy and before the [loader](loader.md). Instances also use the shared layer to coordinate on each key, so that only one process at a time recomputes a given key. Writers never put values into L2 directly. They can only delete entries with [`invalidate`](invalidate.md).

## Example
If the store fails during `invalidate`, the call does not throw. It resolves with:
```json
{ "l2": "failed", "deleted": 0 }
```

## Known gaps
- The spec does not name the store technology behind L2.
- The spec does not give a size or entry limit for L2. The only limit stated is the per-entry [`maxEntryBytes`](max-entry-bytes.md).

## Used by
<!-- used-by:start -->
- [S05](../capabilities/S05-products.md): B-11
- [S52](../capabilities/S52-cache-toolkit.md): R-01, B-02
- [cache-layers](../concepts/cache-layers.md): C-01, C-06
- [authorization-cache](authorization-cache.md)
- [cache-broadcast-subscription](cache-broadcast-subscription.md)
- [cache-entry](cache-entry.md)
- [cache-invalidate-channel](cache-invalidate-channel.md)
- [cache-invalidator](cache-invalidator.md)
- [cache-loader-busy](cache-loader-busy.md)
- [cache-miss](cache-miss.md)
- [cache-store-circuit-breaker](cache-store-circuit-breaker.md)
- [cache-store-round-trip](cache-store-round-trip.md)
- [cache-unavailable](cache-unavailable.md)
- [corrupt-entry](corrupt-entry.md)
- [durable-conditional-write](durable-conditional-write.md)
- [get-or-load](get-or-load.md)
- [invalid-cache-options](invalid-cache-options.md)
- [invalidate-result](invalidate-result.md)
- [invalidate](invalidate.md)
- [invalidation-broadcast](invalidation-broadcast.md)
- [l1-cache](l1-cache.md)
- [l1-ttl-ms](l1-ttl-ms.md)
- [loader-concurrency-limit](loader-concurrency-limit.md)
- [loader](loader.md)
- [lock-unavailable](lock-unavailable.md)
- [max-entry-bytes](max-entry-bytes.md)
- [might-contain](might-contain.md)
- [pending-count-member](pending-count-member.md)
- [product-view-count](product-view-count.md)
- [recompute-lock](recompute-lock.md)
- [redis-bloom-filter](redis-bloom-filter.md)
- [store-timeout](store-timeout.md)
- [view-count-flush](view-count-flush.md)
- [write-behind-counter](write-behind-counter.md)
- [write-behind-fence-record](write-behind-fence-record.md)
<!-- used-by:end -->
