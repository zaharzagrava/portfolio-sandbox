---
id: cache-penetration
title: Cache penetration
kind: term
status: draft
aliases: []
defined_for: S52-cache-toolkit
rules_hash: f939a7c0797e
---
# Cache penetration
## Definition
[Cache penetration ↗](../sw-external-terms.md#cache-penetration-concept) happens when many reads ask for items that do not exist. These reads miss [L1 and L2](l1-cache.md) every time, so each one reaches the [loader](loader.md) and the database. In this toolkit, [`RedisBloomFilter`](redis-bloom-filter.md) provides the named protection against it. A caller asks [`mightContain`](might-contain.md) first, and a `false` answer means the item was never added, so the loader can be skipped. When the shared store cannot be reached, the filter answers `true`, so the protection switches off and reads fall through to the loader.

## Example
A client keeps requesting a product ID that was never created (values are illustrative):
```ts
if (!(await filter.mightContain('prod_missing_123'))) return null;   // never added: no loader, no database
return cache.getOrLoad(key, () => db.findProduct('prod_missing_123'), { negativeTtlMs: 10000 });
```
Without the check, every such request runs the loader. With [`negativeTtlMs`](negative-caching.md) set, repeats of the same missing key get outcome `negative` until that entry expires.

## Known gaps
- The spec does not say whether `getOrLoad` checks the Bloom filter automatically. The caller may have to call `mightContain` itself.
- The spec does not describe negative caching (`negativeTtlMs`) as penetration protection. Using it this way is general engineering practice, not stated design intent.
- The spec does not say whether a metric counts reads that the filter blocked. The listed metrics only cover cache outcomes, loader calls and invalidations.

## Used by
<!-- used-by:start -->
- [S05](../capabilities/S05-products.md): B-10
- [l1-cache](l1-cache.md)
- [loader](loader.md)
- [redis-bloom-filter](redis-bloom-filter.md)
<!-- used-by:end -->
