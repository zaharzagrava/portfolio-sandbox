# Questions and defaults: S52 — Cache toolkit

Unattended run: no question was asked; each line records the default the spec chose. Decision policy: the most production-grade option the Interview-Prep notes and the constitution support wins over today's behaviour. Sorted by impact, BREAKING first. Format: `[TAG] question → default → why`.

## BREAKING (changes behaviour or an API that exists today; implementation updates callers and tests)

- [BREAKING] `invalidate(keys)` throws when the store fails and returns `void` (`cache.service.ts:109-114`) → it never throws on store failure, evicts the local L1 anyway and resolves `{l2: 'ok' | 'failed', deleted}` → a failed cache delete must never fail a business write (S05 FR-023, AS-34); callers that awaited `void` keep working, callers that relied on the throw to retry must read `l2`.
- [BREAKING] Recompute lock release is an unconditional `DEL` and the background (SWR / XFetch) refresh takes no cross-instance lock (`cache.service.ts:98,124`) → release is owner-token checked and atomic, and every refresh (early, stale, miss) takes the per-key lock → notes §4 and §6: a holder that outlives its lock must not delete the next holder's; N instances must not all refresh at expiry.
- [BREAKING] Negative entries get the SWR window added to their hard expiry and are served stale (`cache.service.ts:144`) → negative entries ignore SWR and stale-if-error → a stale "not found" hides an item created during the window (S05 AS-31).
- [BREAKING] `VersionEtagInterceptor` compares `If-None-Match` by string equality, falls back to a shared id `'r'`, runs on any method and drops the handler's headers on 304 (`etag.interceptor.ts:19-26`) → RFC 9110 weak comparison over lists and `*`, GET/HEAD only, no id means no validator, `304` repeats `ETag`, `Cache-Control`, `Cache-Tag`, `Vary`, `Content-Language`, drops body headers, no validator on errors → P0410 and S27 AS-26 require it; a shared `'r'` id is wrong.
- [BREAKING] Unparseable entries make the read fall into the "Redis down" path without repair (`cache.service.ts:88`) → treated as a miss, overwritten, counted `corrupt` → one bad value must not disable caching of a key forever.
- [BREAKING] Loader `undefined` is stored as an envelope whose value serializes to nothing, and non-JSON values throw from `JSON.stringify` after the loader ran → `InvalidLoaderResult` before anything is stored → fail loudly at the first call, not as a silent miss loop.
- [BREAKING] Options are not validated (any `ttlMs`, `negativeTtlMs` with `!`, `l1TtlMs` unbounded) → every option validated, `InvalidCacheOptions` names the field → a 0 or negative TTL or an unbounded L1 lifetime is a production incident waiting.
- [BREAKING] L1 is used regardless of the health of the broadcast subscription, and a dropped subscription is never re-established or flushed (`cache.service.ts:65-67`) → L1 only while the subscription is healthy, cleared on reconnect → otherwise a lost message serves stale data until `l1TtlMs` forever and invisibly.
- [BREAKING] No explicit timeout on store calls, no breaker, no loader cap (only ioredis retry settings) → 250 ms per call, breaker 5/10 s/5 s, loader bulkhead 100 with 2 s queue and `CacheLoaderBusy` → notes §8 "fail open, with care so the DB doesn't overload"; S05 AS-34 requires the 250 ms bound.
- [BREAKING] Entries have no size limit → 256 KiB default (max 1 MiB) is returned but never stored → big keys block the store (notes §4 big keys; S05 AS-37).
- [BREAKING] Deletes use `DEL` → `UNLINK` (non-blocking) → notes §4 big keys; S05 AS-37.
- [BREAKING] Keys are free strings (`getOrLoad('anything')`) → keys validated (non-empty, ≤ 512 bytes, namespaced with `:`, no whitespace) and a tenant-safe `cacheKey()` builder is offered → a part containing `:`, `{`, `}` could collide with another key or move it to another shard; existing callers whose keys have no namespace must be renamed.
- [BREAKING] Metric `cache_requests_total` has only `outcome`, counts a negative hit as `l2` and a stored `null` as `miss` → labels `namespace` and `outcome` with a distinct `negative`, plus `degraded`, `corrupt`, `oversize`, `stale_error`, `refused_*` → hit ratio per namespace is the first thing an operator asks (notes §8); dashboards and tests that read the old counter change.
- [BREAKING] `RedisBloomFilter.mightContain` rejects when the store fails and sizes are unchecked → answers `true` (cannot prove absence) and counts it; `n`, `p` and 2³² bits validated → a membership guard must not turn a cache outage into a read outage; S37/S41 callers keep the same constructor.
- [BREAKING] `WriteBehindCounter.increment` accepts any number (`by = 0`, `1.5`, `NaN`) and any member, and the pending hash is unbounded → non-zero safe integer, member ≤ 256 bytes, name pattern, 100,000-member cap with `CounterOverflow` → the pending hash is a memory-leak vector otherwise (P0105); `catalog` and `community` callers verified compatible (names `product-views`, `vote-deltas`).
- [BREAKING] Background refreshes are fire-and-forget (`cache.service.ts:98`) and shutdown only closes the subscriber (`:70-72`) → refreshes are tracked, awaited up to 5 s on shutdown, every in-process table is bounded or empty when idle → P0105 "bounded maps, listener cleanup"; VIII.4 graceful shutdown.
- [BREAKING] Existing callers use keys such as `experiments:running`, `auth:user:v1:<sub>`, `launch-event:v1:<id>` → these already satisfy the key rules; any key found without a `:` namespace is renamed with its owner's version bump → checked by reading the callers, enforced by `InvalidCacheKey`.

## CONTRACT (decides something another capability must provide or consume)

- [CONTRACT] S05 asked for versioned entries, `invalidateIfOlder(key, version)`, a 250 ms timeout and non-blocking delete → provided as `versionOf` option, `invalidateIfOlder(key, version, {minimumRetentionMs}) → {outcome: 'applied' | 'skipped'}`, `timeoutMs` default 250, `UNLINK`; S05's `applied` / `skipped` metric outcomes are `cache_invalidations_total{result}`; S05 keeps owning AS-39–AS-47 → the notes' "versioned values" mitigation (§3) cannot be built in a domain.
- [CONTRACT] S05 AS-38 (100 cold IDs → one statement) needs a batch read that S05's contract line does not list → `getOrLoadMany(keys, batchLoader, options)` added (≤ 500 keys, one store read, one loader call) → otherwise S05 would loop `getOrLoad` (N+1, IX.7 R1).
- [CONTRACT] S11 asked for `getOrLoad` with `jitter`, and offered a local promise-coalescing map if S52 could not → S52 provides `jitter` (0–0.5, default 0.1, 0 disables); S11 should use the toolkit, no local map → P0324 stampede protection stays in one place.
- [CONTRACT] S27 supplies a strong ETag `"<id>-v<version>-<locale>"` and sets its own `Cache-Control`/`Cache-Tag` → `withEtag(body, etag)` emits it verbatim, `matchesIfNoneMatch` evaluates lists, weak and `*`, `304` repeats the handler's headers → P0410 co-owned with S27; the CDN purge and tags stay S27.
- [CONTRACT] S18 wants version-guarded invalidation, stale-on-error and "a slow load never overwrites a newer state" → `invalidateIfOlder` + `versionOf` + `staleIfErrorMs` cover it; S18's "different subscription always drops" is a plain `invalidate` by S18's consumer → keeps S18's rules in S18.
- [CONTRACT] S28, S44 forbid a per-process copy of preference, suppression, site records → they pass `l1: 'never'`, which guarantees no L1 copy (FR-002); the default stays `hot` for everyone else → bounded staleness only where the owner accepts it.
- [CONTRACT] S44 asked for "a single-use set-if-absent marker with fail-closed behaviour" → no new primitive: `DistributedLock.tryAcquire(resource, {ttlMs})` held for its lifetime and never released, rejecting `LockUnavailable` when the store is down → one lock primitive is easier to prove than two.
- [CONTRACT] S22 (seat holds, admission) and S49 (leader lock) → `DistributedLock` with fencing tokens is provided (P0326); S22/S49 may adopt it, S52 does not force migration; protected writes compare `fence` with `isNewerFence` or `WHERE fence < $token` → notes §6: "for correctness, use fencing tokens".
- [CONTRACT] S05 and S25 flush jobs use `drain`/`restore` → both kept unchanged; crash-safe `claim`/`commit`/`release`/`reclaimExpired` are additive; the flush job should apply a claimed batch idempotently by `batchId` → today a flusher crash between `drain` and the database write loses the counts.
- [CONTRACT] Shared store client (`infrastructure/redis`, no capability ID; S50 asks for the same) → needs per-call timeout, `unlink`, `eval`/`evalsha`, `publish`, a separate subscriber connection and no offline queue; whoever owns that lib provides it before S52 is implemented → the 250 ms bound cannot be built on retry settings alone.
- [CONTRACT] S54 → `Clock`, config validation of toolkit settings, metrics registry, `ShutdownRegistry`, problem+json mapping of `CacheLoaderBusy` and `LockTimeout` (503 + `Retry-After`) → the toolkit uses `FakeClock` for every expiry.
- [CONTRACT] S53 consumers (S05, S18, S25, S28, S39, S42–S44) call `invalidate` or `invalidateIfOlder` from their own consumer groups; S52 publishes no event and owns no consumer → keeps infrastructure free of domain names (X.3).

## LOCAL

- [LOCAL] L1 bounded by entries (10,000) and bytes (64 MiB) → both → entry count alone does not bound memory.
- [LOCAL] Breaker 5 failures / 10 s / open 5 s / one probe → as stated → conventional; configurable.
- [LOCAL] Loader bulkhead 100, wait 2 s → as stated → protects the source while the store is down.
- [LOCAL] Delayed double delete → not offered → the versioned minimum is durable; a timer is lost on crash.
- [LOCAL] Hot-key replication (`key:{0..N}`) → not offered; L1 promotion only → bucket splitting of one logical stock is S11's.
- [LOCAL] Stale-if-error → stored by extending the entry's retention to `exp + max(swr, staleIfError)` → one record, no shadow copy.
- [LOCAL] Auxiliary records (lock, minimum) share the entry's hash tag → yes → cluster-safe, one shard per key.
- [LOCAL] Fence counter retention → 30 days after the last acquisition → a counter that vanishes would let a fence go backwards.
- [LOCAL] Logs → namespace plus 8-hex key digest, never the value → VIII.1.
- [LOCAL] Metric labels → namespace only → bounded cardinality.
- [LOCAL] Minimum-version retention → 300 s default, 1–3,600 s → at least the longest stale window of S05 (5 min SWR).
- [LOCAL] Counter claim age → 5 min → longer than the 10 s flush plus a slow database write.
- [LOCAL] XFetch `beta` → 1 → the paper's default.
- [LOCAL] `ETag` weak form for derived validators, strong only when the caller supplies it → a re-serialised JSON body is not byte-identical.
- [LOCAL] Cache-Control builder lives with the interceptor → one place for P0410 headers.
- [LOCAL] Test layout → e2e files by feature under `libs/infrastructure/cache/` with a test-only fixture module → library has no HTTP surface of its own.
