---
id: loader
title: Loader
kind: term
status: draft
aliases: [loader call, loader error]
defined_for: cache-layers
rules_hash: b6e999f076cf
---
# Loader
## Definition
The loader is the function a caller passes to `getOrLoad` to fetch the real value from the source of truth, such as the database. It runs only when both the L1 cache and the L2 cache miss. If it throws or returns `undefined`, nothing is cached. A `null` result is cached only when `negativeTtlMs` is set. Concurrent misses for one key share one loader call, including a rejection.

## Example
Ten requests for the same product miss at the same moment in one process. The loader runs once, and all ten get its result. If the loader rejects, all ten get the same rejection. If `staleIfErrorMs` is set, they get the stale value instead, until `exp + staleIfErrorMs`.

## Known gaps
- The spec does not say whether the loader gets a timeout or cancellation signal.

## Used by
<!-- used-by:start -->
- [S48](../capabilities/S48-bff.md): R-17
- [S52](../capabilities/S52-cache-toolkit.md): R-01, R-13, B-01, B-04, B-07, B-16
- [cache-layers](../concepts/cache-layers.md): C-01, C-03
- [cache-broadcast-subscription](cache-broadcast-subscription.md)
- [cache-miss](cache-miss.md)
- [cache-penetration](cache-penetration.md)
- [cache-unavailable](cache-unavailable.md)
- [corrupt-entry](corrupt-entry.md)
- [distributed-lock-try-acquire](distributed-lock-try-acquire.md)
- [get-or-load](get-or-load.md)
- [graphql-query-limits](graphql-query-limits.md)
- [invalid-loader-result](invalid-loader-result.md)
- [invalidation-broadcast](invalidation-broadcast.md)
- [invalidation-only-writes](invalidation-only-writes.md)
- [jitter](jitter.md)
- [l1-cache](l1-cache.md)
- [l1-ttl-ms](l1-ttl-ms.md)
- [l2-cache](l2-cache.md)
- [loader-concurrency-limit](loader-concurrency-limit.md)
- [lock-unavailable](lock-unavailable.md)
- [max-entry-bytes](max-entry-bytes.md)
- [might-contain](might-contain.md)
- [minimum-version](minimum-version.md)
- [negative-caching](negative-caching.md)
- [post-api-graphql](post-api-graphql.md)
- [products-ids-limit](products-ids-limit.md)
- [products-ids-query](products-ids-query.md)
- [recompute-lock](recompute-lock.md)
- [redis-bloom-filter](redis-bloom-filter.md)
- [single-flight](single-flight.md)
- [stale-if-error](stale-if-error.md)
- [stale-while-revalidate](stale-while-revalidate.md)
- [store-timeout](store-timeout.md)
- [xfetch](xfetch.md)
<!-- used-by:end -->
