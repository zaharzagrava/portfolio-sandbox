# Feature Specification: S52 — Cache Toolkit: L1/L2, Single-Flight, XFetch, SWR, Negative Cache, Write-Behind Counters, ETags (domain `infrastructure`)

**Feature Branch**: `S52-cache-toolkit` (spec directory `specs/domains/S52-cache-toolkit`)

**Created**: 2026-10-06

**Status**: Draft

**Input**: Capability S52 of `scripts/sdd/capabilities.tsv`. Sources: `docs/showcase/sections/SD-34-distributed-cache.md`, `interview-prep/03-databases/04-redis-and-caching.md` (§3 cache-aside and delete-on-write, §4 failure modes, §6 locks and fencing, §8 operational notes, §9 invalidation strategies, Q&A). Pattern-map rows covered: **P0105** (bounded memory, with S51), **P0324** (cache-aside, write-behind, SWR, stampede, avalanche, penetration, hot and big keys), **P0326** (distributed locks with fencing tokens, with S22), **P0410** (HTTP caching: ETag, `If-None-Match`, `Cache-Control`, SWR, with S27), **P1103** (Bloom filter against penetration, with S41).

## Scope

The **cache toolkit** is the one shared library through which every domain keeps copies of data that is read far more often than it changes. It is a tool, not a store of truth: the database always wins, every copy can be rebuilt, and the toolkit never owns business data.

In scope:

- **Cache-aside read path** with two levels: a small in-process memory (L1) and a shared cache store (L2), falling back to a caller-supplied loader. A batch variant loads many keys with one loader call.
- **Stampede protection**: coalescing of concurrent misses in one process (single-flight), a cross-process lock so only one process recomputes, probabilistic early refresh (XFetch), and stale-while-revalidate (SWR) with stale-if-error.
- **Avalanche protection**: jittered lifetimes. **Penetration protection**: negative entries and a Bloom filter primitive. **Hot and big keys**: sampled hot-key promotion to L1, a size cap per entry, non-blocking deletes.
- **Invalidation**: delete-on-write (writers never store a value), broadcast so every process drops its L1 copy, and **versioned invalidation** (a per-key minimum version) so duplicate, out-of-order and racing events cannot resurrect old data.
- **Degradation**: bounded waits on the store, a circuit breaker, a loader bulkhead, correct answers when the store is down.
- **Write-behind counters**: hot, low-value increments staged in the store and drained in batches by the owning domain's job, with crash-safe claim and commit.
- **Distributed lock with fencing tokens** for efficiency locks and for correctness locks (the protected resource checks the token).
- **HTTP caching helpers**: weak-or-strong `ETag` derivation, correct `If-None-Match` evaluation (lists, weak, `*`), `304` responses that keep the validators, and a `Cache-Control` builder with SWR and stale-if-error.
- **Observability and bounds**: metrics, logs without values, bounded memory in every in-process structure, graceful shutdown.

Out of scope (owned elsewhere; named so nothing is built twice):

- What a domain caches, its keys' meaning, its lifetimes and its invalidation triggers (S05 product pages, S18 entitlements, S03 authorization, S22 event pages, S27 stories, …). Each states how it uses this toolkit and owns the product-level proof.
- The shared store client and its health → `infrastructure/redis` (no capability ID); health probes, the problem+json filter, the clock, config validation, metrics registry, shutdown ordering → **S54**. Rate-limit buckets → **S50**. Realtime fan-out and per-connection buffers → **S51** (S52 only supplies the bounded-memory proof for its own structures). Job scheduling for flush jobs → **S49**. Outbox, events and consumers that call `invalidate` → **S53**.
- CDN purge by tag (`CloudflarePurger`, S27). Consistent hashing for room routing (S51/S24). Session and rate-limit stores (they use the shared client directly and keep their own policies). Hot-key *splitting* of one logical counter or stock into buckets (S11 owns it; S52 offers L1 promotion, not data splitting).
- No domain table is read or written by this capability. It owns no tables (constitution IX.3: none of the technical-table allowlist applies). Cross-domain data appears only as the IX.7 R1 exported services listed under Provides.

## User Scenarios & Testing *(mandatory)*

Actors: **a domain developer** (calls the toolkit from a service, a consumer or a job), **a reader** (an end user whose request is served through the toolkit), **an HTTP client or CDN** (sends `If-None-Match`), **an operator** (watches metrics and handles a cache outage), **another instance** (a second process of the same deployment).

Notation: the **store** is the shared cache store (L2). **L1** is the in-process memory of one instance. `K` is a cache key. The clock and the random source are injected and frozen or scripted in tests. "The loader" is the caller's function that reads the source of truth. "Namespace" is the first segment of a key (`product` in `product:v1:<id>`). Numbers such as 250 ms or 256 KiB are the defaults of this spec (see Assumptions); every one is configurable and validated.

### User Story 1 — A read is served from the cheapest level that is still correct (Priority: P1)

A domain developer wraps a read in one call. The first reader pays for the loader, later readers are served from the store, and readers of hot keys are served from memory.

**Why this priority**: Everything else in the toolkit rests on this path.

**Independent Test**: Call `getOrLoad` on a cold key twice and on a hot key repeatedly; count loader calls, store calls and outcome metrics.

**Acceptance Scenarios**:

1. **AS-01** (cold, then warm) — **Given** an empty store and key `product:v1:A`, **When** `getOrLoad` is called twice in sequence with `{ttlMs: 60000}` and a loader returning `{n: 1}`, **Then** the loader ran once, both calls return `{n: 1}`, the store holds one entry for the key whose remaining lifetime is within `[54000, 66000]` ms, and the outcome counter recorded `miss` then `l2` for namespace `product`.
2. **AS-02** (L1 always) — **Given** `l1: 'always'` and `l1TtlMs: 1000`, **When** the key is read twice within 1 s, **Then** the second read makes zero store calls (outcome `l1`); **When** the clock advances 1,001 ms and it is read again, **Then** it is served from the store (outcome `l2`) and L1 is refilled.
3. **AS-03** (L1 never) — **Given** `l1: 'never'`, **When** the key is read 1,000 times, **Then** the instance's L1 holds zero entries for it at every point (no per-process copy exists), each read after the first is outcome `l2`.
4. **AS-04** (hot-key promotion) — **Given** `l1: 'hot'` (the default) and a sampler scripted to count every access, **When** key `H` is read 25 times in one 10 s window and key `C` once, **Then** in the next window `H` is served from L1 (outcome `l1`, zero store calls) and `C` is not in L1; **When** a further window passes in which `H` is not read, **Then** `H` stops being promoted.
5. **AS-05** (L1 is bounded) — **Given** the default L1 bound of 10,000 entries and 64 MiB of serialized size, **When** 20,000 distinct keys are read with `l1: 'always'`, **Then** L1 never holds more than 10,000 entries or 64 MiB, the least recently used are the ones dropped, and reads of dropped keys still succeed from the store.
6. **AS-06** (value contract) — **Given** a loader that resolves `undefined`, **When** `getOrLoad` runs, **Then** it rejects with `InvalidLoaderResult` (a `null` means "not found", `undefined` is a bug), nothing is stored and the loader error is not cached; **Given** a loader returning a value that cannot be written as JSON (a cycle, a `BigInt`), **Then** it rejects with `InvalidLoaderResult` and nothing is stored.
7. **AS-07** (corrupt entry heals) — **Given** the store holds unparseable bytes at `K`, **When** `K` is read, **Then** the read answers from the loader (outcome `corrupt`), the entry is overwritten with a valid one, no error reaches the caller, and the next read is `l2`.
8. **AS-08** (big entries are refused, not broken) — **Given** the default cap of 256 KiB and a loader returning a 300 KiB value, **When** it is read twice, **Then** both calls return the value, the store holds nothing for `K`, L1 holds nothing for `K`, outcome `oversize` is counted twice, a warning without the value is logged once per 60 s per namespace, and the loader ran twice (single-flight still applies to concurrent calls). A per-call `maxEntryBytes` lowers or raises the cap up to 1 MiB.
9. **AS-09** (keys are validated and tenant-safe) — **Given** the key builder `cacheKey('product', 1, 'a:b', 'c')`, **Then** it yields `product:v1:a%3Ab:c` and differs from `cacheKey('product', 1, 'a', 'b:c')`; parts containing `{`, `}`, whitespace, control characters or `%` are percent-encoded so a caller-supplied part can never change the key's shard-affecting braces or split into extra segments; an empty part, a non-positive version or an invalid namespace throws `InvalidCacheKey`. **Given** any raw key that is empty, longer than 512 bytes, contains whitespace or control characters, or has no `:` namespace separator, **When** passed to `getOrLoad`, `getOrLoadMany` or `invalidate`, **Then** `InvalidCacheKey` is thrown before any store call and nothing is deleted (for `invalidate`, no key of the call is touched). **Given** two tenants' IDs in the key, **Then** the keys differ and each tenant's read never returns the other's value.
10. **AS-10** (options are validated) — **Given** each of `ttlMs ≤ 0`, `swrMs < 0`, `negativeTtlMs` above `ttlMs`, `jitter` outside `[0, 0.5]`, `l1TtlMs` above 5,000, `timeoutMs` outside `[10, 5000]`, `maxEntryBytes` above 1 MiB, **When** passed, **Then** `InvalidCacheOptions` names the offending field and no store call is made. The same rules reject an invalid toolkit configuration at startup (VIII.5).
11. **AS-11** (batch read) — **Given** 100 distinct keys of which 40 are cached and 60 are not, **When** `getOrLoadMany(keys, batchLoader, options)` is called, **Then** the store is read once for all keys, `batchLoader` is called once with exactly the 60 missing keys in input order, results come back in input order, a key the batch loader omits or maps to `null` is `null` in the result and (with `negativeTtlMs`) negatively cached, and 60 entries are written in one round trip. **Given** a repeated key in the input, **Then** it appears twice in the result and is loaded once. **Given** more than 500 keys, **Then** `InvalidCacheOptions` is thrown. **Given** a concurrent `getOrLoad` for one of the missing keys, **Then** the two share one load (no key is loaded twice at once).

---

### User Story 2 — A popular key expiring does not hurt the database (Priority: P1)

When a hot key expires, thousands of readers must not all hit the source. One of them recomputes, the rest wait or are served the previous value, and expiry itself is smoothed.

**Why this priority**: This is the failure the notes call stampede, and the reason the toolkit exists.

**Independent Test**: Fire 200 concurrent reads at a cold key on one instance and on three instances; count loader calls.

**Acceptance Scenarios**:

1. **AS-12** (single-flight, one instance) — **Given** a cold key and a loader that takes 100 ms, **When** 200 concurrent `getOrLoad` calls are made, **Then** the loader ran once and all 200 resolve with the same value.
2. **AS-13** (cross-instance lock) — **Given** three instances (three toolkit objects over one store) and a cold key, **When** each receives 100 concurrent reads at the same time, **Then** the loader ran once in total, all 300 resolve with the value, and the followers read the leader's stored value instead of loading.
3. **AS-14** (lock is owned) — **Given** instance A took the recompute lock and its loader outlives the lock lifetime (5 s), and instance B then took a new lock for the same key, **When** A finishes, **Then** A's release does not delete B's lock (token-checked, atomic) and B's lock is still present; **Given** the lock holder died and its lock expired, **Then** a waiting follower stops waiting after 500 ms and loads the value itself, so a read never waits longer than the wait budget plus one load.
4. **AS-15** (loader failure) — **Given** 50 concurrent reads on a cold key and a loader that rejects, **Then** all 50 reject with that same error, nothing is stored (no error caching), the recompute lock is released at once, the instance's in-flight table is empty afterwards, and the next read calls the loader again.
5. **AS-16** (stale-while-revalidate) — **Given** an entry written with `{ttlMs: 200, swrMs: 60000}` and the clock at `exp − 1 ms`, **When** read, **Then** it is fresh (outcome `l2`); **Given** the clock at `exp`, **When** read, **Then** the stale value is returned at once (outcome `stale`) and exactly one background refresh runs even if three instances and 100 reads each arrive (one loader call in total), after which readers get the new value; **Given** the background refresh fails, **Then** readers keep getting the stale value until `exp + swrMs`, the failure is counted (`refresh_failed`) and logged, and no error reaches a reader.
6. **AS-17** (SWR window ends) — **Given** the same entry with the clock at `exp + swrMs`, **When** read, **Then** the entry is gone, the read is a miss and loads synchronously.
7. **AS-18** (stale-if-error) — **Given** `staleIfErrorMs: 300000`, an entry past `exp + swrMs` but within `exp + staleIfErrorMs`, and a loader that rejects, **When** read, **Then** the stale value is returned (outcome `stale_error`) and the error is counted; **Given** the entry is also past `staleIfErrorMs`, **Then** the loader's error is raised to the caller.
8. **AS-19** (XFetch) — **Given** an entry with load time `delta = 100` ms, `beta = 1`, expiring at `E`, **When** the decision is evaluated at `now = E − 50` with the random draw `r`, **Then** early refresh is chosen exactly when `now − delta·beta·ln(r) ≥ E`, i.e. for `r ≤ e^−0.5 ≈ 0.6065` and not for larger `r`; a draw of `0` never yields an infinite or `NaN` result; with `delta = 0` an early refresh is never chosen before `E`. **Given** an early refresh is chosen on a fresh entry, **Then** the reader still receives the cached value immediately, one refresh runs per key across all instances, and the entry's lifetime is extended by it.
9. **AS-20** (jitter) — **Given** 1,000 keys stored with `ttlMs: 60000` and the default jitter 0.1, **Then** every lifetime lies in `[54000, 66000]` ms and they are not all equal; **Given** `jitter: 0`, **Then** the lifetime is exactly `ttlMs`; **Given** `ttlMs: 1000, jitter: 0.1` (a 1 s view), **Then** lifetimes lie in `[900, 1100]`.
10. **AS-21** (the loader is timed) — **Given** a loader that takes 120 ms, **Then** the entry records a load time of 120 ms (from the injected clock) for XFetch, and a loader duration histogram bucket for namespace `product` is incremented.

---

### User Story 3 — Lookups for things that do not exist do not reach the database (Priority: P1)

Random or malicious IDs always miss. The toolkit remembers "not found" briefly and offers a Bloom filter for membership checks on hot paths.

**Why this priority**: Cache penetration is the cheapest attack on a cached read path.

**Independent Test**: Read an unknown key five times; build a filter and probe members and non-members.

**Acceptance Scenarios**:

1. **AS-22** (negative entries) — **Given** a loader returning `null` and `negativeTtlMs: 10000`, **When** the key is read five times, **Then** the loader ran once, all five return `null`, the repeated reads are outcome `negative`, and the stored lifetime is within `[9000, 11000]` ms; **When** the clock advances 12 s, **Then** the next read calls the loader again.
2. **AS-23** (negative entries are never served stale) — **Given** `swrMs: 60000` and a negative entry that has passed its soft expiry, **When** read, **Then** it is treated as a miss and the loader is called (negative entries ignore SWR and stale-if-error), so an item created in the meantime is found.
3. **AS-24** (negative caching is opt-in) — **Given** no `negativeTtlMs`, **When** a loader returns `null` twice, **Then** nothing is stored and the loader ran twice.
4. **AS-25** (a created item replaces a negative entry) — **Given** a negative entry for `K`, **When** the owner calls `invalidate([K])` after creating the item, **Then** the next read loads the item.
5. **AS-26** (Bloom filter never lies in one direction) — **Given** a filter built for 10,000 items at 1 % and the items added, **Then** `mightContain` is `true` for every added item (zero false negatives, property-based over random strings), and for 10,000 never-added items the false-positive rate is at most 2 %.
6. **AS-27** (Bloom sizing) — **Given** `(n, p)` = `(1000, 0.01)`, **Then** the filter has 9,586 bits and 7 hash functions; `(100_000_000, 0.01)` gives about 958.5 million bits (≈ 114 MiB); `n < 1`, `p ≤ 0`, `p ≥ 1`, or a size above 2³² bits throws `InvalidCacheOptions` before any store call.
7. **AS-28** (Bloom filter and the store being down) — **Given** the store is unreachable, **When** `mightContain` runs, **Then** it answers `true` (it cannot prove absence, so it never blocks a real item) and counts a degraded outcome; **When** `add` runs, **Then** it rejects with `CacheUnavailable`. Adding the same item twice changes nothing.

---

### User Story 4 — A write is visible at once and never overwritten by a slow reader (Priority: P1)

Writers delete, they never store. Every instance drops its memory copy. A late or duplicate invalidation event cannot bring old data back.

**Why this priority**: Wrong data served for a full lifetime is worse than a slow read; the notes call out the reader–writer race explicitly.

**Independent Test**: Cache a value on two instances, invalidate from one, read on the other; replay events of the versioned path in every order.

**Acceptance Scenarios**:

1. **AS-29** (delete and broadcast) — **Given** instance B holds `K` in L1 (`l1: 'always'`) and in the store, **When** instance A calls `invalidate([K])`, **Then** it resolves `{l2: 'ok', deleted: 1}`, the store entry is gone (deleted with the non-blocking command), and within 1 s B's next read loads the new value.
2. **AS-30** (invalidate never throws on store failure) — **Given** the store is unreachable, **When** `invalidate([K])` is called, **Then** it resolves `{l2: 'failed', deleted: 0}` within the per-call timeout, the local L1 copy is evicted anyway, the failure is counted (`cache_invalidations_total{result="failed"}`) and logged with the namespace, and no exception reaches the caller (a failed delete never fails a business write).
3. **AS-31** (missed broadcast is survivable) — **Given** instance B's broadcast subscription is closed, **When** A invalidates `K`, **Then** B bypasses L1 while disconnected (a read goes to the store and returns the new value) and, once the subscription is restored, B clears its entire L1 before using it again. A key never served from L1 for longer than `l1TtlMs` plus the time to detect the disconnect.
4. **AS-32** (batches) — **Given** 5,000 keys with duplicates, **When** `invalidate` is called, **Then** duplicates are removed, deletion and broadcast use at most 10 store round trips, and an empty array is a no-op that makes no store call.
5. **AS-33** (versioned invalidation applies) — **Given** `K` cached with value version 3 (`versionOf: v => v.version`), **When** `invalidateIfOlder(K, 4)` is called, **Then** the result is `{outcome: 'applied'}`, the entry is gone, the minimum accepted version of `K` is 4, and instances drop their L1 copy.
6. **AS-34** (duplicate delivery) — **Given** AS-33 and then a fresh entry at version 4 stored by a reader, **When** `invalidateIfOlder(K, 4)` is called again, **Then** the result is `{outcome: 'skipped'}`, the version-4 entry is kept and no extra miss happens.
7. **AS-35** (out-of-order delivery) — **Given** the entry holds version 5 (or the recorded minimum is 5), **When** `invalidateIfOlder(K, 4)` arrives late, **Then** the result is `skipped`, the entry and the minimum are unchanged (a minimum is never lowered).
8. **AS-36** (slow reader cannot resurrect) — **Given** a reader that loaded version 3 before version 4 committed, **When** `invalidateIfOlder(K, 4)` is applied and the slow reader then finishes, **Then** its caller still receives the version-3 value, nothing is stored (outcome `refused_below_minimum`), and the next read loads version 4; a stored value of version 4, 5 or higher is accepted.
9. **AS-37** (no entry yet) — **Given** no entry and no minimum for `K` while a load of version 7 is in flight, **When** `invalidateIfOlder(K, 8)` is applied, **Then** the minimum becomes 8 and the in-flight load's result is not stored; a later load of version 8 is stored.
10. **AS-38** (negative and unversioned entries) — **Given** a negative entry (no version) for `K`, **When** `invalidateIfOlder(K, 1)` is applied, **Then** the entry is deleted (an unversioned entry is older than any version) and the minimum is 1; **Given** a minimum exists and a loader returns a value for which `versionOf` yields nothing, **Then** the value is not stored (outcome `refused_unversioned`).
11. **AS-39** (the minimum is bounded in time) — **Given** a minimum recorded with the default retention of 300 s, **When** the clock advances 301 s, **Then** the minimum is gone and any version is accepted again; a call may set a retention between 1 s and 3,600 s, anything else throws `InvalidCacheOptions`.
12. **AS-40** (writers cannot store) — **Given** the public surface of the toolkit, **Then** no method stores a caller-supplied value into the cache except through a loader inside `getOrLoad` / `getOrLoadMany` (type-level assertion), so delete-on-write is the only write path.
13. **AS-41** (invalid version) — **Given** `invalidateIfOlder(K, v)` with `v` negative, fractional, `NaN` or above 2⁵³−1, **Then** `InvalidCacheOptions` is thrown and nothing changes.

---

### User Story 5 — A cache outage makes reads slower, never wrong or failing (Priority: P1)

The notes say a cache fails open, with care so the database does not fall over.

**Why this priority**: An outage of an optimisation must not become an outage of the product.

**Independent Test**: Put a fault proxy in front of the store (refuse, then hang) and read.

**Acceptance Scenarios**:

1. **AS-42** (store down: answer from the loader) — **Given** the store refuses connections, **When** 100 concurrent reads of one key arrive, **Then** all resolve with the loader's value, the loader ran once (single-flight still holds), nothing is stored, the outcome `degraded` is counted, a single warning per 10 s per namespace is logged, and no call waits longer than the per-call timeout for the store.
2. **AS-43** (store hangs) — **Given** the store accepts connections but never answers, **When** a key is read, **Then** the store attempt is abandoned after 250 ms (default `timeoutMs`) and the answer comes from the loader; a per-call `timeoutMs` of 50 ms is honoured.
3. **AS-44** (circuit breaker) — **Given** 5 consecutive store failures within 10 s, **When** further reads arrive, **Then** for the next 5 s the store is not contacted at all (read latency is the loader's alone), after which one probe call is allowed; a successful probe closes the breaker, a failed one re-opens it for another 5 s; the state is exposed as a gauge and every transition is logged once.
4. **AS-45** (loader bulkhead) — **Given** the store is down and a per-instance loader concurrency cap of 100, **When** 500 reads of distinct keys arrive at once, **Then** at most 100 loaders run at any moment, the others wait in arrival order for up to 2 s, and those that do not get a slot in time reject with `CacheLoaderBusy` (the caller maps it to `503`); with a healthy store the cap applies only to miss loads.
5. **AS-46** (recovery) — **Given** AS-42 and the store returns, **When** the key is read, **Then** the entry is stored and the next read is `l2`.
6. **AS-47** (recompute lock fails open, correctness lock fails closed) — **Given** the store is down, **Then** a read proceeds without the recompute lock (efficiency lock, fail open), whereas `DistributedLock.tryAcquire` rejects with `LockUnavailable` and never reports success (US7).
7. **AS-48** (an L1 copy never outlives a broken broadcast) — see AS-31; and **Given** the store is down, **Then** reads of `l1: 'always'` keys within their `l1TtlMs` are still served from L1 (outcome `l1`), and a read after `l1TtlMs` goes to the loader.

---

### User Story 6 — Hot, low-value counts cost almost nothing to record (Priority: P2)

Views and votes are counted in the store and flushed in bulk by the owning domain's job. A crashed flusher loses nothing.

**Why this priority**: Without it a popular product turns every view into a row lock.

**Independent Test**: Increment concurrently from two instances while a drain loop runs; sum everything.

**Acceptance Scenarios**:

1. **AS-49** (exact totals) — **Given** two instances each making 5,000 concurrent `increment('a')` and 5,000 `increment('b', 2)` calls on counter `views`, **When** `drain()` runs, **Then** it returns `{a: 10000, b: 20000}` and a second `drain()` returns an empty map; no database is touched by the toolkit.
2. **AS-50** (drain is atomic) — **Given** 20,000 increments racing with a drain loop that runs every 5 ms, **Then** the sum of all drained batches plus the final remainder equals 20,000, with no increment lost or counted twice.
3. **AS-51** (failed flush restores) — **Given** a drained batch `{a: 50, b: 50}` and 10 new increments of `a` since, **When** `restore(batch)` is called, **Then** the next drain returns `{a: 60, b: 50}`.
4. **AS-52** (crash-safe claim) — **Given** `claim()` returned `{batchId, deltas}` and the flusher process died, **When** `commit(batchId)` is never called and `reclaimExpired()` runs after the claim age (default 5 min, frozen clock), **Then** the batch is merged back into the pending counts and nothing is lost; **When** `commit(batchId)` is called, **Then** the batch is gone for good; a second `commit(batchId)` and a commit of an unknown ID are no-ops (`{committed: false}`); `release(batchId)` merges back at once. A flusher that applies a batch to a table is expected to make that apply idempotent by `batchId` (documented, tested by the domain).
5. **AS-53** (input rules) — **Given** `increment(member, by)` with `by` that is `0`, fractional, `NaN`, beyond the safe integer range, or a member that is empty or longer than 256 bytes, **Then** `InvalidIncrement` is thrown and nothing changes; a negative integer is accepted (vote deltas); a counter name must match `^[a-z][a-z0-9-]*$` (≤ 64 chars) or construction throws `InvalidCacheOptions`.
6. **AS-54** (bounded pending set) — **Given** the default cap of 100,000 pending members per counter, **When** a new member is incremented beyond the cap, **Then** `CounterOverflow` is thrown and counted, existing members still increment, and after a drain new members are accepted again; the number of pending members is a gauge.
7. **AS-55** (counters are separate) — **Given** counters `product-views` and `vote-deltas`, **Then** the same member in both never mixes, and draining one leaves the other untouched.
8. **AS-56** (store down) — **Given** the store is unreachable, **Then** `increment`, `drain`, `claim` reject with `CacheUnavailable` (the caller decides to drop an analytics-grade count or to fail) and nothing is lost that was already staged.

---

### User Story 7 — Only one holder works on a resource, and the resource can tell a stale holder (Priority: P2)

Locks for efficiency are cheap. Locks for correctness carry a fencing token the protected write checks.

**Why this priority**: The notes' lock section ends with "for correctness, use fencing tokens"; S22 and S49 need a shared, correct primitive.

**Independent Test**: Twenty concurrent acquisitions; expire a lock under a holder and acquire it again.

**Acceptance Scenarios**:

1. **AS-57** (mutual exclusion) — **Given** 20 concurrent `tryAcquire('seat-hold:E1')` calls with `ttlMs: 5000`, **Then** exactly one returns a lock `{resource, token, fence}`, the other 19 return `null`.
2. **AS-58** (release is owned and atomic) — **Given** holder A whose lock expired and holder B who then acquired, **When** A calls `release`, **Then** it returns `false` and B still holds the lock; **When** B releases, it returns `true` and the resource is free.
3. **AS-59** (fencing tokens increase) — **Given** the same resource acquired, expired and re-acquired by three different instances in turn, **Then** the `fence` values are strictly increasing positive integers, never reused even after a release; `isNewerFence(current, presented)` is `true` only when `presented > current`, so a protected write guarded by `fence < $presented` accepts the newest holder and rejects the stale one.
4. **AS-60** (extend and loss) — **Given** a held lock, **When** `extend(ttlMs)` is called by the holder before expiry, **Then** it returns `true` and the lifetime restarts; **When** called after the lock was lost to another holder, **Then** it returns `false` and does not touch the new holder's lock. `withLock(resource, {ttlMs}, fn)` always releases, including when `fn` throws, and passes the lock so `fn` can extend.
5. **AS-61** (waiting) — **Given** the lock is held for 300 ms, **When** `acquire(resource, {ttlMs, waitMs: 1000})` is called, **Then** it returns the lock shortly after the release (polling with jitter, never a tight loop); **Given** `waitMs: 100` and a holder for 1 s, **Then** it rejects with `LockTimeout` after 100 ms ± 50 ms.
6. **AS-62** (fail closed) — **Given** the store is down, **When** `tryAcquire` or `acquire` is called, **Then** it rejects with `LockUnavailable`; it never returns a lock it cannot prove.
7. **AS-63** (input rules) — **Given** `ttlMs` below 100 or above 600,000, or a resource that is empty, longer than 256 bytes or contains whitespace, **Then** `InvalidCacheOptions` is thrown.

---

### User Story 8 — Clients and CDNs revalidate instead of re-downloading (Priority: P2)

A response carries a validator; a repeat request with the validator gets `304`.

**Why this priority**: P0410; the cheapest bytes are the ones not sent.

**Independent Test**: `GET` a resource, repeat with `If-None-Match`, change the resource, repeat again.

**Acceptance Scenarios**:

1. **AS-64** (derive and revalidate) — **Given** a handler returning `{id: 'p1', version: 3, …}` behind `VersionEtagInterceptor`, **When** `GET` is called, **Then** `200` with `ETag: W/"p1-v3"`; **When** repeated with `If-None-Match: W/"p1-v3"`, **Then** `304`, empty body, the same `ETag`, and every header the handler set (`Cache-Control`, `Cache-Tag`, `Vary`, `Content-Language`, `Content-Location`) is repeated; **When** the resource is updated to version 4 and the old validator is sent, **Then** `200` with `ETag: W/"p1-v4"`.
2. **AS-65** (all header forms) — **Given** the current validator `"x-v2"` (strong), **When** `If-None-Match` is `"x-v2"`, `W/"x-v2"`, `"a", "x-v2"`, `"a" , W/"x-v2"`, or `*`, **Then** the answer is `304` (weak comparison); with `"x-v3"`, `""`, a lone `W/`, an unquoted token or garbage, **Then** `200` (a malformed header is never an error and never a match); with `*` and no resource (the handler answered `404`), **Then** `404`.
3. **AS-66** (safe methods only) — **Given** the same validator, **When** `HEAD` is sent with and without `If-None-Match`, **Then** it returns the same headers as `GET` and no body (`304` when matching); **When** `POST`, `PUT`, `PATCH`, `DELETE` carry `If-None-Match`, **Then** the interceptor never answers `304`, never rewrites the status and adds no `ETag` to the write's response.
4. **AS-67** (no validator on errors; no leak across tenants) — **Given** tenant B requests tenant A's resource with A's validator, **When** the handler (after its guard) answers `404`/`403`, **Then** the response has no `ETag` and is never `304`; `401` likewise; a `5xx` likewise. A `304` is only possible after the handler authorized and loaded the resource for this caller.
5. **AS-68** (caller-supplied strong validator) — **Given** a handler returning `withEtag(body, '"story-1-v2-en"')`, **When** `GET` is called, **Then** the header is exactly `ETag: "story-1-v2-en"` (strong, as given) and conditional requests are evaluated against it with the rules of AS-65; a validator that is not a quoted entity tag, longer than 256 bytes, or containing control characters is not emitted, the response is `200` without `ETag`, and `etag_invalid` is counted and logged.
6. **AS-69** (no validator, no change) — **Given** a body without a non-negative safe-integer `version`, or without a string `id` (and no `withEtag`), or a non-JSON or streamed body, **Then** it passes through untouched (no `ETag`, no `304`, no fallback id).
7. **AS-70** (cache policy header) — **Given** `buildCacheControl({visibility: 'public', maxAgeSec: 60, sMaxAgeSec: 300, staleWhileRevalidateSec: 86400, staleIfErrorSec: 3600})`, **Then** it returns `public, max-age=60, s-maxage=300, stale-while-revalidate=86400, stale-if-error=3600`; `{visibility: 'private'}` with `noStore` returns `private, no-store`; a negative or fractional duration, `s-maxage` with `private`, or `noStore` with any duration throws `InvalidCacheOptions`. A handler's own `Cache-Control` is never overwritten by the interceptor.

---

### User Story 9 — An operator can see it and trust it to stay small (Priority: P2)

**Why this priority**: Constitution VIII and the notes' monitoring list (hit ratio, evictions, memory).

**Acceptance Scenarios**:

1. **AS-71** (metrics) — **Given** the read sequences above, **Then** the registry exposes `cache_requests_total{namespace, outcome}` with outcomes `l1`, `l2`, `stale`, `stale_error`, `negative`, `miss`, `degraded`, `corrupt`, `oversize`, `refused_below_minimum`, `refused_unversioned`; `cache_loader_calls_total{namespace}` and `cache_loader_duration_seconds{namespace}`; `cache_invalidations_total{result}` (`ok`, `failed`; and `applied`, `skipped` for the versioned path); `cache_breaker_state` (0 closed, 1 open, 2 half-open); `cache_l1_entries`; `cache_counter_pending_members{counter}`; `cache_lock_acquisitions_total{outcome}`. No label ever carries a full key, a tenant ID or a value (label cardinality is bounded by namespaces).
2. **AS-72** (logs carry no values) — **Given** a degraded read of a key containing an ID and a value containing a marker string, **Then** the captured log line carries `requestId`, the namespace and a key digest (first 8 hex characters of a hash of the key), and neither the full key nor any part of the value.
3. **AS-73** (shutdown) — **Given** a toolkit with two background refreshes running, **When** the application shuts down, **Then** the broadcast subscription closes, the in-flight refreshes are awaited for up to 5 s, then abandoned without error, no timer or connection is left open (the test process exits without an open-handle warning), and reads made during shutdown are answered from the loader.
4. **AS-74** (time is injected) — **Given** the clock is frozen, **Then** no expiry decision depends on the real time: all of AS-02, AS-16, AS-17, AS-22 and AS-39 are reproduced by moving the clock only; the stored absolute expiry is the only time the store's own expiry may be later than (the store's lifetime is the authority for the hard limit).

---

### Edge Cases

- Concurrency: stampede on one instance (AS-12), across instances (AS-13), lock holder slower than its lock (AS-14), loader failure shared and not cached (AS-15), slow reader against an invalidation (AS-36), counter increments racing a drain (AS-50).
- Idempotent replay and duplicates: duplicate versioned invalidation (AS-34), out-of-order (AS-35), double commit of a counter batch (AS-52), adding a Bloom item twice (AS-28), `release` twice (AS-58).
- Illegal states: unknown commit ID (AS-52), release or extend after loss (AS-58, AS-60), `undefined` loader result (AS-06), invalid versions and options (AS-10, AS-41, AS-53, AS-63).
- Cross-tenant: tenant-safe key construction (AS-09), no validator or `304` for another tenant's resource (AS-67), no per-process copy with `l1: 'never'` (AS-03).
- Limits: entry size (AS-08), L1 entries and bytes (AS-05), batch size (AS-11), pending counter members (AS-54), keys per invalidation (AS-32), lock and wait bounds (AS-63), timeouts (AS-43).
- Timeouts and outages: store down (AS-42), store hangs (AS-43), breaker (AS-44), bulkhead (AS-45), lock fail-closed (AS-62), broadcast lost (AS-31).
- Data corruption: unparseable entry (AS-07).
- A cache entry for a value that changes every request (a counter, a clock) is the caller's mistake; the toolkit offers no guard (documented under Assumptions).
- Clock skew between instances: soft expiry uses the stored absolute time; the store's own lifetime is authoritative for the hard limit, so an entry is never served beyond `exp + swr` of the store's clock plus the skew (accepted, bounded by the host's time sync).
- Values that change shape (a new field): domains version their key namespace (`product:v2:`), the toolkit never migrates entries.

## Requirements *(mandatory)*

### Functional Requirements

**Read path (P0324, P0105)**

- **FR-001**: `getOrLoad(key, loader, options)` MUST read L1 (when enabled for the key), then L2, then the loader, and return the value or `null`; a `null` means "not found" and `undefined` MUST be rejected (AS-01, AS-06).
- **FR-002**: The L1 mode MUST be one of `always`, `hot` (default) or `never`; `never` MUST guarantee no per-process copy; `hot` promotes only keys the sampled detector marks hot; L1 lifetimes MUST NOT exceed `l1TtlMs` (default 1,000 ms, max 5,000 ms) (AS-02, AS-03, AS-04).
- **FR-003**: L1 MUST be bounded by entry count (default 10,000) and total serialized size (default 64 MiB); the hot-key detector MUST track at most 10,000 keys per window; every in-process table (in-flight, tracked keys, pending refreshes) MUST be empty or bounded when idle (AS-05, AS-15, AS-73).
- **FR-004**: L1 MUST be used only while the broadcast subscription is healthy; on reconnect L1 MUST be cleared before use (AS-31).
- **FR-005**: Values MUST be JSON-serializable; a non-serializable value MUST reject with `InvalidLoaderResult`; an unparseable stored entry MUST be treated as a miss and overwritten (AS-06, AS-07).
- **FR-006**: An entry larger than `maxEntryBytes` (default 256 KiB, max 1 MiB) MUST be returned to the caller but not stored in L1 or L2, and counted (`oversize`) (AS-08).
- **FR-007**: `cacheKey(namespace, version, ...parts)` MUST build `<namespace>:v<version>:<part>:…` with parts percent-encoded for `:`, `{`, `}`, `%`, whitespace and control characters; every key given to the toolkit MUST be validated (non-empty, ≤ 512 bytes, one namespace segment, no whitespace or control characters) before any store call (AS-09).
- **FR-008**: Every option MUST be validated and rejected with `InvalidCacheOptions` naming the field; the toolkit configuration MUST be validated at startup (AS-10).
- **FR-009**: `getOrLoadMany(keys, batchLoader, options)` MUST read the store once for all keys, call `batchLoader` once with the missing keys in input order, preserve input order and duplicates in the result, treat a key the loader omits as `null`, write all new entries in one round trip, accept at most 500 keys, and share in-flight loads with `getOrLoad` (AS-11).
- **FR-010**: The toolkit MUST expose no method that stores a caller-supplied value; writers delete (`invalidate`, `invalidateIfOlder`) (AS-40).

**Stampede, early refresh, SWR (P0324)**

- **FR-011**: Concurrent misses for one key within one process MUST share one loader call, including a rejection, and the in-flight entry MUST be removed when it settles (AS-12, AS-15).
- **FR-012**: Across processes, on a miss and on any refresh (including early and stale refreshes) exactly one process MUST hold a per-key recompute lock (lifetime 5 s), others MUST wait up to 500 ms for the stored value and then load themselves; the lock MUST be released only by its owner, atomically (AS-13, AS-14, AS-16).
- **FR-013**: Early refresh MUST follow XFetch: refresh early when `now − delta·beta·ln(r) ≥ expiry` (`beta` default 1, `r` a uniform draw clamped above 0); it MUST run in the background and the reader MUST receive the cached value (AS-19).
- **FR-014**: With `swrMs`, a value past its soft expiry and within the window MUST be returned immediately with one background refresh per key across all processes; a failing refresh MUST NOT reach the reader and MUST be counted; past the window the entry MUST be a miss (AS-16, AS-17).
- **FR-015**: With `staleIfErrorMs`, when the loader rejects and a stale value exists within `exp + staleIfErrorMs`, the stale value MUST be returned and the error counted; otherwise the error MUST propagate. Loader errors MUST never be cached (AS-15, AS-18).
- **FR-016**: Lifetimes MUST be jittered by a relative `jitter` (default 0.1, range 0–0.5, 0 disables); the stored envelope MUST hold the soft expiry, the hard expiry and the measured load time (AS-20, AS-21).

**Penetration (P0324, P1103)**

- **FR-017**: With `negativeTtlMs` (> 0, ≤ `ttlMs`), a `null` result MUST be stored for that jittered lifetime; negative entries MUST NOT be served stale and MUST ignore SWR and stale-if-error; without it nothing MUST be stored for `null` (AS-22, AS-23, AS-24, AS-25).
- **FR-018**: `RedisBloomFilter(n, p)` MUST size itself by `m = ⌈−n·ln p / (ln 2)²⌉`, `k = max(1, round(m/n·ln 2))`, MUST have zero false negatives, MUST reject `n < 1`, `p ∉ (0,1)` or `m > 2³²` bits, MUST answer `true` when the store is unreachable, and `add` MUST be idempotent (AS-26, AS-27, AS-28).

**Invalidation (P0324)**

- **FR-019**: `invalidate(keys)` MUST delete from L2 with the non-blocking delete, publish a broadcast so every instance drops its L1 copy, evict the local L1 copy even when L2 fails, deduplicate keys, use at most 10 round trips for 5,000 keys, and resolve `{l2, deleted}` without throwing on store failure (AS-29, AS-30, AS-32).
- **FR-020**: Every toolkit-managed auxiliary record (recompute lock, minimum version) MUST live next to its entry so one key never spans shards.
- **FR-021**: `getOrLoad` and `getOrLoadMany` MUST accept `versionOf(value) → integer` to stamp entries; `invalidateIfOlder(key, version, {minimumRetentionMs})` MUST atomically (a) delete the entry when its version is below `version` or it has none, (b) raise the key's minimum accepted version to `version` unless the entry's version is already at least `version`, (c) never lower a minimum, (d) broadcast an L1 drop, and return `applied` or `skipped` (AS-33, AS-34, AS-35, AS-37, AS-38).
- **FR-022**: A store of a loaded value MUST be refused atomically when its version is below the key's minimum, or when it has no version while a minimum exists; the loaded value MUST still be returned to its caller; minimums MUST expire after `minimumRetentionMs` (default 300 s, 1–3,600 s) (AS-36, AS-38, AS-39).
- **FR-023**: Version arguments MUST be non-negative safe integers or `InvalidCacheOptions` is thrown (AS-41).

**Degradation (P0324, §8)**

- **FR-024**: Every store call on the read and invalidate paths MUST be bounded by `timeoutMs` (default 250 ms); on timeout or error the read MUST degrade to the single-flighted loader, store nothing, and count `degraded` (AS-42, AS-43).
- **FR-025**: A circuit breaker (5 consecutive failures within 10 s → open 5 s → one half-open probe) MUST skip the store while open (AS-44).
- **FR-026**: A per-instance cap on concurrently running loaders (default 100) MUST queue callers in arrival order for up to 2 s and then reject with `CacheLoaderBusy` (AS-45).
- **FR-027**: The recompute lock MUST fail open; `DistributedLock` MUST fail closed (AS-47, AS-62).

**Write-behind counters (P0324)**

- **FR-028**: `WriteBehindCounter.increment(member, by = 1)` MUST add atomically and be O(1); `by` MUST be a non-zero safe integer; `member` 1–256 bytes (AS-49, AS-53).
- **FR-029**: `drain()` MUST take and clear every pending count atomically and return a `Map<member, delta>`; `restore(deltas)` MUST add them back; both MUST remain as they are (AS-50, AS-51).
- **FR-030**: `claim()` MUST atomically move every pending count into an in-flight batch with a `batchId` and return `{batchId, deltas}`; `commit(batchId)` MUST delete it (idempotent); `release(batchId)` MUST merge it back; `reclaimExpired()` MUST merge back batches older than the claim age (default 5 min) (AS-52).
- **FR-031**: A counter MUST hold at most 100,000 pending members and reject new members beyond with `CounterOverflow` (AS-54). Counters MUST be isolated by name (AS-55). Store failure MUST reject with `CacheUnavailable` (AS-56).
- **FR-032**: Counters MUST NOT be used for money or any count whose loss is not acceptable (documented; callers that need durability use the outbox or the database).

**Locks and fencing (P0326)**

- **FR-033**: `DistributedLock` MUST provide `tryAcquire`, `acquire` (bounded wait with jittered polling), `release` and `extend` (both token-checked and atomic), and `withLock` (always releases) (AS-57, AS-58, AS-60, AS-61).
- **FR-034**: Every successful acquisition MUST carry a `fence` that is strictly greater than every earlier fence of the resource, surviving release, expiry and instance changes; `isNewerFence(current, presented)` MUST be a pure comparison (AS-59).
- **FR-035**: Lifetimes MUST be 100–600,000 ms and resources valid keys; invalid input MUST throw `InvalidCacheOptions` (AS-63).

**HTTP caching (P0410)**

- **FR-036**: `VersionEtagInterceptor` MUST emit `W/"<id>-v<version>"` for a body `{id: string, version: non-negative integer}`; `withEtag(body, etag)` MUST emit a caller-supplied entity tag verbatim; anything else MUST pass through (AS-64, AS-68, AS-69).
- **FR-037**: `If-None-Match` MUST be evaluated by weak comparison against a comma-separated list, with `*` matching any existing resource; a malformed value MUST never match and never fail the request (AS-65).
- **FR-038**: On a match for `GET` or `HEAD` the interceptor MUST answer `304` with an empty body, the `ETag` and every handler-set validator and caching header, and drop the body headers (`Content-Length`, `Content-Type`, `Content-Encoding`) (AS-64).
- **FR-039**: The interceptor MUST act only on `GET` and `HEAD` success responses (2xx with a JSON object body); it MUST NOT add a validator or a `304` to errors or unsafe methods, and a `304` MUST only follow the handler's own authorization and loading (AS-66, AS-67).
- **FR-040**: An invalid caller-supplied entity tag MUST NOT be emitted; the response is served without it and counted (AS-68).
- **FR-041**: `buildCacheControl(policy)` MUST build the header from validated parts and MUST reject contradictory policies; the interceptor MUST never overwrite a handler's `Cache-Control` (AS-70).

**Operations**

- **FR-042**: The metrics and labels of AS-71 MUST be exposed; no label may carry a key, tenant ID or value (AS-71).
- **FR-043**: Logs MUST carry `requestId`, namespace and an 8-hex key digest and MUST NOT carry values or full keys (AS-72).
- **FR-044**: Shutdown MUST close the subscription, await in-flight refreshes up to 5 s, and leave no open handle (AS-73).
- **FR-045**: Every time-dependent decision MUST use the injected clock and every random decision the injected random source (AS-74).

### Key Entities *(include if feature involves data)*

The toolkit owns **no tables** and no business data. Its records live in the shared store and in process memory only:

- **Cache entry**: key, value (or "not found"), soft expiry, hard expiry, measured load time, optional version.
- **Minimum version record**: per key, the lowest version a store may write, with a bounded retention.
- **Recompute lock**: per key, owner token, short lifetime.
- **Counter**: a named set of `member → pending delta`, plus in-flight claimed batches with their `batchId` and claim time.
- **Lock**: resource, owner token, lifetime, fence (a per-resource strictly increasing integer).
- **Bloom bitmap**: a named bit set sized from `(n, p)`.
- **Validator (entity tag)**: a string derived from `id` and `version`, or supplied by the caller.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For a cold item read by 300 concurrent requests spread over 3 instances, the source is read **once** (loader invocations per key per lifetime ≤ 1).
- **SC-002**: With the cache store completely down, 100 % of reads still return the correct value (no errors beyond the explicit overload rejection), and no read waits more than 300 ms longer than the source itself; after the first five failures the added wait is zero until the store is probed again.
- **SC-003**: After a write calls the toolkit's delete, no instance serves the old value for more than 1 s (L1) and none ever serves it after one extra read (L2); a late or duplicate event never makes data older than the newest known version reappear (zero cases in the 100 scripted replays of AS-33–AS-38).
- **SC-004**: Unknown items are looked up at the source at most once per negative lifetime per key; 10,000 repeated lookups of one unknown key cause 1 source read.
- **SC-005**: Keys written at the same instant expire spread across a ±10 % window; no more than 5 % of 1,000 same-time keys share one expiry second.
- **SC-006**: Counters lose no increment: across 20,000 racing increments and repeated drains the total is exact; after a flusher crash, 100 % of claimed counts return after the claim age.
- **SC-007**: A repeated `GET` of an unchanged resource with its validator transfers no body (`304`) in 100 % of cases, and no error or other tenant's response ever carries a validator.
- **SC-008**: Memory held by the toolkit stays bounded: after 1,000,000 distinct reads the in-process structures hold at most their configured limits.
- **SC-009**: At steady state a read that hits memory or the shared store adds under 5 ms at the 99th percentile on top of the store round trip (cache layer overhead excluded from the source).

## Assumptions

- Defaults, all configurable and validated: per-call store timeout 250 ms; recompute lock 5 s, follower wait 500 ms; L1 10,000 entries / 64 MiB / 1 s lifetime (max 5 s); entry cap 256 KiB (max 1 MiB); jitter ±10 %; breaker 5 failures / 10 s / open 5 s; loader cap 100, queue wait 2 s; minimum-version retention 300 s; counter cap 100,000 members, claim age 5 min; batch read 500 keys; invalidation 5,000 keys per call.
- The toolkit runs in every process that imports its module; instances share one store. Redis is the store and the broadcast channel; this spec says "store" and "broadcast".
- Values are JSON round-trippable; dates become strings and are not revived. Domains version their key namespaces for shape changes.
- Cached data is always derivable from a source of truth; the toolkit is never the system of record. Write-behind counters are analytics-grade (up to the in-flight loss of one drain interval if the store loses data); money never uses them.
- Delayed double delete is not offered: the versioned minimum (FR-021, FR-022) is the durable mitigation the notes list for the reader–writer race.
- Cluster-safe keys: auxiliary records share the entry's hash tag, so the toolkit works on a single node and on a cluster.
- Tests run against the real store of `docker-compose.test.yaml` with a TCP fault proxy for refuse/hang/delay (the same facility S05 uses) and a frozen clock; no mock of the store.
- Every default recorded in `questions.md` is binding until a human changes it.

## Cross-capability contracts

### Provides

All exports come from `@app/infrastructure/cache` (global `CacheModule`, X.4 entry). Names are exact.

- **`CacheModule`** (global): provides `CacheService`, `DistributedLock`, `VersionEtagInterceptor`. Requires the shared store client module.
- **`CacheService.getOrLoad<T>(key: string, loader: () => Promise<T | null>, options: GetOrLoadOptions): Promise<T | null>`**. `GetOrLoadOptions = { ttlMs: number; swrMs?: number; staleIfErrorMs?: number; negativeTtlMs?: number; jitter?: number (default 0.1); l1?: 'always' | 'hot' | 'never' (default 'hot'); l1TtlMs?: number; timeoutMs?: number (default 250); maxEntryBytes?: number; versionOf?: (value: T) => number }`. Guarantees: FR-001–FR-017, FR-024–FR-027. Honours S05 (`ttlMs, swrMs, negativeTtlMs, l1`), S11 and S21 (`ttlMs, swrMs, jitter`), S22/S23/S24 (single flight, negative entries), S28/S44 (`l1: 'never'` = no per-process copy, cross-instance invalidation), S39/S42/S43 (single flight, negative entries, invalidate with broadcast).
- **`CacheService.getOrLoadMany<T>(keys: string[], batchLoader: (missing: string[]) => Promise<Map<string, T | null>>, options: GetOrLoadOptions): Promise<(T | null)[]>`**. Needed by S05's BFF batch read (AS-38: 100 cold IDs → one statement). Guarantees FR-009.
- **`CacheService.invalidate(keys: string[]): Promise<{ l2: 'ok' | 'failed'; deleted: number }>`**. Never throws on store failure; evicts local L1; broadcasts. Used by every writer (S05, S03, S18, S22, S25, S28, S39, S42, S43, S44).
- **`CacheService.invalidateIfOlder(key: string, version: number, options?: { minimumRetentionMs?: number }): Promise<{ outcome: 'applied' | 'skipped' }>`**. Asked for by S05 (FR-025, AS-40–AS-43) and usable by S18 (FR-011, FR-012). Guarantees FR-021, FR-022.
- **`cacheKey(namespace: string, version: number, ...parts: string[]): string`**. Tenant-safe key builder (FR-007).
- **`RedisBloomFilter(redis, key, expectedItems, falsePositiveRate)`** with `add(items: string[])`, `mightContain(item: string)`, readonly `bits`, `hashes`. Used by S37 (share-link resolve), S41 (crawler seen-set). Guarantees FR-018.
- **`WriteBehindCounter(redis, name)`** with `increment(member, by = 1)`, `drain(): Promise<Map<string, number>>`, `restore(deltas)`, and new `claim(): Promise<{ batchId: string; deltas: Map<string, number> }>`, `commit(batchId): Promise<{ committed: boolean }>`, `release(batchId)`, `reclaimExpired(): Promise<number>`. Existing names and semantics of `increment`, `drain`, `restore` are kept (S05 AS-65–AS-74 flush, S25 vote deltas). Guarantees FR-028–FR-032.
- **`DistributedLock`**: `tryAcquire(resource, {ttlMs}) → Lock | null`, `acquire(resource, {ttlMs, waitMs}) → Lock`, `withLock(resource, {ttlMs}, fn: (lock) => Promise<R>) → R`; `Lock = { resource: string; token: string; fence: number; release(): Promise<boolean>; extend(ttlMs: number): Promise<boolean> }`; `isNewerFence(current: number, presented: number): boolean`. For S22 (seat holds, admission), S49 (leader locks) and any lock-protected write. Guarantees FR-033–FR-035.
- **`VersionEtagInterceptor`**, **`withEtag<T>(body: T, etag: string): T`** (marks a body with a caller-supplied entity tag, e.g. S27's `"<id>-v<version>-<locale>"`), **`matchesIfNoneMatch(headerValue: string | undefined, etag: string): boolean`** (pure; list, weak, `*`), **`buildCacheControl(policy): string`**. Guarantees FR-036–FR-041. Co-owner of P0410 with S27.
- **Errors** (exact class names): `InvalidCacheKey`, `InvalidCacheOptions`, `InvalidLoaderResult`, `CacheUnavailable`, `CacheLoaderBusy`, `CounterOverflow`, `InvalidIncrement`, `LockTimeout`, `LockUnavailable`. Domains map `CacheLoaderBusy` and `LockTimeout` to `503` with `Retry-After`; the rest are programming or infrastructure errors (`500`).
- **Metrics** (names exact): `cache_requests_total`, `cache_loader_calls_total`, `cache_loader_duration_seconds`, `cache_invalidations_total`, `cache_breaker_state`, `cache_l1_entries`, `cache_counter_pending_members`, `cache_lock_acquisitions_total` (AS-71).
- **R1 exported services**: `CacheService`, `DistributedLock`, `WriteBehindCounter` and `RedisBloomFilter` are infrastructure exports used under X.5 (`libs/domains/<d>` may import `@app/infrastructure/*`). They return DTO-free values and never touch a domain table. No R2 or R3 mechanism is involved; S52 reads no cross-domain data.

### Requires

- **Shared store client** (`infrastructure/redis`, no capability ID, as named by S50): `client.get/mget/set (PX, NX)/del/unlink/publish/hincrby/eval/evalsha/pipeline` with a per-call timeout, plus a separate subscriber connection; connection errors surface as rejections (no offline queue).
- **S54**: `Clock` (`now(): Date`, `nowMs()`, with `FakeClock` in tests, from `@app/common/core/clock`); config validation at startup for the toolkit settings (VIII.5); metrics registry; request context (`requestId` in logs); `ShutdownRegistry` ordering (`register({name, order, run})`, order 80 for the toolkit); problem+json filter for domain mapping of `CacheLoaderBusy` and `LockTimeout`.
- **S53 (consumers)** call `invalidate` / `invalidateIfOlder` from their own consumer groups; S52 requires nothing of S53 itself and publishes no events.
- **S49**: runs the flush jobs of write-behind counters (the owning domain's job calls `claim`/`drain`); S52 does not schedule anything.
- **Test harness** (`@app/test`): real store, TCP fault proxy (`test/fakes/tcp-fault-proxy.ts`), metrics reader and log capture, `FakeClock`.
