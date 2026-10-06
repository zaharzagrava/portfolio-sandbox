# Gaps: S52 — current `infrastructure/cache` code versus the spec

The implementation agent's to-do list. Paths are under `packages/backend/libs/infrastructure/cache/` unless stated; line numbers are those read on 2026-10-06. All of the lib is nine files (524 lines): `cache.service.ts`, `cache.module.ts`, `single-flight.ts`, `xfetch.ts`, `hot-key-detector.ts`, `bloom-filter.ts`, `write-behind-counter.ts`, `etag.interceptor.ts`, `cache.e2e-spec.ts`. **Check not run:** `pnpm check:table-ownership` tried to install dependencies and failed (`isolated-vm` needs `node-gyp`), so section C is reasoned from the script (`packages/backend/scripts/check-table-ownership.ts`) and from reading every file of the lib.

## A. Code versus spec

| # | Gap | Where | Spec |
|---|---|---|---|
| A1 | No `getOrLoadMany`; S05's batch read would be N+1 | (missing) | FR-009, AS-11 |
| A2 | No versioned entries, no `invalidateIfOlder`, no per-key minimum version; a slow reader can resurrect an old value for a full TTL | `cache.service.ts:136-151` (`refresh` writes unconditionally) | FR-021–FR-023, AS-33–AS-41 |
| A3 | `invalidate` throws on store failure, returns `void`, uses `DEL`, publishes one message per key (one round trip each), no dedupe | `cache.service.ts:109-114` | FR-019, AS-29, AS-30, AS-32 |
| A4 | Lock release is an unconditional `DEL`; lock value is `'1'`, so an owner cannot be told apart | `cache.service.ts:119-126` | FR-012, AS-14 |
| A5 | Background refresh (stale and XFetch) takes only the per-instance flight, not the cross-instance lock: N instances refresh at expiry | `cache.service.ts:96-99` | FR-012, FR-014, AS-16, AS-19 |
| A6 | Lock follower returns the stored value without checking it is an envelope or fresh, and polls 20 × 25 ms with a fixed `sleep` (not clock-driven, no jitter); falls back to computing on timeout without lock | `cache.service.ts:128-134` | FR-012, AS-14 |
| A7 | `.catch(() => 'OK')` on the lock `SET` treats a failed lock as acquired and `refresh` then runs un-guarded for all callers | `cache.service.ts:119` | FR-027, AS-47 |
| A8 | Negative entries get `hard = exp + swrMs`, are served stale, and share the positive TTL path | `cache.service.ts:141-146`, `:94-99` | FR-017, AS-23 |
| A9 | `null` from a stored negative entry is counted as outcome `l2`; a loader `null` as `miss`; no `negative`, `degraded`, `corrupt`, `oversize`, `stale_error` outcomes; no `namespace` label; no loader counter or histogram | `cache.service.ts:56,86,100-105,157-160` | FR-042, AS-71 |
| A10 | `JSON.parse` failure on a corrupt entry falls into the "Redis down" branch (loader without repair) | `cache.service.ts:87-93` | FR-005, AS-07 |
| A11 | Loader `undefined` / non-JSON values: `JSON.stringify` runs after the loader, `undefined` yields no envelope value | `cache.service.ts:140-149` | FR-005, AS-06 |
| A12 | No entry size cap, no `maxEntryBytes` | `cache.service.ts:147-151` | FR-006, AS-08 |
| A13 | No option validation (`ttlMs`, `negativeTtlMs!`, `l1TtlMs`, `jitter` has no per-call option at all), no `staleIfErrorMs`, no `timeoutMs`, no `versionOf` | `cache.service.ts:27-35`, `:143` | FR-008, FR-015, FR-016, AS-10, AS-18 |
| A14 | No key validation or tenant-safe builder; `{`/`}`/`:` in a part are unescaped | `cache.service.ts:70-71` (any string accepted) | FR-007, AS-09 |
| A15 | L1 is bounded by count only (`max: 10_000`), no byte bound; L1 is used even if the subscription died; subscriber has no `error`/`reconnect` handling and L1 is not cleared on reconnect | `cache.service.ts:50`, `:63-68` | FR-003, FR-004, AS-05, AS-31 |
| A16 | No store call timeout (only ioredis `maxRetriesPerRequest`), no circuit breaker, no loader bulkhead | `cache.service.ts:84-93`, `redis/redis.service.ts:24-31` | FR-024–FR-026, AS-42–AS-45 |
| A17 | Expiry uses `Date.now()`; hot-key detector and XFetch default to `Date.now`/`Math.random`; no `Clock` injection, so e2e cannot freeze time (`waitFor` and real sleeps used instead) | `cache.service.ts:76,137-144`; `hot-key-detector.ts:17-18`; `xfetch.ts:14,21` | FR-045, AS-74 |
| A18 | Shutdown closes only the subscriber; background refresh promises are fire-and-forget and untracked | `cache.service.ts:70-72,98` | FR-044, AS-73 |
| A19 | Logs: `L2 read failed for ${key}` and `L2 write failed for ${key}` print the full key; no digest, no per-window rate limit on warnings | `cache.service.ts:90,150` | FR-043, AS-72 |
| A20 | Hot-key detector `maxTracked` stops counting new keys when full (new hot keys can never be detected while old noise fills the window) and rolls only on access | `hot-key-detector.ts:25-29,35-39` | FR-003, AS-04 |
| A21 | Bloom filter: no validation of `n`, `p`, 2³² bit cap; `mightContain` rejects when the store fails; `add` has no batch size bound; digest read per call is fine but `Number(...)` of a BigInt `% m` should assert `< 2³²` | `bloom-filter.ts:17-24,36-45` | FR-018, AS-26–AS-28 |
| A22 | Write-behind: no `increment` validation (`by = 0`, `1.5`, `NaN`), no member or counter-name rules, no pending-member cap, no `claim`/`commit`/`release`/`reclaimExpired` (a crash between `drain` and the database write loses the counts), no gauge | `write-behind-counter.ts:18-46` | FR-028–FR-031, AS-49–AS-56 |
| A23 | No distributed lock with fencing token anywhere (P0326): launch-events, assistant, community, fulfilment each hand-roll `SET NX PX`; none checks owner on release or issues a fence | (missing) ; call sites `domains/launch-events/application/seat-hold.service.ts:63`, `domains/assistant/application/assistant.service.ts:118`, `domains/community/application/vote.service.ts:34`, `domains/fulfilment/application/dispatch.service.ts:104` | FR-033–FR-035, AS-57–AS-63 |
| A24 | ETag interceptor: string equality on `If-None-Match` (no list, weak, `*`), `'r'` fallback id, applies to every method and status, drops handler headers on 304, no `withEtag`, no `Cache-Control` builder | `etag.interceptor.ts:11-28` | FR-036–FR-041, AS-64–AS-70 |
| A25 | `SingleFlight.size()` exists but nothing asserts the table is empty when idle; no rejection sharing test | `single-flight.ts:6-19` | FR-011, AS-15 |
| A26 | The existing e2e spec imports a domain (`ProductModule` from `@app/domains/catalog`) and seeds (`SeedsModule`, `TableName`): an infrastructure lib importing a domain (X.5) in test code; it also tests `GET /api/products/:id`, which is S05's | `cache.e2e-spec.ts:9-14,20-23,119-150` | X.5, test-plan.md (fixture module) |
| A27 | The spec's AS-01–AS-74 have no tests except the seven in the current e2e (stampede, cross-instance, SWR, negative, invalidate, counter) | `cache.e2e-spec.ts` | test-plan.md |
| A28 | `cache.module.ts` imports `ApiConfigModule` but declares no validated toolkit configuration (limits, timeouts, breaker) | `cache.module.ts:6-11` | FR-008 |

Callers to update for the BREAKING lines of `questions.md` (read-only list; the capabilities that own them pay their share):

- `invalidate` now resolves `{l2, deleted}` instead of `void`; two callers `return` it and are typed `Promise<void>`: `domains/tenancy/application/membership.service.ts:28`, `domains/billing/application/entitlements.service.ts:44`. The other 18 call sites `await` it and need no change (`catalog/infra/product-cache-invalidator.projector.ts:22`, `identity/application/auth-session.service.ts:126`, `tenancy/application/shop.service.ts:49`, `experimentation/application/analytics.service.ts:122`, `developer-platform/api/api-keys.controller.ts:68`, `developer-platform/application/widget.service.ts:68`, `developer-platform/application/webhook-endpoints.service.ts:51,74,86,92,132,140,149`, `notifications/application/suppression.service.ts:43`, `notifications/application/preferences.service.ts:73,100,110,119`, `marketing/application/share-link.service.ts:90`).
- Counter names in use (`product-views`, `vote-deltas`) already satisfy the new name rule. `catalog/infra/product-views.jobs.ts:45-57` uses `drain`/`restore` (kept); moving it to `claim`/`commit` is S05's job (S05 AS-65–AS-74).
- Keys in use (`auth:user:v1:<id>`, `experiments:running`, `launch-event:v1:<id>`, `api:pinned:<shop>`, `product:v1:<id>`) satisfy the key rules; the helper-built keys (`membershipCacheKey`, `recipientKey`, `entitlementsKey`, `siteKey`, `endpointKey`, `shopEndpointsKey`, `linkCacheKey`) must be checked by the implementation, and parts that can contain `:` or `{` move to `cacheKey()`.
- `domains/experimentation/application/analytics.service.ts:` `getOrLoad('experiments:running', () => this.sequelize.query(...))` runs SQL inside the loader; that SQL belongs to S39 (not a toolkit concern).

## B. Debt register (`docs/architecture/debt-register.md`)

Open rows that name `infrastructure` or S52, and what S52 does about each:

| ID | Row | Relation to S52 | Mechanism |
|---|---|---|---|
| D-14 | LLM provider port lives in `assistant/infra/llm`; to move to `libs/infrastructure/llm` | Names `infrastructure`; resolved by S46 and S04, not S52 | none for S52 |
| D-16 | `libs/infrastructure/elasticsearch` is a product-index adapter, not a generic client | Names `infrastructure`; resolved by S32 | none for S52 |
| D-17 | File-level cycles inside one lib: rate-limit decorator ↔ interceptor (and domain models) | Names `infrastructure/rate-limit`; resolved by S50 | none for S52; S52 adds no cycle (the interceptor does not import the decorator and vice versa) |
| D-1, D-2, D-3 | Infrastructure importing domain or legacy code, generic types, topic names | Resolved in Phase 3; the only residue in S52's lib is test code (A26) | Replace the domain import in `cache.e2e-spec.ts` with a test-only fixture module (no domain, no seeds) |
| D-7, D-12 | Cross-domain model imports and raw SQL | They concern `libs/domains/*`; `libs/infrastructure/cache` imports no model and runs no SQL | n/a (see C) |
| D-6, D-8, D-10, D-11, D-13, D-15 | Domain-level layering, barrels, queue ownership, cycles | Do not name `infrastructure` or S52 | n/a |

No open row names S52. The one open S52-adjacent constitutional item is A26 (X.5 in test code), covered above.

## C. `pnpm check:table-ownership` lines for this domain

The script (`scripts/check-table-ownership.ts`) walks `libs/domains` only, so it prints no line for `libs/infrastructure/cache`. Reading the nine files: no model import, no `@InjectModel`, no `Sequelize` instance, no SQL string, no table name. The lib owns no table (it is not on the IX.3 allowlist and must not be added). Result: **0 findings, nothing to replace.**

Three consumers cache another domain's data or loop single reads; they are not S52's to fix, but the IX.7 mechanism that replaces each one uses S52's Provides:

| Consumer | Today | Replacement (IX.7) |
|---|---|---|
| `experimentation/application/analytics.service.ts` (S39) | `getOrLoad` around a raw query over its own tables | none needed (own tables); keeps `invalidate` with broadcast |
| `catalog` (S05) batch read | looped single reads | **R1**: `getOrLoadMany` for the cache layer, the owning domain's `getProductsByIds` exported service for other domains; the BFF composes by **R2** over HTTP |
| entitlements (S18), authorization (S03) | per-domain caches of another domain's data | **R1** exported service + `invalidateIfOlder` driven by the owner's events (**R3** read model only where the consumer must filter or sort) |

## D. Order of work (suggested)

1. A26, A28, A17: fixture module, configuration, injected clock and random (everything else is tested through them).
2. A10, A11, A12, A13, A14: value, option and key contracts (pure, unit-tested first).
3. A4–A8, A25: single-flight, lock ownership, background refresh lock, negative entries.
4. A2, A3, A15: invalidation, minimum versions, broadcast health.
5. A16, A18, A19, A9: degradation, shutdown, logs, metrics.
6. A1, A20–A24: batch read, hot-key fix, Bloom, counters, lock service, ETag and `Cache-Control`.
7. A27: remaining scenarios from `test-plan.md`; run the whole cache suite green against real Redis before merging (VII.9).
