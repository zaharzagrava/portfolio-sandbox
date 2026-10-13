---
id: cache-unavailable
title: CacheUnavailable
kind: term
status: draft
aliases: []
defined_for: S52-cache-toolkit
rules_hash: e3b0c44298fc
---
# CacheUnavailable
## Definition
`CacheUnavailable` is the error that [`RedisBloomFilter.add`](redis-bloom-filter.md) rejects with when the [shared store](l2-cache.md) cannot be reached. While the store is down, [`mightContain`](might-contain.md) does not fail: it answers `true` ("maybe present"). That keeps the filter's promise of [zero false negatives ↗](../sw-external-terms.md#bloom-filter). Design intent (not stated in the spec): when the store is down, the filter lets requests through to the [loader](loader.md) rather than wrongly turning away items that exist.

## Example
Store unreachable:
- `bloomFilter.add(productId)` rejects with `CacheUnavailable`.
- `bloomFilter.mightContain(productId)` answers `true`, so the caller goes on to the loader.

## Known gaps
- The spec does not say how a caller should recover from a rejected `add`. An item whose `add` failed is not in the filter, so a later `mightContain` could answer `false` for an item that exists.
- The spec does not say whether other parts of the toolkit, such as [`WriteBehindCounter`](write-behind-counter.md), also use `CacheUnavailable`. `DistributedLock` uses [`LockUnavailable`](lock-unavailable.md) instead.

## Used by
<!-- used-by:start -->
- [l2-cache](l2-cache.md)
- [loader](loader.md)
<!-- used-by:end -->
