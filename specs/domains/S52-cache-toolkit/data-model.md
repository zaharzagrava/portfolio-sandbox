# Data Model: S52 — Cache toolkit

No database table, no migration. All records live in the shared store or in process memory. `{K}` marks the hash tag shared by all records of one logical key.

## Store records

| Record | Key | Type | Fields | Lifetime |
|---|---|---|---|---|
| Cache entry | `K` | string (JSON) | `v` (value or `null` = negative), `exp` (soft expiry, ms), `hard` (hard expiry), `delta` (load ms), `ver?` (integer) | `hard − now`, jittered |
| Minimum version | `{K}:min` | string | integer | `minimumRetentionMs` (default 300 s) |
| Recompute lock | `{K}:lock` | string | owner token (random) | 5 s |
| Pending counter | `counter:{name}:pending` | hash | member → delta | until drained |
| Claimed batch | `counter:{name}:claim:<batchId>` | hash | member → delta | until commit/release/reclaim |
| Claim index | `counter:{name}:claims` | zset | batchId scored by claim time | with the batches |
| Lock | `lock:{resource}` | string | owner token | `ttlMs` (100–600,000) |
| Fence counter | `lock:{resource}:fence` | string | integer, strictly increasing | 30 days after last acquisition |
| Bloom bitmap | caller key | bitmap | `m` bits, `k` hashes | caller's |
| Broadcast | channel `cache:invalidate` | pub/sub | batch of keys, or a versioned drop | none |

## Validation rules

- Key: non-empty, ≤ 512 bytes, one namespace segment before the first `:`, no whitespace or control characters (`InvalidCacheKey`).
- `cacheKey(ns, v, ...parts)`: `ns` matches `^[a-z][a-z0-9-]*$`; `v` positive integer; parts non-empty and percent-encoded for `: { } %`, whitespace and control characters.
- Options: `ttlMs > 0`; `swrMs ≥ 0`; `0 < negativeTtlMs ≤ ttlMs`; `jitter ∈ [0, 0.5]`; `l1TtlMs ≤ 5000`; `timeoutMs ∈ [10, 5000]`; `maxEntryBytes ≤ 1 MiB`; versions are non-negative safe integers; `minimumRetentionMs ∈ [1000, 3_600_000]`; batch ≤ 500 keys; invalidate ≤ 5,000 keys.
- Counter: name `^[a-z][a-z0-9-]*$` ≤ 64; `by` non-zero safe integer; member 1–256 bytes; ≤ 100,000 pending members.
- Lock: `ttlMs ∈ [100, 600_000]`; resource ≤ 256 bytes, no whitespace.

## State transitions

- **Entry**: absent → fresh (`now < exp`) → stale (`exp ≤ now < exp + swr`, positive entries only) → stale-on-error (`< exp + staleIfError`, only when the loader fails) → gone. A negative entry goes fresh → gone at `exp`.
- **Store of a loaded value**: allowed when no minimum exists, or when `ver ≥ minimum`; refused (`refused_below_minimum`, `refused_unversioned`) otherwise; the caller still receives the value.
- **`invalidateIfOlder(K, n)`**: delete the entry if `ver < n` or unversioned; raise the minimum to `n` unless the entry's `ver ≥ n`; never lower; result `applied` or `skipped`.
- **Counter batch**: pending → claimed (`claim`) → committed (deleted) | released/reclaimed (merged into pending).
- **Circuit breaker**: closed → open (5 failures in 10 s) → half-open after 5 s → closed (probe ok) | open (probe fails).
- **Lock**: free → held(token, fence n) → free (release, expiry); the next acquisition gets fence > n.

## In-process structures (all bounded)

| Structure | Bound | Empty when idle |
|---|---|---|
| L1 LRU | 10,000 entries, 64 MiB | no (cache) |
| Single-flight table | concurrent distinct keys | yes |
| Hot-key detector | 10,000 keys per window | reset per window |
| Pending refreshes | one per key | yes |
| Loader bulkhead | 100 running, FIFO queue ≤ wait 2 s | yes |
| Log rate limiters | one entry per namespace | n/a |
