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

## Sibling-spec follow-ups

- **S18**: `billing/application/entitlements.service.ts:44` returns `invalidate(...)` from a `Promise<void>` method, and `invalidate` now resolves `{l2, deleted}`. S52 changes that line to `await` (behaviour unchanged). S18 decides whether to act on `l2: 'failed'` and adopts `invalidateIfOlder` with `versionOf`.
- **Tenancy owner** (`tenancy/application/membership.service.ts:28`): same `return` in a `Promise<void>` method; S52 changes it to `await`. The owner reads `l2` if a failed delete must be retried.
- **S05**: move the views flush from `drain`/`restore` to `claim`/`commit` with an apply that is idempotent by `batchId`; use `getOrLoadMany` for the batch read and `invalidateIfOlder` for versioned invalidation.
- **S11**: use `getOrLoad` with `jitter` and drop the local promise-coalescing map.
- **S22, S49**: may adopt `DistributedLock` (with fence) in place of the hand-rolled `SET NX PX` at `launch-events/application/seat-hold.service.ts:63`, `assistant/application/assistant.service.ts:118`, `community/application/vote.service.ts:34`, `fulfilment/application/dispatch.service.ts:104`; protected writes compare `fence`.
- **S27**: pass `withEtag(body, '"<id>-v<version>-<locale>"')` and use `buildCacheControl`; the interceptor now keeps handler headers on `304`.
- **S28, S44**: pass `l1: 'never'` for preference, suppression and site records.
- **Domains with helper-built keys** (`membershipCacheKey`, `recipientKey`, `entitlementsKey`, `siteKey`, `endpointKey`, `shopEndpointsKey`, `linkCacheKey`): keys need a `:` namespace and no `{`, `}` or whitespace in parts; parts that can contain `:` move to `cacheKey()`.
- **Dashboards and tests reading `cache_requests_total`**: the counter gains a `namespace` label and new outcomes (`negative`, `degraded`, `corrupt`, `oversize`, `stale_error`, `refused_*`, `refresh_failed`).

### Added while implementing (T035, T055, T060)

- **S05**: (a) the old `cache.e2e-spec.ts` is deleted (it imported `ProductModule` and seeds, A26). Its `GET /api/products/:id` test (ETag `W/"<id>-v<version>"`, `304` on `If-None-Match`, the unknown id negatively cached, the view counted) has no replacement in the toolkit; S05's own e2e must cover it. (b) The pending hash of a write-behind counter is now `counter:{<name>}:pending` (was `wb:{<name>}`); counts staged under the old name at deploy time are not read by the new code (analytics-grade, at most one flush interval). (c) `VersionEtagInterceptor` now needs `id` (string) and `version` (non-negative integer) in the body; the old shared `'r'` id is gone.
- **S50 / S54 (HTTP bootstrap, `infrastructure/platform/bootstrap-http.ts`)**: S52 added `app.set('etag', false)` next to `disable('x-powered-by')`. Without it Express puts a body-hash `ETag` on errors and on write responses and answers `304` itself, which breaks AS-67 and AS-69. The owner should keep the line and may document it in the bootstrap spec. Handlers that relied on Express' automatic weak ETag now need `VersionEtagInterceptor` or `withEtag` (no handler in the repo did: `content/stories.controller` sets its own).
- **Callers whose options or keys would have thrown at runtime** (changed here, minimal edits, owners to confirm): `l1TtlMs` above the 5,000 ms cap lowered to 5,000 in `seller-insights/application/leaderboard.service.ts` (was 60,000), `tenancy/infra/tenant-connection.resolver.ts` (30,000), `experimentation/application/analytics.service.ts` (10,000), `discovery/application/trending.service.ts` (10,000), `developer-platform/application/widget.service.ts` (10,000) and `developer-platform/api/public-api.interceptor.ts` (30,000). Keys with caller-controlled parts now use `cacheKey()`: `trending:v1:view:<category>:<minutes>` (public query value, was `trending:view:…`), `notif-supp:v1:<channel>:<address>` (was `notif:supp:…`), `widget-site:v1:<publishableKey>` (was `widget:site:…`; an empty key now answers 404 before any lookup). The helper-built keys `membershipCacheKey`, `recipientKey`, `entitlementsKey`, `endpointKey`, `shopEndpointsKey`, `linkCacheKey` and the literals (`auth:user:v1:<sub>`, `experiments:running`, `launch-event:v1:<id>`, `api:pinned:<shop>`, `product:v1:<id>`) take ids that are UUIDs, JWT subjects or pre-validated codes and are valid as they are.
- **Domains using `l1: 'always'`** (widget, public API, tenant resolver, analytics, trending): L1 is now used only while the invalidation subscription is healthy and is cleared on reconnect; the effective staleness bound is `l1TtlMs` (at most 5 s) plus the time to notice a lost subscription.

### Decisions where the tasks left room (for the reviewer)

- **Own circuit breaker, not `CircuitBreaker` (R-03 changed).** `store-guard.ts` has a small O(1) breaker (5 consecutive failures within 10 s → open 5 s → one probe). The shared `CircuitBreaker` keeps and re-filters every outcome of its window on each call (O(n²) at the call rate of a cache read; the 20,000-key spec took 115 s with it). `cache_breaker_state` follows the spec (0 closed, 1 open, 2 half-open), which differs from the shared breaker's own `circuit_breaker_state` gauge.
- **The minimum-version record is `<version>:<until>`** with `until` on the injected clock, so AS-39 and AS-74 can be proven by moving the clock; the store's own expiry only cleans up.
- **`invalidateIfOlder` throws `CacheUnavailable`** when the store cannot be reached (its callers are event consumers that retry). Only `invalidate` swallows store failure, as the spec says.
- **`getOrLoadMany` takes no cross-instance recompute lock**; it shares in-flight loads inside the process (FR-009) and relies on the batch loader being one statement. Single-key `getOrLoad` keeps the lock.
- **A call that times out is not cancelled.** The 250 ms bound abandons the wait; a command already written to the socket can still run (and ioredis may re-send an unanswered command after a reconnect). For `WriteBehindCounter.drain` that means a timed-out drain can remove counts the caller never saw; `claim`/`commit` is the crash-safe path and returns the batch after the claim age.
- **Keys given to the toolkit may not contain `{` or `}`** (a brace would move the entry's auxiliary records to another shard); the spec's validation list did not name braces, T055 and FR-020 imply it.
- **Unit specs (`*.spec.ts`) run with `pnpm test <path>`**; `scripts/sdd/test-spec.sh` uses `jest-e2e.json`, whose regex only matches `*.e2e-spec.ts`.
- **Red/green, stated plainly.** Watched fail before the code: `cache-options`, `entry-codec`, `cache-surface`, the config rules, the read-path e2e (against the old service), `bloom-filter`, `write-behind-counter` (unit and e2e), the lock input rules and `distributed-lock`, `etag-match`, `cache-control`, the versioned-invalidation cases of AS-39 and SC-003, and the HTTP cases that exposed Express' automatic ETag and `304`. Written *after* the code they test, so they were green on first run: `cache-key.spec` (the module existed first), `xfetch.spec` (the maths was already right; only the `Math.random` defaults were removed), and the stampede, penetration (cache part), invalidation (AS-29–AS-38), degradation and operations e2e files, because the stampede, negative-entry, invalidation and fail-open code was written in one pass with `cache.service.ts`. To check those are not vacuous, the lock release was mutated to an unconditional `DEL` and AS-14 failed as it should. The other specs were not mutation-checked.
- `pnpm check:table-ownership` ran: no finding for `libs/infrastructure/cache` (87 findings elsewhere, none new). `pnpm check:boundaries`: 0 errors. `tsc --noEmit` and ESLint on the lib: clean.
- **Not run here:** the domain e2e suites of notifications (Cassandra table `inbox_by_user` missing) and experimentation (ClickHouse `ORDER BY` DDL error) fail in this environment for reasons unrelated to the cache; billing, tenancy, widget, public API, webhooks, auth, share links, product, discovery and seller-insights pass.

## Gate repairs

- **AS-74** had no test carrying its ID (test-plan.md says it is proven by AS-02/16/17/22/39 plus the lint rule). Added `clock-injection.spec.ts` (`S52 AS-74: ...`), which fails if any production file in the cache lib calls `Date.now()` or `Math.random()` (only `random-source.ts` is exempt), mirroring the ESLint rule.
- `check-tests.py integrity` reported `cache.e2e-spec.ts: test file deleted`. The deletion was reverted: the file is restored from HEAD (all 8 tests kept). One assertion follows the documented key rename in data-model.md: the product-views pending hash is read from `counter:{product-views}:pending` instead of `wb:{product-views}` (same check, new key). The S05 note under Sibling-spec follow-ups saying this file is deleted no longer applies; S05 still owns the product-route behaviour.
