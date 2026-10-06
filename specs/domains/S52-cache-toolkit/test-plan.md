# Test Plan: S52 — Cache toolkit (domain `infrastructure`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md), each proven at the lowest layer that can prove it. A dash means the layer does not test that scenario.

- API e2e files live in `packages/backend/libs/infrastructure/cache/`. Each file's top-level `describe` names its feature (VII.8). Because the toolkit is a library, the e2e specs boot a Nest app from `CacheModule` plus a **fixture module** (test code only) that exposes a few real HTTP routes for the ETag scenarios (`http-caching.e2e-spec.ts`) and call real services for the rest, with the production global pipe, filter, prefix and interceptors; HTTP scenarios go through `supertest`.
- Real Redis from `docker-compose.test.yaml` (production major version); mocking the store is forbidden (VII.2). **Fault injection** uses the real TCP fault proxy (`test/fakes/tcp-fault-proxy.ts`: refuse, hang, delay). "Another instance" is a second `CacheService` constructed over the same store, as the current spec does.
- Time and randomness: `FakeClock` for every expiry; a scripted random source for XFetch, jitter and hot-key sampling. No fixed sleeps (`waitFor` only).
- Every e2e test asserts the returned value **and** the persisted state (the store's entry and its TTL, the minimum record, the pending hash, the lock key) or the emitted metric or log line (VII.2).
- Contract layer (VII.6): fixture routes parse their responses with a fixture schema; the toolkit has no public API schema in `packages/contracts`.
- Unit specs sit beside the code, are table-driven (`it.each`), and exist only for pure logic (VII.5): key builder, options validation, XFetch and jitter, Bloom sizing, ETag matching, `Cache-Control` builder, counter input rules, type surface. `fast-check` covers XFetch monotonicity, jitter bounds and the Bloom no-false-negative property.
- **UI journeys**: none. The toolkit has no screen. Its user-visible effect (a product page that opens fast and revalidates) is the happy path already owned by W04/W02 and S05 (`packages/web/tests/product-community.spec.ts`); no edge case is re-tested there.
- Static gates (VII.1): `tsc --noEmit`, ESLint (including the ban on `Date.now` and `Math.random` in this lib), `pnpm check:boundaries` (infrastructure imports no domain: X.5), `pnpm check:table-ownership` (this lib owns and queries no table).
- Every degradation path (breaker, bulkhead, store down, hang, lost broadcast) has a forcing test (VII.9). A bug fix adds a test that fails without it.

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 | `cache-read-path.e2e-spec.ts`: cold then warm; entry TTL window; outcome metric | — | — |
| AS-02 | `cache-read-path.e2e-spec.ts`: L1 always, FakeClock +1001 ms | — | — |
| AS-03 | `cache-read-path.e2e-spec.ts`: l1 never, L1 size probe stays 0 | — | — |
| AS-04 | `cache-read-path.e2e-spec.ts`: scripted sampler, promotion served with zero store calls | — | — |
| AS-05 | `cache-read-path.e2e-spec.ts`: 20,000 keys, L1 entries ≤ 10,000 | — | — |
| AS-06 | `cache-read-path.e2e-spec.ts`: `undefined` and cyclic/BigInt loader results | — | — |
| AS-07 | `cache-read-path.e2e-spec.ts`: garbage bytes written through the real store | — | — |
| AS-08 | `cache-read-path.e2e-spec.ts`: 300 KiB value, nothing stored, log once | — | — |
| AS-09 | — | — | `cache-key.spec.ts` (`it.each` builder, escaping, validation table, tenant keys) |
| AS-10 | — | — | `cache-options.spec.ts` (`it.each` per invalid field) |
| AS-11 | `cache-read-path.e2e-spec.ts`: `getOrLoadMany`, one store read, one batch loader call, order, duplicates, >500 | — | — |
| AS-12 | `cache-stampede.e2e-spec.ts`: 200 concurrent misses | — | — |
| AS-13 | `cache-stampede.e2e-spec.ts`: three toolkit objects over one store, 300 reads | — | — |
| AS-14 | `cache-stampede.e2e-spec.ts`: lock expiry under a slow loader, owner-token release, follower budget | — | — |
| AS-15 | `cache-stampede.e2e-spec.ts`: rejecting loader, 50 waiters, in-flight table empty | — | — |
| AS-16 | `cache-stampede.e2e-spec.ts`: SWR at exp−1 / exp, one refresh across 3 instances, failing refresh | — | — |
| AS-17 | `cache-stampede.e2e-spec.ts`: clock at exp + swrMs | — | — |
| AS-18 | `cache-stampede.e2e-spec.ts`: stale-if-error window and beyond | — | — |
| AS-19 | — | — | `xfetch.spec.ts` (`it.each` over r, delta, now; r = 0; delta = 0; `fast-check` monotonic in r) |
| AS-20 | — | — | `xfetch.spec.ts` (`jitterTtl` bounds, spread, jitter 0, 1 s view; `fast-check` in range) |
| AS-21 | `cache-stampede.e2e-spec.ts`: FakeClock-driven 120 ms loader, envelope delta, duration histogram | — | — |
| AS-22 | `cache-penetration.e2e-spec.ts`: five reads, one load, TTL window, +12 s | — | — |
| AS-23 | `cache-penetration.e2e-spec.ts`: negative entry ignores SWR | — | — |
| AS-24 | `cache-penetration.e2e-spec.ts`: no `negativeTtlMs` | — | — |
| AS-25 | `cache-penetration.e2e-spec.ts`: invalidate replaces a negative entry | — | — |
| AS-26 | `cache-penetration.e2e-spec.ts`: 10,000 members, zero false negatives (`fast-check`), FPR ≤ 2 % on the real bitmap | — | — |
| AS-27 | — | — | `bloom-filter.spec.ts` (`it.each` (n, p) → bits, hashes; rejected inputs; 2³² cap) |
| AS-28 | `cache-penetration.e2e-spec.ts`: store refused through the fault proxy; idempotent add | — | — |
| AS-29 | `cache-invalidation.e2e-spec.ts`: two toolkit objects, broadcast, non-blocking delete | — | — |
| AS-30 | `cache-invalidation.e2e-spec.ts`: fault proxy refuse, no throw, L1 evicted | — | — |
| AS-31 | `cache-invalidation.e2e-spec.ts`: drop B's subscription, bypass, clear on restore | — | — |
| AS-32 | `cache-invalidation.e2e-spec.ts`: 5,000 keys with duplicates, round-trip count, empty array | — | — |
| AS-33 | `cache-invalidation.e2e-spec.ts`: versioned apply | — | — |
| AS-34 | `cache-invalidation.e2e-spec.ts`: duplicate delivery | — | — |
| AS-35 | `cache-invalidation.e2e-spec.ts`: out-of-order delivery | — | — |
| AS-36 | `cache-invalidation.e2e-spec.ts`: slow reader gated on a deferred promise | — | — |
| AS-37 | `cache-invalidation.e2e-spec.ts`: in-flight load, no entry | — | — |
| AS-38 | `cache-invalidation.e2e-spec.ts`: negative and unversioned entries | — | — |
| AS-39 | `cache-invalidation.e2e-spec.ts`: minimum retention, FakeClock +301 s, retention bounds | — | — |
| AS-40 | — | — | `cache-surface.spec.ts` (`expectTypeOf`: no `set` / `put` member) |
| AS-41 | — | — | `cache-options.spec.ts` (`it.each` invalid versions, shared with the AS-10 table) |
| AS-42 | `cache-degradation.e2e-spec.ts`: fault proxy refuse, 100 concurrent reads | — | — |
| AS-43 | `cache-degradation.e2e-spec.ts`: fault proxy hang, 250 ms and 50 ms | — | — |
| AS-44 | `cache-degradation.e2e-spec.ts`: breaker open / half-open / closed, gauge, one log per transition | — | — |
| AS-45 | `cache-degradation.e2e-spec.ts`: 500 distinct keys, loader concurrency ≤ 100, `CacheLoaderBusy` | — | — |
| AS-46 | `cache-degradation.e2e-spec.ts`: proxy restored, repopulates | — | — |
| AS-47 | `cache-degradation.e2e-spec.ts`: recompute lock fails open; `tryAcquire` rejects `LockUnavailable` | — | — |
| AS-48 | `cache-degradation.e2e-spec.ts`: L1 served within `l1TtlMs` while the store is down | — | — |
| AS-49 | `write-behind-counter.e2e-spec.ts`: two instances, 10,000 increments each | — | — |
| AS-50 | `write-behind-counter.e2e-spec.ts`: 20,000 increments racing a 5 ms drain loop | — | — |
| AS-51 | `write-behind-counter.e2e-spec.ts`: restore merges with new increments | — | — |
| AS-52 | `write-behind-counter.e2e-spec.ts`: claim, crash, FakeClock reclaim, commit twice, unknown id, release | — | — |
| AS-53 | — | — | `write-behind-counter.spec.ts` (`it.each` invalid `by`, member, counter name) |
| AS-54 | `write-behind-counter.e2e-spec.ts`: cap lowered to 50 members in the test module | — | — |
| AS-55 | `write-behind-counter.e2e-spec.ts`: two names, same member | — | — |
| AS-56 | `write-behind-counter.e2e-spec.ts`: fault proxy refuse, staged counts survive | — | — |
| AS-57 | `distributed-lock.e2e-spec.ts`: 20 concurrent `tryAcquire` | — | — |
| AS-58 | `distributed-lock.e2e-spec.ts`: expiry under holder A, B acquires, A.release false | — | — |
| AS-59 | `distributed-lock.e2e-spec.ts`: three instances, strictly increasing fences, `isNewerFence` | — | — |
| AS-60 | `distributed-lock.e2e-spec.ts`: extend before / after loss, `withLock` releases on throw | — | — |
| AS-61 | `distributed-lock.e2e-spec.ts`: wait until release; `LockTimeout` at 100 ms ± 50 | — | — |
| AS-62 | `distributed-lock.e2e-spec.ts`: fault proxy refuse | — | — |
| AS-63 | — | — | `cache-options.spec.ts` (`it.each` ttl and resource bounds, lock inputs) |
| AS-64 | `http-caching.e2e-spec.ts`: fixture controller behind the production pipeline; headers repeated on 304; version bump | — | — |
| AS-65 | — | — | `etag-match.spec.ts` (`it.each` header forms: list, weak, `*`, malformed) |
| AS-66 | `http-caching.e2e-spec.ts`: HEAD and unsafe methods | — | — |
| AS-67 | `http-caching.e2e-spec.ts`: tenant B with A's validator → 404/403/401/5xx, no ETag, never 304 (also `*` on a 404) | — | — |
| AS-68 | `http-caching.e2e-spec.ts`: `withEtag` verbatim; invalid validator omitted and counted | — | — |
| AS-69 | `http-caching.e2e-spec.ts`: no version, no id, streamed body | — | — |
| AS-70 | — | — | `cache-control.spec.ts` (`it.each` policies and rejected combinations) |
| AS-71 | `cache-operations.e2e-spec.ts`: scrape the metrics registry; label cardinality | — | — |
| AS-72 | `cache-operations.e2e-spec.ts`: captured log lines, marker string absent | — | — |
| AS-73 | `cache-operations.e2e-spec.ts`: `app.close()` with two refreshes in flight; no open handles | — | — |
| AS-74 | Proven by AS-02, AS-16, AS-17, AS-22, AS-39 (FakeClock only); plus an ESLint rule banning `Date.now` / `Math.random` in the cache lib (VII.1) | — | — |

## Scenario-to-file index

| E2E file | Scenarios |
|---|---|
| `cache-read-path.e2e-spec.ts` | AS-01–AS-08, AS-11 |
| `cache-stampede.e2e-spec.ts` | AS-12–AS-18, AS-21 |
| `cache-penetration.e2e-spec.ts` | AS-22–AS-26, AS-28 |
| `cache-invalidation.e2e-spec.ts` | AS-29–AS-39 |
| `cache-degradation.e2e-spec.ts` | AS-42–AS-48 |
| `write-behind-counter.e2e-spec.ts` | AS-49–AS-52, AS-54–AS-56 |
| `distributed-lock.e2e-spec.ts` | AS-57–AS-62 |
| `http-caching.e2e-spec.ts` | AS-64, AS-66–AS-69 |
| `cache-operations.e2e-spec.ts` | AS-71–AS-73 |

| Unit file | Scenarios |
|---|---|
| `cache-key.spec.ts` | AS-09 |
| `cache-options.spec.ts` | AS-10, AS-41, AS-63 |
| `xfetch.spec.ts` | AS-19, AS-20 |
| `bloom-filter.spec.ts` | AS-27 |
| `cache-surface.spec.ts` | AS-40 |
| `write-behind-counter.spec.ts` | AS-53 |
| `etag-match.spec.ts` | AS-65 |
| `cache-control.spec.ts` | AS-70 |

Product-level proofs that use the toolkit (S05 AS-27–AS-47, S18 AS-14–AS-17, S27 AS-26) stay in their capabilities' specs; they are not duplicated here.
