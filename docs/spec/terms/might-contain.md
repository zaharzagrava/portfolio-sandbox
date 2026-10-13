---
id: might-contain
title: mightContain
kind: term
status: draft
aliases: []
defined_for: S52-cache-toolkit
rules_hash: e3b0c44298fc
---
# mightContain
## Definition
`mightContain` is the read operation of [`RedisBloomFilter`](redis-bloom-filter.md). `false` means the item was definitely never added. `true` means the item may have been added. Callers use a `false` answer to skip [the loader](loader.md) for items that cannot exist. When [the shared store](l2-cache.md) is unreachable, it answers `true` and does not fail, so the filter still never gives a [false negative ↗](../sw-external-terms.md#bloom-filter).

## Example
- `mightContain("p_unknown")` → `false`: the caller answers "not found" without calling the loader. (The id is illustrative.)
- `mightContain(productId)` while the store is down → `true`: the caller goes on to the loader as usual.

## Known gaps
- The spec does not say what happens to an item whose `add` rejected with [`CacheUnavailable`](cache-unavailable.md). That item is missing from the filter, so a later `mightContain` could wrongly answer `false` for it.
- The spec does not say whether a timeout or the [cache store circuit breaker](cache-store-circuit-breaker.md) counts as "unreachable" here.

## Used by
<!-- used-by:start -->
- [cache-store-circuit-breaker](cache-store-circuit-breaker.md)
- [l2-cache](l2-cache.md)
- [loader](loader.md)
<!-- used-by:end -->
