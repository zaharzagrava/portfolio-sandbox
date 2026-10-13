---
id: cache-toolkit
title: Cache toolkit
kind: term
status: draft
aliases: [toolkit]
defined_for: cache-layers
rules_hash: d2274bff45f2
---
# Cache toolkit
## Definition
The cache toolkit is a shared library that every domain uses to keep fast copies of data that is read far more often than it changes. It provides [L1/L2 layers](l1-cache.md), merging of simultaneous misses for the same key into one load, early refresh of entries before they expire, serving slightly old values while a fresh one loads, remembering that something was not found, a Bloom filter, write-behind counters, a distributed lock and HTTP validators. It never owns business data: the database always wins, and every cached copy can be rebuilt.

## Example
S05 serves product pages through the toolkit's `getOrLoad`. The toolkit checks L1, then L2, then calls the product loader. If several requests miss the same key at once, they share one loader call.

## Known gaps
- The spec does not say how S03, S33, S34, S35 and W02 use the toolkit, even though each one lists it.
- The spec does not say how S05 invalidates its product cache.

## Used by
<!-- used-by:start -->
- [S52](../capabilities/S52-cache-toolkit.md): R-02, R-03, R-20
- [cache-layers](../concepts/cache-layers.md): C-07
- [cache-invalidate-channel](cache-invalidate-channel.md)
- [cache-store-circuit-breaker](cache-store-circuit-breaker.md)
- [cache-store-round-trip](cache-store-round-trip.md)
- [corrupt-entry](corrupt-entry.md)
- [get-or-load](get-or-load.md)
- [invalid-cache-options](invalid-cache-options.md)
- [invalid-loader-result](invalid-loader-result.md)
- [invalidate](invalidate.md)
- [invalidation-broadcast](invalidation-broadcast.md)
- [invalidation-only-writes](invalidation-only-writes.md)
- [jitter](jitter.md)
- [l1-cache](l1-cache.md)
- [loader-concurrency-limit](loader-concurrency-limit.md)
- [max-entry-bytes](max-entry-bytes.md)
- [negative-caching](negative-caching.md)
- [single-flight](single-flight.md)
- [stale-if-error](stale-if-error.md)
- [stale-while-revalidate](stale-while-revalidate.md)
- [xfetch](xfetch.md)
<!-- used-by:end -->
