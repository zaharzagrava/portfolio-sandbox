# Implementation Plan: S52 — Cache Toolkit (domain `infrastructure`)

**Branch**: `S52-cache-toolkit` | **Date**: 2026-10-09 | **Spec**: [spec.md](spec.md)

**Input**: `spec.md`, `test-plan.md`, `gaps.md` (A1–A28, debt B, ownership C), `questions.md` (defaults accepted as written).

## Summary

Rebuild `packages/backend/libs/infrastructure/cache/` (nine files, 524 lines) into the toolkit the spec describes. The read path is rewritten around three injected seams (Clock, random source, store guard). New parts: versioned invalidation, degradation (timeout, breaker, bulkhead), batch read, crash-safe counters, `DistributedLock` with fences, and an RFC 9110 ETag interceptor. Every multi-step store operation is one Lua script, so atomicity never depends on client ordering. The lib owns no table, runs no SQL and opens no transaction (rule 4: nothing to migrate, no `sequelize.transaction` added).

## Technical Context

**Language/Version**: TypeScript (strict), NestJS, the repo's pinned Node

**Primary Dependencies**: `ioredis` (via `RedisService.client`), `lru-cache` (add `maxSize` + `sizeCalculation`), `MetricsRegistry` (`@app/common/telemetry/metrics-registry`), `Clock`/`FakeClock` (`@app/common/core/clock`), `ShutdownRegistry`, `CircuitBreaker` (`@app/common/resilience`), `fast-check` (dev)

**Storage**: Redis only (entries, minimum records, recompute locks, counters, fence counters, Bloom bitmaps). No database table.

**Testing**: Jest e2e against real Redis (`docker-compose.test.yaml`) with `TcpFaultProxy` (`test/fakes/tcp-fault-proxy.ts`) and `FakeClock`; table-driven unit specs for pure logic; run via `scripts/sdd/test-spec.sh`.

**Target Platform**: Linux server, multi-instance; single node or Redis Cluster (hash-tagged keys)

**Project Type**: backend infrastructure library (no HTTP surface; a test-only fixture module supplies routes)

**Performance Goals**: cache layer < 5 ms p99 over the store round trip (SC-009); one store round trip per `getOrLoadMany`; ≤ 10 per 5,000-key invalidation

**Constraints**: 250 ms default store timeout; 256 KiB entry cap; L1 10,000 entries / 64 MiB; every in-process table bounded or empty when idle

**Scale/Scope**: 28 gaps, 74 acceptance scenarios, about 25 `invalidate` call sites

No `NEEDS CLARIFICATION` remains (see [research.md](research.md)).

## Constitution Check

| Rule | Status |
|---|---|
| I, X.5 infrastructure imports no domain | Pass after A26: the old e2e stops importing `@app/domains/catalog` and seeds; a test-only fixture module replaces it. |
| III, IX no table, SQL or transaction | Pass. `check:table-ownership` finds nothing (gaps C); no `sequelize.transaction` in the lib, none added. |
| IV communication | Pass. Domains use `@app/infrastructure/cache`; S52 publishes no event and owns no consumer; no cross-domain data. |
| V errors | Nine typed error classes extending `AppError`; `CacheLoaderBusy` and `LockTimeout` map to 503 + `Retry-After` via the S54 filter. |
| VII testing | Every AS has its `test-plan.md` row; real Redis, no store mock (VII.2); every degradation path forced (VII.9); whole suite once at the end. |
| VIII operations | Metrics per AS-71, logs with namespace and digest only, startup config validation, shutdown order 80. |
| X.4 public entry | New barrel `libs/infrastructure/cache/index.ts` (`@app/infrastructure/cache`). |
| Debt register | No open row names S52; D-1/D-2/D-3 residue is A26. |

Post-design re-check: unchanged, no violations, so no Complexity Tracking entry.

## Project Structure

### Documentation

```text
specs/domains/S52-cache-toolkit/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/cache-toolkit.md
└── tasks.md   # /speckit-tasks, not created here
```

### Source code (`packages/backend/libs/infrastructure/cache/`)

```text
index.ts                 public barrel (the names in spec "Provides")
cache.module.ts          global; config provider, CacheService, DistributedLock, interceptor
cache.config.ts          CacheToolkitConfig + validation rules                      (A28)
cache.errors.ts          the nine error classes
cache-key.ts             cacheKey(), validateKey(), hash tag, digest                (A14)
cache-options.ts         option and version validation                              (A13, FR-008, FR-023)
entry-codec.ts           envelope encode/parse, size cap, JSON check                (A10-A12)
cache-scripts.ts         Lua: guarded store, invalidate-if-older, lock release, claim, fence
cache.service.ts         getOrLoad, getOrLoadMany, invalidate, invalidateIfOlder
l1-cache.ts              LRU by count and bytes, health gate, clear                 (A15)
broadcast.ts             subscriber with error/reconnect handling                   (A15)
store-guard.ts           per-call timeout + circuit breaker                         (A16)
loader-bulkhead.ts       cap 100, FIFO queue, 2 s wait, CacheLoaderBusy             (A16)
single-flight.ts         kept; idle-empty assertion                                 (A25)
xfetch.ts, hot-key-detector.ts   injected clock and random; detector fix           (A17, A20)
refresh-tracker.ts       tracked background refreshes, awaited on shutdown          (A18)
cache-metrics.ts, cache-log.ts   AS-71 metrics; digest logs, rate-limited          (A9, A19)
bloom-filter.ts          validation, fail-open mightContain                         (A21)
write-behind-counter.ts  validation, cap, claim/commit/release/reclaimExpired       (A22)
distributed-lock.ts      tryAcquire/acquire/withLock/extend, fence                  (A23)
etag.interceptor.ts, etag-match.ts, cache-control.ts   RFC 9110, withEtag           (A24)
testing/cache-fixture.module.ts   test-only module with ETag routes, no domain      (A26)
*.spec.ts, *.e2e-spec.ts          exactly the files in test-plan.md                 (A27)
```

**Structure Decision**: keep the single lib, one file per concern so each is unit-testable, all Lua in one file so atomicity rules are reviewed together. `cache.e2e-spec.ts` is replaced by the nine feature e2e files; its seven scenarios are ported, not dropped.

## Work order (gaps.md section D; tests first at each step)

1. **Seams and fixtures (A26, A28, A17)**: validated `cache.config.ts`; inject `CLOCK` and a `RandomSource`; extend the ESLint `no-restricted-syntax` rule (already bans `Date.now`) to `Math.random` for `libs/infrastructure/cache/**`; fixture module; remove the domain imports from the old e2e.
2. **Contracts (A10–A14, A25)**: `cache-key`, `cache-options`, `entry-codec`, errors. Unit specs `cache-key`, `cache-options`, `cache-surface` first.
3. **Stampede (A4–A8, A25)**: random owner token; release by compare-and-delete script; every refresh path (miss, stale, XFetch) takes the lock; followers poll on the injected clock with jitter up to 500 ms then load; a failed lock `SET` fails open (never marks acquired); negative entries have hard = soft and are never served stale.
4. **Invalidation (A2, A3, A15)**: `invalidate` (dedupe, chunks, `UNLINK`, never throws, L1 evict, `{l2, deleted}`); `invalidateIfOlder` and the guarded store as scripts over entry + minimum; `versionOf`; broadcast health, bypass while unhealthy, clear on reconnect.
5. **Degradation and ops (A16, A18, A19, A9)**: `store-guard`, `loader-bulkhead`, `refresh-tracker` with 5 s shutdown await, digest logs (10 s / 60 s limits), AS-71 metrics.
6. **Remaining components (A1, A20–A24)**: `getOrLoadMany`; detector rolls on the clock and evicts when full; Bloom validation and fail-open; counters; `DistributedLock`; ETag interceptor, `matchesIfNoneMatch`, `withEtag`, `buildCacheControl`.
7. **Coverage (A27)**: remaining specs from `test-plan.md`; whole cache suite against real Redis once; then `tsc`, ESLint, `check:boundaries`.

## Cross-spec handling

- **`invalidate` now returns `{l2, deleted}`**: the two callers typed `Promise<void>` (`tenancy/application/membership.service.ts:28`, `billing/application/entitlements.service.ts:44`) stop compiling. S52 does not edit their specs; it makes the smallest code change that keeps the build green (`await` instead of `return`, behaviour unchanged) and records it under *Sibling-spec follow-ups* in `gaps.md`.
- **Shared store client**: S52 does not wait for `infrastructure/redis` to grow a timeout; the 250 ms bound lives in `store-guard`. It needs `unlink`, `eval`, `publish` (already on the ioredis client) and builds its own subscriber connection as today.
- **Unverified criteria**: SC-004, SC-005, SC-008, SC-009 have no automated proof; they go under *Ops artifacts* in `quickstart.md` and as rows in `specs/UNVERIFIED.md`. SC-001/002/003/006/007 are proven by AS-12/13, 42/43, 29–38, 49–52, 64–69.
- **Transactions**: none in this lib; nothing to migrate.

## Complexity Tracking

None.
