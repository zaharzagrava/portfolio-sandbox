---
id: l1-cache
title: L1 cache (per-process)
kind: term
status: draft
aliases: [l1]
defined_for: cache-layers
rules_hash: 36b8541ea842
---
# L1 cache (per-process)
## Definition
L1 is the in-process cache layer, so each running instance keeps its own copy. [`getOrLoad`](get-or-load.md) checks it first, before the [L2 cache](l2-cache.md) and the [loader](loader.md). It is bounded by entry count and total size, and it drops the [least recently used ↗](../sw-external-terms.md#lru-eviction) entries first. A copy never stays in L1 longer than [`l1TtlMs`](l1-ttl-ms.md).

## Example
With default settings, an instance holds up to 10,000 entries or 64 MiB in L1. When `invalidate` runs on that instance, it evicts that instance's local L1 copy, even if deleting from L2 failed (`{l2: 'failed', deleted: 0}`).

## Known gaps
- The spec does not say how `invalidate` clears L1 copies held by other instances. The facts only show that `l1TtlMs` bounds how long those copies can stay.

## Used by
<!-- used-by:start -->
- [S52](../capabilities/S52-cache-toolkit.md): R-01, R-18, B-10, B-11
- [cache-layers](../concepts/cache-layers.md): C-01, C-02, C-06, C-07
- [cache-broadcast-subscription](cache-broadcast-subscription.md)
- [cache-entry](cache-entry.md)
- [cache-invalidate-channel](cache-invalidate-channel.md)
- [cache-invalidator](cache-invalidator.md)
- [cache-miss](cache-miss.md)
- [cache-penetration](cache-penetration.md)
- [cache-toolkit](cache-toolkit.md)
- [corrupt-entry](corrupt-entry.md)
- [get-or-load](get-or-load.md)
- [hot-key](hot-key.md)
- [invalid-cache-options](invalid-cache-options.md)
- [invalid-loader-result](invalid-loader-result.md)
- [invalidate](invalidate.md)
- [invalidation-broadcast](invalidation-broadcast.md)
- [l1-ttl-ms](l1-ttl-ms.md)
- [l2-cache](l2-cache.md)
- [loader](loader.md)
- [max-entry-bytes](max-entry-bytes.md)
<!-- used-by:end -->
