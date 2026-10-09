---

description: "Task list for S52 — Cache toolkit"
---

# Tasks: S52 — Cache Toolkit (domain `infrastructure`)

**Input**: `spec.md`, `plan.md`, `test-plan.md`, `gaps.md` (A1–A28, B, C), `questions.md` (defaults accepted), `data-model.md`, `contracts/cache-toolkit.md`, `research.md`, `quickstart.md`.

**Tests**: requested (constitution VII, test-plan.md). Every test-plan row has a failing test task that comes before its code task.

**Conventions**
- `LIB` = `packages/backend/libs/infrastructure/cache`. Run backend commands from `packages/backend`.
- `T` = `/opt/sdd/repo/scripts/sdd/test-spec.sh`, e.g. `$T libs/infrastructure/cache/cache-key.spec.ts`. Open the full log only if the condensed output is not enough. Run the narrowest test that proves the change; the whole suite once at the end (T062).
- Real Redis (`docker-compose.test.yaml`), `TcpFaultProxy` (`test/fakes/tcp-fault-proxy.ts`), `FakeClock`, scripted random source. No fixed sleeps, no store mock.
- Transactions: the lib opens none and no `sequelize.transaction` is added (rule 4). Never use git checkout/restore/reset/stash/clean; undo by hand-editing only the named lines.
- If the same test still fails after 5 fix attempts: stop, write the blocker, what was tried and the hypothesis into `questions.md`.
- Constraints from `data-model.md` are quoted verbatim in the tasks that implement them.

## Phase 1: Setup

- [X] T001 Check `packages/backend/package.json` for `fast-check` (devDependency) and that the pinned `lru-cache` supports `maxSize` + `sizeCalculation`; add `fast-check` only if absent.
- [X] T002 Extend the ESLint `no-restricted-syntax` rule (already bans `Date.now`) to also ban `Math.random` for `packages/backend/libs/infrastructure/cache/**` in the backend ESLint config (A17, AS-74). Do not touch other globs.

---

## Phase 2: Foundational (blocks all stories)

**Purpose**: fixture module, config, seams, errors, key/option/codec contracts, Lua scripts. Plan work-order steps 1–2 (A26, A28, A17, A10–A14).

### Tests first

- [X] T003 [P] Write failing `LIB/cache-key.spec.ts` (AS-09, `it.each`): `cacheKey(ns, v, ...parts)` → `<namespace>:v<version>:<encoded parts joined by ':'>`; `ns` matches `^[a-z][a-z0-9-]*$`; `v` positive integer; parts non-empty and percent-encoded for `: { } %`, whitespace and control characters; `validateKey`: "non-empty, ≤ 512 bytes, one namespace segment before the first `:`, no whitespace or control characters" → `InvalidCacheKey`; tenant A/B keys never collide; hash-tag `{K}` derivation. Run `$T libs/infrastructure/cache/cache-key.spec.ts` (fails).
- [X] T004 [P] Write failing `LIB/cache-options.spec.ts` (AS-10, AS-41; the AS-63 lock cases are added in T043): `it.each` per invalid field, `InvalidCacheOptions` carries the field name. Rules verbatim: "`ttlMs > 0`; `swrMs ≥ 0`; `0 < negativeTtlMs ≤ ttlMs`; `jitter ∈ [0, 0.5]`; `l1TtlMs ≤ 5000`; `timeoutMs ∈ [10, 5000]`; `maxEntryBytes ≤ 1 MiB`; versions are non-negative safe integers; `minimumRetentionMs ∈ [1000, 3_600_000]`; batch ≤ 500 keys; invalidate ≤ 5,000 keys"; `staleIfErrorMs ≥ 0`; `l1` ∈ `hot|always|never`; defaults `jitter` 0.1, `timeoutMs` 250, entry cap 256 KiB. Invalid `versionOf` results (negative, 1.5, NaN, unsafe) are the AS-41 table.
- [X] T005 [P] Write failing `LIB/cache-surface.spec.ts` (AS-40): `expectTypeOf<CacheService>()` has no `set`/`put` member; surface matches the contract (`getOrLoad`, `getOrLoadMany`, `invalidate`, `invalidateIfOlder`).
- [X] T006 [P] Write failing `LIB/entry-codec.spec.ts` (A10–A12 pure parts): encode/parse envelope `{v, exp, hard, delta, ver?}`; garbage bytes/non-envelope → `corrupt`; `undefined`, cyclic, BigInt, function values → `InvalidLoaderResult` before anything is stored; size over cap → `oversize` (returned, never stored).

### Implementation

- [X] T007 Create `LIB/cache.errors.ts`: nine classes extending `AppError`: `InvalidCacheKey`, `InvalidCacheOptions` (carries the field name), `InvalidLoaderResult`, `CacheUnavailable`, `CacheLoaderBusy` (503 + `Retry-After`), `CounterOverflow`, `InvalidIncrement`, `LockTimeout` (503 + `Retry-After`), `LockUnavailable`.
- [X] T008 [P] Implement `LIB/cache-key.ts` (`cacheKey`, `validateKey`, hash-tag helper, 8-hex digest for logs) until T003 passes (A14).
- [X] T009 [P] Implement `LIB/cache-options.ts` (option, version, batch and invalidate-size validation, defaults) until T004 passes (A13, FR-008, FR-023).
- [X] T010 [P] Implement `LIB/entry-codec.ts` (envelope encode/parse, size cap, JSON check) until T006 passes (A10–A12).
- [X] T011 Create `LIB/cache.config.ts`: `CacheToolkitConfig` validated at startup (L1 10,000 entries / 64 MiB; store timeout 250 ms; breaker 5 failures / 10 s / open 5 s / one probe; bulkhead 100 / 2 s wait; entry cap 256 KiB, max 1 MiB; minimum retention 300 s; counter claim age 5 min; pending-member cap 100,000; fence retention 30 days). Invalid config fails boot. Wire into `LIB/cache.module.ts` (A28).
- [X] T012 Inject seams: provide `CLOCK` (`@app/common/core/clock`) and a `RandomSource` token in `LIB/cache.module.ts`; replace every `Date.now` / `Math.random` default in `LIB/cache.service.ts`, `LIB/xfetch.ts`, `LIB/hot-key-detector.ts` (A17). The T002 lint rule must pass for the lib.
- [X] T013 Create `LIB/cache-scripts.ts`: all Lua in one file — guarded store (entry + `{K}:min`), invalidate-if-older, lock release (compare-and-delete), recompute-lock claim, fence acquire, counter claim/commit/release/reclaim. Hash-tagged keys, one shard per key.
- [X] T014 Create `LIB/testing/cache-fixture.module.ts` (test code only, imports no domain, no seeds): a second `CacheService` factory over the same store, a scripted random source, a loader-spy helper; HTTP fixture routes are added in T048. Remove the `@app/domains/catalog` / `SeedsModule` / `TableName` imports and the `GET /api/products/:id` test from `LIB/cache.e2e-spec.ts` (A26, D-1/D-2/D-3 residue).
- [X] T015 Create the public barrel `LIB/index.ts` (`@app/infrastructure/cache`, X.4) exporting the names in spec "Provides"; add the path alias if missing. Run `$T libs/infrastructure/cache/cache-key.spec.ts`, `cache-options.spec.ts`, `cache-surface.spec.ts` (AS-09, 10, 40, 41 green).

**Checkpoint**: seams, config, contracts in place; old e2e still compiles.

---

## Phase 3: User Story 1 — Read served from the cheapest correct level (P1)

**Goal**: L1/L2 read path, validation, corrupt/oversize handling, `getOrLoadMany`. AS-01–AS-08, AS-11; gaps A1, A10–A12, A15 (L1 bounds), A20.

**Independent test**: `$T libs/infrastructure/cache/cache-read-path.e2e-spec.ts`.

- [X] T016 [US1] Write failing `LIB/cache-read-path.e2e-spec.ts`, each test asserting value and persisted state/metric: AS-01 cold then warm, entry TTL window, outcome metric; AS-02 `l1: 'always'`, FakeClock +1001 ms; AS-03 `l1: 'never'`, L1 size probe stays 0; AS-04 scripted sampler promotion served with zero store calls; AS-05 20,000 keys, L1 entries ≤ 10,000; AS-06 `undefined` and cyclic/BigInt loader results → `InvalidLoaderResult`, nothing stored; AS-07 garbage bytes written through the real store → miss, overwritten, `corrupt`; AS-08 300 KiB value returned, nothing stored, logged once; AS-11 `getOrLoadMany` (one store read, one batch loader call, order kept, duplicates, >500 keys rejected, nulls). Port the old `cache.e2e-spec.ts` scenarios into the matching feature files (A27; tracked in T060).
- [X] T017 [P] [US1] Implement `LIB/l1-cache.ts`: LRU by count (10,000) and bytes (64 MiB) via `sizeCalculation`, `clear()`, size probe, per-call TTL ≤ 5000 ms, `hot|always|never` policy (A15, FR-002–FR-004).
- [X] T018 [P] [US1] Fix `LIB/hot-key-detector.ts`: rolls on the injected clock (not only on access); when full, evicts the coldest/oldest so new hot keys are still detected; injected random source for sampling (A20, AS-04).
- [X] T019 [US1] Rewrite the read path in `LIB/cache.service.ts`: validate key/options, L1 → L2 → loader, envelope via `entry-codec`, corrupt → miss + overwrite + `corrupt`, oversize → return but don't store, `InvalidLoaderResult` before storing (A10–A14). Make T016 AS-01–AS-08 pass.
- [X] T020 [US1] Add `getOrLoadMany(keys, batchLoader, options)` to `LIB/cache.service.ts` (≤ 500 keys, one store read, one loader call for the missing keys, order preserved, duplicates collapsed) (A1, AS-11). Run `$T libs/infrastructure/cache/cache-read-path.e2e-spec.ts` green.

---

## Phase 4: User Story 2 — Popular key expiring does not hurt the database (P1)

**Goal**: stampede protection. AS-12–AS-21; gaps A4, A5, A6, A7, A25.

**Independent test**: `$T libs/infrastructure/cache/cache-stampede.e2e-spec.ts` and `xfetch.spec.ts`.

- [X] T021 [P] [US2] Write failing `LIB/xfetch.spec.ts` (AS-19, AS-20; `it.each` + `fast-check`): early-refresh probability over r, delta, now; r = 0 and delta = 0 edges; monotonic in r; `jitterTtl` bounds (±jitter), spread, jitter 0 disables, 1 s view; always in range.
- [X] T022 [US2] Write failing `LIB/cache-stampede.e2e-spec.ts`: AS-12 200 concurrent misses → 1 load; AS-13 three toolkit objects over one store, 300 reads → 1 load; AS-14 lock expiry under a slow loader, owner-token release (old holder cannot delete the new holder's lock), follower budget (poll on FakeClock, jitter up to 500 ms, then load); AS-15 rejecting loader, 50 waiters all rejected, in-flight table empty; AS-16 SWR at exp−1 / exp, one refresh across 3 instances, failing refresh keeps stale; AS-17 clock at exp + swrMs → blocking reload; AS-18 stale-if-error window and beyond; AS-21 FakeClock-driven 120 ms loader, envelope `delta`, duration histogram.
- [X] T023 [P] [US2] Update `LIB/xfetch.ts`: injected clock and random, `beta` 1, `jitterTtl(ttl, jitter)` (A17, FR-014). Make T021 pass.
- [X] T024 [P] [US2] Update `LIB/single-flight.ts`: keep API, rejection shared with all waiters, table cleared in `finally`, `size()` for the idle-empty assertion (A25, AS-15).
- [X] T025 [US2] Implement the recompute lock in `LIB/cache.service.ts` + `LIB/cache-scripts.ts`: random owner-token value, release by compare-and-delete script, 5 s lock; followers poll on the injected clock with jitter up to 500 ms, then load; a follower accepts only a valid fresh envelope; a failing lock `SET` fails open (remove `.catch(() => 'OK')`, never marks acquired) (A4, A6, A7, AS-14).
- [X] T026 [US2] Route every refresh path (miss, stale/SWR, XFetch early) through the cross-instance lock; `staleIfErrorMs` stored by extending retention to `exp + max(swr, staleIfError)`; serve stale on loader failure within the window only (A5, AS-16–AS-18, AS-21 histogram). Run `$T libs/infrastructure/cache/cache-stampede.e2e-spec.ts` and `xfetch.spec.ts` green.

---

## Phase 5: User Story 3 — Lookups for nonexistent things don't reach the DB (P1)

**Goal**: negative caching and Bloom filter. AS-22–AS-28; gaps A8, A21.

**Independent test**: `$T libs/infrastructure/cache/cache-penetration.e2e-spec.ts` and `bloom-filter.spec.ts`.

- [X] T027 [P] [US3] Write failing `LIB/bloom-filter.spec.ts` (AS-27, `it.each`): (n, p) → bits, hashes; rejected inputs (n ≤ 0, non-integer, p ∉ (0,1)); 2³² bit cap; `add` batch bound; hash index asserted `< 2³²`.
- [X] T028 [US3] Write failing `LIB/cache-penetration.e2e-spec.ts`: AS-22 five reads of an unknown key → one load, TTL window, +12 s reload; AS-23 negative entry has hard = soft and ignores SWR/stale-if-error; AS-24 `null` without `negativeTtlMs` is not stored; AS-25 `invalidate` replaces a negative entry; AS-26 10,000 members zero false negatives (`fast-check`), FPR ≤ 2 % on the real bitmap; AS-28 store refused via fault proxy → `mightContain` returns `true` and is counted, `add` idempotent.
- [X] T029 [US3] Negative entries in `LIB/cache.service.ts`: `v: null`, `hard = exp`, never served stale, outcome `negative`, only when `negativeTtlMs` is set (A8, AS-22–AS-25).
- [X] T030 [P] [US3] Harden `LIB/bloom-filter.ts`: validate `n`, `p`, 2³² cap; `mightContain` fails open (`true`) with a counter on store failure; batch bound on `add`; constructor unchanged for S37/S41 (A21, AS-26–AS-28). Make T027 and T028 pass.

---

## Phase 6: User Story 4 — Write visible at once, never overwritten by a slow reader (P1)

**Goal**: invalidation, versions, broadcast health. AS-29–AS-41; gaps A2, A3, A15.

**Independent test**: `$T libs/infrastructure/cache/cache-invalidation.e2e-spec.ts`.

- [X] T031 [US4] Write failing `LIB/cache-invalidation.e2e-spec.ts`: AS-29 two toolkit objects, broadcast evicts the other's L1, `UNLINK` used; AS-30 fault proxy refuse → no throw, `l2: 'failed'`, L1 evicted; AS-31 drop B's subscription → L1 bypassed, cleared on reconnect; AS-32 5,000 keys with duplicates → ≤ 10 round trips, deduped, empty array no-op; AS-33 versioned apply; AS-34 duplicate delivery; AS-35 out-of-order delivery; AS-36 slow reader gated on a deferred promise cannot resurrect the old value; AS-37 in-flight load leaves no entry; AS-38 negative and unversioned entries; AS-39 minimum retention (FakeClock +301 s expires it; bounds 1–3,600 s). Include the 100 scripted replays of SC-003.
- [X] T032 [P] [US4] Create `LIB/broadcast.ts`: subscriber with `error`/`reconnect` handling, health flag, channel `cache:invalidate`, message = JSON list of keys or `{key, version}`; L1 cleared on reconnect (A15, AS-31).
- [X] T033 [US4] Implement `invalidate` in `LIB/cache.service.ts`: dedupe, chunks, `UNLINK`, batched publish, never throws on store failure, always evicts L1, returns `{l2: 'ok'|'failed', deleted}`; ≤ 5,000 keys (A3, AS-29, AS-30, AS-32).
- [X] T034 [US4] Implement `invalidateIfOlder(key, version, {minimumRetentionMs?})` → `{outcome: 'applied'|'skipped'}` and the guarded store (entry + `{K}:min`) as Lua in `LIB/cache-scripts.ts`: "delete the entry if `ver < n` or unversioned; raise the minimum to `n` unless the entry's `ver ≥ n`; never lower"; store allowed "when no minimum exists, or when `ver ≥ minimum`; refused (`refused_below_minimum`, `refused_unversioned`) otherwise; the caller still receives the value"; `versionOf` option; `cache_invalidations_total{result}` (A2, A13, AS-33–AS-39).
- [X] T035 [US4] Use broadcast health in the read path: L1 only while the subscription is healthy (A15). Change `packages/backend/libs/domains/tenancy/application/membership.service.ts:28` and `packages/backend/libs/domains/billing/application/entitlements.service.ts:44` from `return …invalidate(...)` to `await` (behaviour unchanged, no other edit). Run `pnpm exec tsc --noEmit` to confirm the other 18 call sites compile. Run `$T libs/infrastructure/cache/cache-invalidation.e2e-spec.ts` green.

---

## Phase 7: User Story 5 — Cache outage slows reads, never breaks them (P1)

**Goal**: timeout, breaker, bulkhead, fail-open. AS-42–AS-48; gap A16.

**Independent test**: `$T libs/infrastructure/cache/cache-degradation.e2e-spec.ts`.

- [X] T036 [US5] Write failing `LIB/cache-degradation.e2e-spec.ts` (fault proxy for all): AS-42 refuse, 100 concurrent reads all correct; AS-43 hang → 250 ms bound (and `timeoutMs: 50`); AS-44 breaker closed→open (5 in 10 s)→half-open (after 5 s, one probe)→closed, `cache_breaker_state` gauge, one log per transition, zero added wait while open; AS-45 500 distinct keys, loader concurrency ≤ 100, queue wait 2 s then `CacheLoaderBusy` (503 + `Retry-After` via the problem filter); AS-46 proxy restored → repopulates; AS-47 recompute lock fails open and `DistributedLock.tryAcquire` rejects `LockUnavailable` (the lock half passes after T045); AS-48 L1 served within `l1TtlMs` while the store is down.
- [X] T037 [P] [US5] Create `LIB/store-guard.ts`: per-call timeout (default 250 ms, from `timeoutMs`) + `CircuitBreaker` (`@app/common/resilience`) 5 failures / 10 s / open 5 s / one probe; every store call in `cache.service.ts` and `bloom-filter.ts` goes through it (A16).
- [X] T038 [P] [US5] Create `LIB/loader-bulkhead.ts`: cap 100 running loaders, FIFO queue, 2 s wait, then `CacheLoaderBusy`; empty when idle (A16).
- [X] T039 [US5] Wire guard and bulkhead into the read path: store failure → fail open to the loader, outcome `degraded`; breaker gauge and transition logs. Make T036 pass except AS-47's lock half (A16, AS-42–AS-48).

---

## Phase 8: User Story 6 — Hot, low-value counts are cheap to record (P2)

**Goal**: crash-safe write-behind counters. AS-49–AS-56; gap A22.

**Independent test**: `$T libs/infrastructure/cache/write-behind-counter.e2e-spec.ts` and `write-behind-counter.spec.ts`.

- [X] T040 [P] [US6] Write failing `LIB/write-behind-counter.spec.ts` (AS-53, `it.each`): "name `^[a-z][a-z0-9-]*$` ≤ 64; `by` non-zero safe integer; member 1–256 bytes"; `by` of 0, 1.5, NaN, Infinity → `InvalidIncrement`.
- [X] T041 [US6] Write failing `LIB/write-behind-counter.e2e-spec.ts`: AS-49 two instances × 10,000 increments exact; AS-50 20,000 increments racing a 5 ms `drain` loop, total exact; AS-51 `restore` merges with new increments; AS-52 `claim` → crash → FakeClock +5 min `reclaimExpired` → `commit` twice (second no-op), unknown id, `release`; AS-54 cap lowered to 50 members in the test module → `CounterOverflow` ("≤ 100,000 pending members" by default); AS-55 two names, same member are independent; AS-56 fault proxy refuse → staged counts survive; gauge `cache_counter_pending_members{counter}`.
- [X] T042 [US6] Implement `LIB/write-behind-counter.ts`: input validation, pending cap with `CounterOverflow`, keep `drain`/`restore` unchanged, add `claim`/`commit`/`release`/`reclaimExpired` as Lua (records `counter:{name}:pending`, `counter:{name}:claim:<batchId>`, `counter:{name}:claims`), gauge (A22). Make T040/T041 pass.

---

## Phase 9: User Story 7 — Single holder with fencing tokens (P2)

**Goal**: `DistributedLock`. AS-57–AS-63; gap A23.

**Independent test**: `$T libs/infrastructure/cache/distributed-lock.e2e-spec.ts`.

- [X] T043 [P] [US7] Add the AS-63 `it.each` cases to `LIB/cache-options.spec.ts`: "`ttlMs ∈ [100, 600_000]`; resource ≤ 256 bytes, no whitespace"; wait-time bounds. Failing first.
- [X] T044 [US7] Write failing `LIB/distributed-lock.e2e-spec.ts`: AS-57 20 concurrent `tryAcquire` → one winner; AS-58 expiry under holder A, B acquires, `A.release()` returns false and B's lock stays; AS-59 three instances, strictly increasing fences, `isNewerFence`; AS-60 `extend` before/after loss, `withLock` releases on throw; AS-61 `acquire` waits until release, `LockTimeout` at 100 ms ± 50; AS-62 fault proxy refuse → `LockUnavailable`. Assert `cache_lock_acquisitions_total{outcome}`.
- [X] T045 [US7] Implement `LIB/distributed-lock.ts`: `tryAcquire(resource,{ttlMs})`, `acquire`, `withLock`, `Lock = {resource, token, fence, release(), extend(ttlMs)}`, `isNewerFence(current, presented)`; records `lock:{resource}` and `lock:{resource}:fence` (retention 30 days after the last acquisition) via Lua in `cache-scripts.ts`; fails closed (`LockUnavailable`) when the store is down (A23). Make T043, T044 and the AS-47 lock half of T036 pass. Do not migrate the four hand-rolled call sites (S22/S49 decide).

---

## Phase 10: User Story 8 — Clients and CDNs revalidate (P2)

**Goal**: RFC 9110 ETag interceptor. AS-64–AS-70; gap A24.

**Independent test**: `$T libs/infrastructure/cache/http-caching.e2e-spec.ts`, `etag-match.spec.ts`, `cache-control.spec.ts`.

- [X] T046 [P] [US8] Write failing `LIB/etag-match.spec.ts` (AS-65, `it.each`): list, weak (`W/`), `*`, whitespace, malformed never matches; weak comparison.
- [X] T047 [P] [US8] Write failing `LIB/cache-control.spec.ts` (AS-70, `it.each`): `buildCacheControl(policy)` outputs and rejected combinations (`no-store` with `max-age`, negative values, `public` with `private`).
- [X] T048 [US8] Write failing `LIB/http-caching.e2e-spec.ts` against fixture routes (extend `LIB/testing/cache-fixture.module.ts`; production pipe/filter/prefix, `supertest`, fixture response schema): AS-64 headers repeated on 304, ETag changes on version bump; AS-66 HEAD behaves as GET, unsafe methods untouched; AS-67 tenant B with A's validator → 404/403/401/5xx carry no ETag and never 304 (also `*` on a 404); AS-68 `withEtag` verbatim, invalid validator omitted and counted; AS-69 no version / no id / streamed body → no validator.
- [X] T049 [P] [US8] Implement `LIB/etag-match.ts` (`matchesIfNoneMatch`) and `LIB/cache-control.ts` (`buildCacheControl`); make T046 and T047 pass.
- [X] T050 [US8] Rewrite `LIB/etag.interceptor.ts` per contract: GET/HEAD, 2xx, JSON object body only; `ETag: W/"<id>-v<version>"` or verbatim `withEtag`; no id → no validator (remove the `'r'` fallback); match → `304`, empty body, keep `ETag`, handler-set `Cache-Control`, `Cache-Tag`, `Vary`, `Content-Language`, `Content-Location`; drop `Content-Length`, `Content-Type`, `Content-Encoding`; never overwrite handler `Cache-Control`; no import of the rate-limit decorator (D-17). Export `withEtag`. Make T048 pass (A24).

---

## Phase 11: User Story 9 — Operator can see it and trust it to stay small (P2)

**Goal**: metrics, logs, shutdown, bounded structures. AS-71–AS-74; gaps A9, A18, A19.

**Independent test**: `$T libs/infrastructure/cache/cache-operations.e2e-spec.ts`.

- [X] T051 [US9] Write failing `LIB/cache-operations.e2e-spec.ts`: AS-71 scrape the metrics registry: exact names `cache_requests_total{namespace, outcome}` (outcomes `l1`, `l2`, `miss`, `negative`, `stale`, `degraded`, `corrupt`, `oversize`, `stale_error`, `refused_*`), `cache_loader_calls_total`, `cache_loader_duration_seconds`, `cache_invalidations_total{result}`, `cache_breaker_state`, `cache_l1_entries`, `cache_counter_pending_members{counter}`, `cache_lock_acquisitions_total{outcome}`; label `namespace` only (bounded cardinality); AS-72 captured log lines hold namespace + 8-hex digest, never the key or value (marker string absent), warnings rate-limited 10 s / 60 s per namespace; AS-73 `app.close()` with two refreshes in flight awaits them (≤ 5 s), no open handles, in-process tables empty.
- [X] T052 [P] [US9] Create `LIB/cache-metrics.ts` (all metrics above through `MetricsRegistry`; a negative hit is `negative`, a stored `null` is not `miss`) (A9) and `LIB/cache-log.ts` (namespace + digest, per-namespace rate limit) (A19); replace the `L2 read failed for ${key}` / `L2 write failed for ${key}` logs.
- [X] T053 [P] [US9] Create `LIB/refresh-tracker.ts`: one tracked background refresh per key, awaited up to 5 s on shutdown via `ShutdownRegistry` order 80, then the subscriber is closed (A18).
- [X] T054 [US9] Wire metrics, logs and the tracker into `cache.service.ts`, `broadcast.ts`, `store-guard.ts`, `distributed-lock.ts`, `write-behind-counter.ts`, `bloom-filter.ts`, `etag.interceptor.ts`; make T051 pass (AS-71–AS-73). AS-74 is proven by the FakeClock-only specs and the T002 lint rule; run ESLint on the lib to confirm.

---

## Phase 12: Polish & cross-cutting

- [X] T055 Caller keys (gaps A): check `membershipCacheKey`, `recipientKey`, `entitlementsKey`, `siteKey`, `endpointKey`, `shopEndpointsKey`, `linkCacheKey` and the literal keys (`auth:user:v1:<id>`, `experiments:running`, `launch-event:v1:<id>`, `api:pinned:<shop>`, `product:v1:<id>`) against `validateKey`. For any key without a `:` namespace or with `{`, `}`, whitespace, add a bullet under "## Sibling-spec follow-ups" in `gaps.md` (do not edit their specs). Change caller code only when a call would throw at runtime and the minimal rename fixes it.
- [X] T056 Verify counter names `product-views` and `vote-deltas` satisfy the name rule and that `drain`/`restore` use at `packages/backend/libs/domains/catalog/infra/product-views.jobs.ts:45-57` still compiles and behaves the same.
- [X] T057 Gaps B/C: run `pnpm check:table-ownership`; if it cannot run (dependency install failed earlier), record "not run" in `gaps.md` and keep the reasoned result. Confirm no `sequelize.transaction` under `LIB` and no domain import under `LIB` (A26 residue gone).
- [X] T058 Keep `gaps.md` "Sibling-spec follow-ups" accurate (S18, tenancy owner, S05, S11, S22/S49, S27, S28/S44, helper-key domains, dashboards are already written); add bullets for anything T055 found. Do not edit other specs.
- [X] T059 Ops artifacts: confirm SC-004, SC-005, SC-008, SC-009 are under "Ops artifacts" in `quickstart.md` and as "not run" rows in `specs/UNVERIFIED.md` (already present); change only if a test above now proves one. SC-001/002/003/006/007 are proven by AS-12/13, 42/43, 29–38, 49–52, 64–69. Never call the four verified.
- [X] T060 Delete `LIB/cache.e2e-spec.ts` once each of its seven scenarios (stampede, cross-instance, SWR, negative, invalidate, counter, product route → S05) is covered by a feature file (A27); list the mapping in the commit message body.
- [X] T061 Static gates from `packages/backend`: `pnpm exec tsc --noEmit`; ESLint on `libs/infrastructure/cache` and the two edited callers; `pnpm check:boundaries` (X.5).
- [X] T062 Run the whole cache suite once against real Redis: `$T libs/infrastructure/cache`. Expect green and no open-handle warning. Then run the membership and entitlements specs narrowly to confirm the `await` change is harmless.

---

## Dependencies & order

- Phase 1 → Phase 2 (blocks all) → stories. Within a story: test task(s) → [P] helper modules → service wiring → green run.
- US1 first (base of `cache.service.ts`). US2–US5 all edit `cache.service.ts`, so their service tasks run in sequence (stampede → penetration → invalidation → degradation); test-writing and new-module [P] tasks can run in parallel across stories.
- US6, US7, US8 do not depend on `cache.service.ts` and can run in parallel with US1–US5 after Phase 2. T045 completes AS-47's lock half; T054 touches every module, so it comes after US6–US8.
- Polish after all stories.

## Parallel examples

- Phase 2 tests: T003, T004, T005, T006 together; then T008, T009, T010.
- After Phase 2: US6 (T040–T042), US7 (T043–T045), US8 (T046–T050) alongside US1 (T016–T020).
- US5: T037 ‖ T038. US9: T052 ‖ T053.

## Implementation strategy

- MVP = Phase 1 + 2 + US1: usable read path, contracts, config, fixture; existing callers keep working.
- Then P1 stories US2 → US5, running each story's e2e file after it; then P2 stories US6–US9; Polish last with the single whole-suite run.

## Gap coverage

A1→T020 · A2→T034 · A3→T033 · A4→T025 · A5→T026 · A6→T025 · A7→T025 · A8→T029 · A9→T052 · A10–A12→T006/T010/T019 · A13→T004/T009/T034 · A14→T003/T008/T019 · A15→T017/T032/T035 · A16→T037–T039 · A17→T002/T012/T023 · A18→T053 · A19→T052 · A20→T018 · A21→T027/T030 · A22→T040–T042 · A23→T043–T045 · A24→T046–T050 · A25→T024 · A26→T014 · A27→T016/T060 · A28→T011 · B, C→T057 · Callers→T035/T055/T056 · Sibling follow-ups→T058 · Unverified criteria→T059.
