---
id: S52
title: Cache toolkit: L1/L2, single-flight, XFetch, SWR, negative cache, write-behind counters, ETags
kind: capability
status: draft
generated_at: e95ce81
depends_on: []
concepts: [cache-layers]
models: []
scope:
  - packages/backend/libs/domains/developer-platform/**
  - packages/backend/libs/domains/tenancy/**
  - packages/backend/libs/infrastructure/cache/**
---
# S52 - Cache toolkit: L1/L2, single-flight, XFetch, SWR, negative cache, write-behind counters, ETags
## Purpose
Every domain needs copies of data that is read far more often than it changes. This toolkit is the one shared library that keeps those copies. It is a tool, not a store of truth: the database always wins, every copy can be rebuilt, and the toolkit never owns business data. It also provides a Bloom filter, write-behind counters, a distributed lock and HTTP validators (ETag and Cache-Control). The shared idea is described in {{concept:cache-layers}}.

## Entry points
- `CacheService.getOrLoad(key, loader, options)`: reads one key through L1, the shared store (L2) and the loader. [code: packages/backend/libs/infrastructure/cache/cache.service.ts#CacheService]
- `CacheService.getOrLoadMany(keys, batchLoader, options)`: reads many keys with one store read and one loader call.
- `CacheService.invalidate(keys)`: deletes keys from L2 and tells every instance to drop its L1 copy.
- `CacheService.invalidateIfOlder(key, version, options)`: versioned delete that records a minimum accepted version.
- `cacheKey(namespace, version, ...parts)`: builds tenant-safe keys. [code: packages/backend/libs/infrastructure/cache/cache-key.ts#cacheKey]
- `RedisBloomFilter(n, p)`: `add` and `mightContain` for penetration protection. [code: packages/backend/libs/infrastructure/cache/bloom-filter.ts#RedisBloomFilter]
- `WriteBehindCounter`: `increment`, `drain`, `restore`, `claim`, `commit`, `release`, `reclaimExpired`. [code: packages/backend/libs/infrastructure/cache/write-behind-counter.ts#WriteBehindCounter]
- `DistributedLock`: `tryAcquire`, `acquire`, `release`, `extend`, `withLock`, `isNewerFence`. [code: packages/backend/libs/infrastructure/cache/distributed-lock.ts#DistributedLock]
- `VersionEtagInterceptor` and `withEtag`: derive an ETag and answer `304` on `GET` and `HEAD`. [code: packages/backend/libs/infrastructure/cache/etag.interceptor.ts#VersionEtagInterceptor]
- `buildCacheControl(policy)`: builds the `Cache-Control` header. [code: packages/backend/libs/infrastructure/cache/cache-control.ts#buildCacheControl]
- Invalidation channel `cache:invalidate`: every instance subscribes to it to drop L1 copies. [code: packages/backend/libs/infrastructure/cache/broadcast.ts#InvalidationBroadcast]
- The `/fixture/...` routes belong to a test fixture only. [code: packages/backend/libs/infrastructure/cache/testing/http-caching-fixture.ts#HttpCachingFixtureController]

## Rules
- **S52.R-01** [`getOrLoad`](../terms/get-or-load.md) MUST read [L1](../terms/l1-cache.md) (when enabled for the key), then [L2](../terms/l2-cache.md), then the [loader](../terms/loader.md); a stored lifetime with [`ttlMs: 60000` ↗](../sw-external-terms.md#time-to-live) and [default jitter](../terms/jitter.md) MUST lie in 54,000 to 66,000 ms. [proof: S52 AS-01] [code: packages/backend/libs/infrastructure/cache/cache.service.ts#CacheService]
- **S52.R-02** A loader result of `undefined` MUST reject with [`InvalidLoaderResult`](../terms/invalid-loader-result.md); `null` means "not found". [The toolkit](../terms/cache-toolkit.md) MUST store nothing and MUST NOT [cache a loader error](../terms/negative-caching.md). [proof: S52 AS-06] [code: packages/backend/libs/infrastructure/cache/entry-codec.ts#assertJsonValue]
- **S52.R-03** With [`l1: 'never'`](../terms/l1-cache.md) the [instance](../terms/cache-toolkit.md) MUST hold no per-process copy of the key. [proof: S52 AS-03]
- **S52.R-04** L1 MUST hold at most 10,000 [entries](../terms/cache-entry.md) and 64 MiB by default, and MUST drop the [least recently used ↗](../sw-external-terms.md#lru-eviction) entries first. [proof: S52 AS-05] [code: packages/backend/libs/infrastructure/cache/l1-cache.ts#L1Cache]
- **S52.R-05** An L1 copy MUST NOT live longer than [`l1TtlMs`](../terms/l1-ttl-ms.md) (default 1,000 ms, maximum 5,000 ms). [proof: S52 AS-02, S52 AS-10]
- **S52.R-06** An [unparseable stored entry](../terms/corrupt-entry.md) MUST count as a [miss (outcome `corrupt`)](../terms/cache-miss.md) and MUST be overwritten; no error reaches the caller. [proof: S52 AS-07] [code: packages/backend/libs/infrastructure/cache/entry-codec.ts#parseEnvelope]
- **S52.R-07** An entry larger than [`maxEntryBytes`](../terms/max-entry-bytes.md) (default 256 KiB, maximum 1 MiB) MUST be returned to the caller and MUST NOT be stored in L1 or L2; [outcome `oversize`](../terms/cache-miss.md) is counted. [proof: S52 AS-08] [code: packages/backend/libs/infrastructure/cache/entry-codec.ts#encodeEnvelope]
- **S52.R-08** [`cacheKey`](../terms/autocomplete-cache-key.md) MUST [percent-encode ↗](../sw-external-terms.md#percent-encoding) `:`, `{`, `}`, `%`, whitespace and control characters in parts, so a caller part never changes the key structure. [proof: S52 AS-09] [code: packages/backend/libs/infrastructure/cache/cache-key.ts#cacheKey]
- **S52.R-09** An invalid option MUST throw [`InvalidCacheOptions`](../terms/invalid-cache-options.md) naming the field, before any store call. [proof: S52 AS-10] [code: packages/backend/libs/infrastructure/cache/cache-options.ts#resolveGetOrLoadOptions]
- **S52.R-10** [Concurrent misses for one key in one process MUST share one loader call ↗](../sw-external-terms.md#single-flight), including a rejection; the [in-flight entry ↗](../sw-external-terms.md#single-flight) MUST be removed when the call settles. [proof: S52 AS-12, S52 AS-15] [code: packages/backend/libs/infrastructure/cache/single-flight.ts#SingleFlight]
- **S52.R-11** Across instances, one process MUST hold the [per-key recompute lock](../terms/recompute-lock.md) (lifetime 5 s); a [release](../terms/concurrency-lease-release.md) MUST NOT delete a lock owned by another holder. [proof: S52 AS-13, S52 AS-14]
- **S52.R-12** Past its [soft expiry](../terms/soft-expiry.md) and inside [`swrMs`](../terms/stale-while-revalidate.md), an [entry](../terms/cache-entry.md) MUST be returned at once with one background refresh; at `exp + swrMs` it MUST be a [miss](../terms/cache-miss.md). [proof: S52 AS-16, S52 AS-17]
- **S52.R-13** With [`staleIfErrorMs`](../terms/stale-if-error.md), a rejecting [loader](../terms/loader.md) MUST return the stale value (outcome [`stale_error`](../terms/cache-miss.md)) while `now` is within `exp + staleIfErrorMs`; later the loader error MUST propagate. [proof: S52 AS-18]
- **S52.R-14** [XFetch](../terms/xfetch.md) MUST choose early refresh exactly when `now − delta·beta·ln(r) ≥ expiry`. [proof: S52 AS-19] [code: packages/backend/libs/infrastructure/cache/xfetch.ts#shouldRecomputeEarly]
- **S52.R-15** Lifetimes MUST be [jittered](../terms/jitter.md) by `jitter` (default 0.1, range 0 to 0.5); `jitter: 0` MUST give exactly [`ttlMs` ↗](../sw-external-terms.md#time-to-live). [proof: S52 AS-20] [code: packages/backend/libs/infrastructure/cache/xfetch.ts#jitterTtl]
- **S52.R-16** A `null` result MUST be stored only when [`negativeTtlMs`](../terms/negative-caching.md) is set; negative entries MUST ignore [SWR](../terms/stale-while-revalidate.md) and stale-if-error. [proof: S52 AS-22, S52 AS-23, S52 AS-24]
- **S52.R-17** The [Bloom filter ↗](../sw-external-terms.md#bloom-filter) MUST have zero false negatives, MUST answer `true` when the store is unreachable, and `add` MUST reject with [`CacheUnavailable`](../terms/cache-unavailable.md) then. [proof: S52 AS-26, S52 AS-28] [code: packages/backend/libs/infrastructure/cache/bloom-filter.ts#RedisBloomFilter]
- **S52.R-18** [`invalidate`](../terms/invalidate.md) MUST NOT throw on store failure; it MUST resolve [`{l2: 'failed', deleted: 0}`](../terms/invalidate-result.md) and evict the local [L1](../terms/l1-cache.md) copy. [proof: S52 AS-30]
- **S52.R-19** A store of a loaded value MUST be refused when its [version](../terms/published-version.md) is below the key's [minimum](../terms/min-version.md); the caller still receives the value. [proof: S52 AS-36, S52 AS-37]
- **S52.R-20** The [toolkit](../terms/cache-toolkit.md) MUST NOT expose any method that stores a caller-supplied value; [writers only delete](../terms/invalidation-only-writes.md). [proof: S52 AS-40]

## Behaviors
- **S52.B-01** Given an empty store, when [`getOrLoad`](../terms/get-or-load.md) runs twice for one key, then the [loader](../terms/loader.md) runs once and both calls return the same value. [proof: S52 AS-01]
- **S52.B-02** Given [`l1: 'always'`](../terms/l1-cache.md) and `l1TtlMs: 1000`, when a key is read twice within 1 s, then the second read makes no [store call](../terms/l2-cache.md); after 1,001 ms the read comes from the store. [proof: S52 AS-02]
- **S52.B-03** Given [`l1: 'hot'`](../terms/l1-cache.md) (default), when a key is read 25 times in one [10 s window](../terms/hot-key.md), then the next window serves it from L1 and a key read once is not in L1. [proof: S52 AS-04]
- **S52.B-04** Given 100 keys of which 40 are cached, when [`getOrLoadMany`](../terms/get-or-load.md) runs, then the store is read once and the [batch loader](../terms/loader.md) receives the 60 missing keys in input order. [proof: S52 AS-11]
- **S52.B-05** Given a [cold key](../terms/cache-miss.md) and 200 [concurrent reads ↗](../sw-external-terms.md#single-flight), when the loader takes 100 ms, then the loader runs once and all 200 calls resolve with the same value. [proof: S52 AS-12]
- **S52.B-06** Given three instances and 300 concurrent reads of a cold key, then the loader runs once in total and [followers ↗](../sw-external-terms.md#single-flight) read [the leader's stored value](../terms/recompute-lock.md). [proof: S52 AS-13]
- **S52.B-07** Given 50 concurrent reads and [a rejecting loader](../terms/loader.md), then all reject with the same error, nothing is stored and the next read calls the loader again. [proof: S52 AS-15]
- **S52.B-08** Given a loader returning `null` and [`negativeTtlMs: 10000`](../terms/negative-caching.md), when the key is read five times, then the loader runs once and repeated reads have [outcome `negative`](../terms/cache-miss.md). [proof: S52 AS-22]
- **S52.B-09** Given a [negative entry](../terms/negative-caching.md), when the owner calls [`invalidate([K])`](../terms/invalidate.md) after creating the item, then the next read loads the item. [proof: S52 AS-25]
- **S52.B-10** Given [instance B holds `K` in L1](../terms/l1-cache.md), when instance A calls `invalidate([K])`, then A resolves [`{l2: 'ok', deleted: 1}`](../terms/invalidate-result.md) and B loads the new value within 1 s. [proof: S52 AS-29]
- **S52.B-11** Given B's [broadcast subscription](../terms/cache-broadcast-subscription.md) is closed, when A [invalidates](../terms/invalidate.md) `K`, then B bypasses [L1](../terms/l1-cache.md) and, after restoring the subscription, clears all of L1 before using it. [proof: S52 AS-31]
- **S52.B-12** Given 5,000 keys with duplicates, when [`invalidate`](../terms/invalidate.md) runs, then duplicates are removed and at most 10 [store round trips](../terms/cache-store-round-trip.md) occur; an empty array makes no store call. [proof: S52 AS-32]
- **S52.B-13** Given `K` at version 3, when [`invalidateIfOlder(K, 4)`](../terms/invalidate-if-older.md) runs, then the result is [`applied`](../terms/invalidate-result.md), the entry is gone and [the minimum is 4](../terms/minimum-version.md); a repeat or a late `invalidateIfOlder(K, 4)` after version 5 returns [`skipped`](../terms/invalidate-result.md). [proof: S52 AS-33, S52 AS-34, S52 AS-35]
- **S52.B-14** Given a reader that loaded version 3 before version 4 committed, when the reader finishes, then it returns version 3 to its caller but [stores nothing](../terms/min-version.md). [proof: S52 AS-36]
- **S52.B-15** Given the store refuses connections, when 100 concurrent reads arrive, then all resolve from [one loader call ↗](../sw-external-terms.md#single-flight) and the outcome [`degraded`](../terms/cache-miss.md) is counted. [proof: S52 AS-42]
- **S52.B-16** Given a store that never answers, when a key is read, then the store attempt ends after [250 ms](../terms/store-timeout.md) and the [loader](../terms/loader.md) answers. [proof: S52 AS-43]
- **S52.B-17** Given 5 consecutive store failures within 10 s, then [the store is skipped](../terms/cache-store-circuit-breaker.md) for 5 s, after which one [probe](../terms/circuit-breaker-probe.md) call decides whether [the breaker closes ↗](../sw-external-terms.md#circuit-breaker). [proof: S52 AS-44]
- **S52.B-18** Given the store is down and 500 reads of distinct keys, then [at most 100 loaders run at once](../terms/loader-concurrency-limit.md) and callers waiting over 2 s reject with [`CacheLoaderBusy`](../terms/cache-loader-busy.md). [proof: S52 AS-45]
- **S52.B-19** Given the store returns after an outage, when the key is read, then the entry is stored and the next read is [`l2`](../terms/l2-cache.md). [proof: S52 AS-46]
- **S52.B-20** Given the store is down, then a read proceeds without the [recompute lock](../terms/recompute-lock.md), while [`DistributedLock.tryAcquire`](../terms/distributed-lock-try-acquire.md) rejects with [`LockUnavailable`](../terms/lock-unavailable.md). [proof: S52 AS-47]

## Lifecycles
None. The toolkit has no business status. A cache entry only moves from fresh to stale (within `swrMs`) to gone, by the clock.

## Owns
- Cache entries in the shared store, keyed `<namespace>:v<version>:<part>:…`. Each entry holds the value, soft expiry, hard expiry, load time and optional version.
- Auxiliary records next to each entry: recompute lock (`{key}:lock`) and minimum version (`{key}:min`).
- Pub/sub channel `cache:invalidate`.
- Counter, in-flight batch and fence records of `WriteBehindCounter` and `DistributedLock`.
- Metrics `cache_requests_total{namespace, outcome}`, `cache_loader_calls_total{namespace}`, `cache_invalidations_total{result}` and a loader duration histogram.
- Configuration: `CACHE_TOOLKIT_CONFIG` (`CacheToolkitConfig`). [code: packages/backend/libs/infrastructure/cache/cache.config.ts#CACHE_TOOLKIT_CONFIG]
- It owns no database table.

## Decisions
- The database wins and every copy can be rebuilt, so the toolkit never stores a caller-supplied value; writers delete.
- Two levels (L1 and L2) keep hot reads off the network while a shared store keeps instances consistent.
- The recompute lock fails open (it only saves effort); `DistributedLock` fails closed (it protects correctness).
- When the store is down, reads answer from the single-flighted loader, with a circuit breaker and a loader bulkhead to protect the database.
- Versioned invalidation with a time-bounded minimum stops a slow reader from resurrecting old data.
- Logs carry a key digest of 8 hex characters and never values or full keys, to protect tenant data.
- Time and randomness are injected, so expiry decisions are reproducible in tests.
- Counters MUST NOT hold money or any count whose loss is not acceptable.

## Known gaps
- Write-behind counters (AS-49 to AS-56), the distributed lock (AS-57 to AS-63), HTTP validators (AS-64 to AS-70) and operations (AS-71 to AS-74) are P2. Tests exist, but this page states no rule for them beyond those listed; they need a second pass.
- AS-14 (a dead lock holder) and AS-38 (unversioned values with a minimum) are cut off in the work-order text; the full behavior is unverified here.
- AS-39 (minimum retention, default 300 s, range 1 to 3,600 s) is tested only in `cache-options.spec.ts`, not end to end.
- Hot-key detector limits (at most 10,000 tracked keys per window) and the empty-when-idle tables (FR-003) have no named proof.
- AS-48 (L1 served while the store is down) is tested, but no rule above states it.
- The shutdown wait of 5 s (FR-044) and the `/fixture/...` routes are test support only; production routes do not exist in this capability.
- Several domain files (billing, catalog, discovery and others) appear in the file list as users of the toolkit; this page does not describe their behavior.