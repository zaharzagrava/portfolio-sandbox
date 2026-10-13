---
id: get-or-load
title: getOrLoad
kind: term
status: draft
aliases: []
defined_for: cache-layers
rules_hash: e3b0c44298fc
---
# getOrLoad
## Definition
`getOrLoad` is the main read call of the [cache toolkit](cache-toolkit.md) (capability S52). It returns a cached value for a key from the [L1 cache](l1-cache.md) (when L1 is enabled for that key) or the [L2 cache](l2-cache.md). Only on a [miss](cache-miss.md) in both layers does it run the [loader](loader.md). It never caches a loader error or an `undefined` result. When several callers miss on the same key at the same time, [they share one loader call](single-flight.md).

## Example
S05 serves a product page by calling `getOrLoad` with the product's key. If neither L1 nor L2 holds it, the loader reads the product from the database. Callers that miss on the same key at the same moment wait for that one load.
```
getOrLoad("product:123", loadProductFromDb)   // key and function name are illustrative
```

## Known gaps
- The spec does not say the exact signature of `getOrLoad` or which options it takes per call.
- The spec does not say how L1 is turned on or off for a given key.

## Used by
<!-- used-by:start -->
- [cache-miss](cache-miss.md)
- [cache-toolkit](cache-toolkit.md)
- [l1-cache](l1-cache.md)
- [l2-cache](l2-cache.md)
- [loader](loader.md)
- [single-flight](single-flight.md)
<!-- used-by:end -->
