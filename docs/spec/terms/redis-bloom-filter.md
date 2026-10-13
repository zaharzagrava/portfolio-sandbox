---
id: redis-bloom-filter
title: RedisBloomFilter
kind: term
status: draft
aliases: [bloom filter, bloomfilter]
defined_for: S52-cache-toolkit
rules_hash: e3b0c44298fc
---
# RedisBloomFilter
## Definition
`RedisBloomFilter` is the toolkit's [Bloom filter ↗](../sw-external-terms.md#bloom-filter), and its state lives in the [shared store](l2-cache.md). It protects against [cache penetration](cache-penetration.md), where repeated lookups for items that do not exist reach the [loader](loader.md) and the database every time. It has two operations. `add` records an item, and `mightContain` asks whether an item may have been added. It never gives a [false negative ↗](../sw-external-terms.md#bloom-filter). When the store cannot be reached, `add` rejects with [`CacheUnavailable`](cache-unavailable.md) and `mightContain` answers `true`.

## Example
```ts
const filter = new RedisBloomFilter(n, p);   // n and p values are not given in the spec
await filter.add(productId);                  // when the item is created
if (!(await filter.mightContain(productId))) { /* definitely never added: skip the loader */ }
```
If the store is down, `add` rejects with `CacheUnavailable` and `mightContain` answers `true`.

## Known gaps
- The spec does not say what the constructor arguments `n` and `p` mean. A Bloom filter usually takes the expected number of items and the false-positive rate, but this is not confirmed here.
- The spec does not say how the filter handles deleted items or a filter that grows past `n`, or whether it can be rebuilt. A standard Bloom filter cannot remove items.
- The spec does not say whether `getOrLoad` checks the filter automatically or each caller must call `mightContain` itself.

## Used by
<!-- used-by:start -->
- [cache-penetration](cache-penetration.md)
- [l2-cache](l2-cache.md)
- [loader](loader.md)
<!-- used-by:end -->
