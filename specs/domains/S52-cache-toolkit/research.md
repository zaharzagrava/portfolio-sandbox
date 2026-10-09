# Research: S52 — Cache toolkit

No `NEEDS CLARIFICATION` was open; these decisions fix how, not what.

## R-01 Atomicity through Lua scripts
- **Decision**: guarded store, `invalidateIfOlder`, lock release/extend, fence acquire, counter claim/commit/release/reclaim and drain are `EVAL` scripts (`EVALSHA` with `NOSCRIPT` fallback).
- **Rationale**: AS-14, AS-36, AS-50, AS-58 need compare-and-act without a race; `lease.ts` already uses `eval`; `WATCH` does not work with auto-pipelining.
- **Alternatives**: `WATCH/MULTI` (retries, breaks under auto-pipelining); Redis Functions (needs a deployment step).

## R-02 Cluster-safe keys
- **Decision**: all records of one logical key share a hash tag: entry `K`, minimum `K` + suffix, lock `K` + suffix. A single helper derives them; scripts touch only same-tag keys.
- **Rationale**: FR-020; `cacheKey()` percent-encodes `{` `}` in parts, so a caller cannot change the tag.
- **Alternatives**: untagged prefixes (cross-slot errors on a cluster).

## R-03 Circuit breaker
- **Decision**: reuse `CircuitBreaker` (`@app/common/resilience`): `minimumCalls 5`, `failureRateThreshold 1`, `windowMs 10_000`, `openDurationMs 5_000`, `halfOpenCalls 1`; expose `cache_breaker_state` as 0/1/2.
- **Rationale**: one tested implementation; a rate of 1.0 over at least 5 calls matches the spec's scripted tests. If transition logging or the gauge cannot be had, a thin adapter in `store-guard.ts` provides them.
- **Alternatives**: own state machine (duplicates tested code).

## R-04 Per-call timeout
- **Decision**: `store-guard` races each call against a timer; on timeout the caller gets `CacheUnavailable`, the late reply is discarded, and it counts as a breaker failure.
- **Rationale**: `maxRetriesPerRequest` bounds retries, not wait; ioredis `commandTimeout` is global, not per call.

## R-05 L1
- **Decision**: `lru-cache` with `max 10_000`, `maxSize 64 MiB`, `sizeCalculation` = serialized bytes, per-entry `ttl ≤ l1TtlMs`; a health flag from `broadcast.ts` gates reads and writes; `clear()` on reconnect.

## R-06 Time and randomness
- **Decision**: injected `Clock` and a `RandomSource`; XFetch draw clamped above 0; follower polling and lock `acquire` take deadlines from the clock.
- **Rationale**: FR-045, AS-74. Exception: the per-call timeout against a hanging proxy (AS-43) and `LockTimeout` ± 50 ms (AS-61) need real timers through one `Timers` seam; those tests use `waitFor`.

## R-07 Entry envelope
- **Decision**: JSON `{v, exp, hard, delta, ver?}`; `hard = exp + max(swr, staleIfError)`, `hard = exp` for negative entries; the store lifetime is `hard − now`.
- **Rationale**: AS-17, AS-18, AS-23; one record, no shadow copy (questions LOCAL).

## R-08 Fence counter
- **Decision**: lock key holds the token; a separate counter is `INCR`ed on each acquisition inside the same script as `SET NX PX`; counter retention 30 days refreshed per acquisition.
- **Alternatives**: timestamp fences (skew breaks monotonicity).

## R-09 Counter claim
- **Decision**: `claim` renames the pending hash to a per-batch hash and records `batchId → claim time` in an index (injected clock); `commit` deletes both, `release`/`reclaimExpired` merge back with `HINCRBY`; the pending cap is checked in `increment`'s script (`HLEN` when the member is new). `drain`/`restore` unchanged.

## R-10 ETag
- **Decision**: list parser splits on commas outside quotes; weak comparison of opaque tags; `*` matches an existing resource; interceptor acts only on GET/HEAD 2xx object bodies; `withEtag` tags the body with a non-enumerable symbol; 304 keeps handler headers except `Content-Length/Type/Encoding`.

## R-11 Metrics and logs
- **Decision**: `MetricsRegistry` with only the `namespace` label (first key segment, validated pattern, so cardinality is bounded by code); logs carry `requestId`, namespace, 8-hex SHA-256 key digest.

## R-12 Not built
Delayed double delete, hot-key bucket replication and any `set` API are out of scope (questions LOCAL, FR-010).
