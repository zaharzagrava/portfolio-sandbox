# Contract: `@app/infrastructure/cache`

Source of truth for names and signatures: `spec.md` section "Provides". This file records the shapes the implementation exports and the tests assert; it adds nothing to them.

## Module and services

- `CacheModule` (global) provides `CacheService`, `DistributedLock`, `VersionEtagInterceptor`.
- `CacheService`
  - `getOrLoad<T>(key, loader, options: GetOrLoadOptions): Promise<T | null>`
  - `getOrLoadMany<T>(keys, batchLoader: (missing: string[]) => Promise<Map<string, T | null>>, options): Promise<(T | null)[]>` (≤ 500 keys)
  - `invalidate(keys): Promise<{ l2: 'ok' | 'failed'; deleted: number }>` (≤ 5,000 keys, never throws on store failure)
  - `invalidateIfOlder(key, version, { minimumRetentionMs? }): Promise<{ outcome: 'applied' | 'skipped' }>`
  - no `set`/`put` member (AS-40, `expectTypeOf`).
- `GetOrLoadOptions = { ttlMs; swrMs?; staleIfErrorMs?; negativeTtlMs?; jitter? = 0.1; l1? = 'hot'; l1TtlMs?; timeoutMs? = 250; maxEntryBytes?; versionOf? }`.
- `cacheKey(namespace, version, ...parts): string` → `<namespace>:v<version>:<encoded parts joined by ':'>`.
- `RedisBloomFilter(redis, key, expectedItems, falsePositiveRate)`: `add(items)`, `mightContain(item)`, `bits`, `hashes`.
- `WriteBehindCounter(redis, name)`: `increment(member, by = 1)`, `drain()`, `restore(deltas)`, `claim()`, `commit(batchId)`, `release(batchId)`, `reclaimExpired()`.
- `DistributedLock`: `tryAcquire`, `acquire`, `withLock`; `Lock = { resource, token, fence, release(), extend(ttlMs) }`; `isNewerFence(current, presented)`.
- HTTP: `VersionEtagInterceptor`, `withEtag(body, etag)`, `matchesIfNoneMatch(header, etag)`, `buildCacheControl(policy)`.

## Errors

`InvalidCacheKey`, `InvalidCacheOptions` (carries the field name), `InvalidLoaderResult`, `CacheUnavailable`, `CacheLoaderBusy` (503 + `Retry-After`), `CounterOverflow`, `InvalidIncrement`, `LockTimeout` (503 + `Retry-After`), `LockUnavailable`.

## Store protocol (internal; asserted by e2e through the real store)

- Broadcast channel `cache:invalidate`; message = JSON list of keys (plain drop) or `{key, version}` (versioned drop).
- Invalidation round trips: ≤ 10 for 5,000 keys; deletes use `UNLINK`.

## Metrics (names exact, label `namespace` only unless noted)

`cache_requests_total{namespace, outcome}`, `cache_loader_calls_total`, `cache_loader_duration_seconds`, `cache_invalidations_total{result}`, `cache_breaker_state`, `cache_l1_entries`, `cache_counter_pending_members{counter}`, `cache_lock_acquisitions_total{outcome}`.

## HTTP behaviour (ETag interceptor)

- GET/HEAD, 2xx, JSON object body only. `ETag: W/"<id>-v<version>"` or the verbatim `withEtag` value.
- `If-None-Match`: list, weak comparison, `*`; malformed never matches.
- Match → `304`, empty body, `ETag` + handler-set `Cache-Control`, `Cache-Tag`, `Vary`, `Content-Language`, `Content-Location` kept; `Content-Length`, `Content-Type`, `Content-Encoding` dropped.
- Never on errors or unsafe methods; handler's `Cache-Control` never overwritten.
