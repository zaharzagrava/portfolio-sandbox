---
id: cache-entry
title: Cache entry
kind: term
status: draft
aliases: [entries, entry]
defined_for: cache-layers
rules_hash: 0c730f7bcf4d
---
# Cache entry
## Definition
A cache entry is one stored value for one key, kept in a single process's own memory and/or the [L2 cache](l2-cache.md). It has an earlier point after which it counts as old, and a hard expiry (`exp`). Between those two points, it can still be served while a fresh value is fetched, or when fetching a fresh value fails. Its lifetimes are varied by a small random amount. An entry can also record a `null` result, and an entry that cannot be parsed counts as a miss (outcome `[corrupt](corrupt-entry.md)`) and is overwritten.

## Example
A product entry is past its soft expiry but still inside `swrMs`. [`getOrLoad`](get-or-load.md) returns it immediately and starts one background refresh. A result over [`maxEntryBytes`](max-entry-bytes.md) (default 256 KiB) is returned to the caller but never stored as an entry.

## Known gaps
- The spec does not say how an entry is serialised, or which fields it stores besides `exp`.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): B-06
- [S05](../capabilities/S05-products.md): R-08, R-14, B-12
- [S33](../capabilities/S33-autocomplete.md): R-15, B-12
- [S34](../capabilities/S34-recommendations.md): R-12, R-19
- [S52](../capabilities/S52-cache-toolkit.md): R-04, R-12
- [cache-layers](../concepts/cache-layers.md): C-02
- [authorization-cache](authorization-cache.md)
- [autocomplete-cache-key](autocomplete-cache-key.md)
- [cache-invalidator](cache-invalidator.md)
- [catalog-product-deleted-event](catalog-product-deleted-event.md)
- [hot-key](hot-key.md)
- [invalidate](invalidate.md)
- [invalidation-only-writes](invalidation-only-writes.md)
- [jitter](jitter.md)
- [l1-cache](l1-cache.md)
- [l2-cache](l2-cache.md)
- [max-entry-bytes](max-entry-bytes.md)
- [minimum-version](minimum-version.md)
- [negative-caching](negative-caching.md)
- [no-op-update](no-op-update.md)
- [normalised-text](normalised-text.md)
- [product-command-service](product-command-service.md)
- [product-stock-service](product-stock-service.md)
- [product-version](product-version.md)
- [reduced-prefix](reduced-prefix.md)
- [single-flight](single-flight.md)
- [soft-expiry](soft-expiry.md)
- [source-of-truth](source-of-truth.md)
- [stale-if-error](stale-if-error.md)
- [stale-while-revalidate](stale-while-revalidate.md)
- [xfetch](xfetch.md)
<!-- used-by:end -->
