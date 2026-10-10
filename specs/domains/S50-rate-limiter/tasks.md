# Tasks: S50 — Distributed rate limiter (domain `infrastructure`)

**Input**: `plan.md`, `spec.md`, `test-plan.md`, `gaps.md`, `questions.md` (defaults accepted), `research.md`, `data-model.md`, `contracts/rate-limit.md`, `quickstart.md`.

**Tests**: required (test-plan.md, constitution VII). Test-first: in every phase the failing test task comes before the code task that makes it pass.

**Paths**: `RL` = `packages/backend/libs/infrastructure/rate-limit`. Backend commands run from `packages/backend`. e2e specs run through `/opt/sdd/repo/scripts/sdd/test-spec.sh <path>`; unit specs through `pnpm test libs/infrastructure/rate-limit`. Run the narrowest test that proves the change; the whole capability suite once, in the last phase. After 5 failed fixes of the same test, stop and write the blocker, what was tried and the hypothesis into `questions.md`.

**Rules for every task**: never use git checkout/restore/reset/stash/clean (undo by hand, keep other changes). No new `sequelize.transaction` (the lib owns no table and runs no SQL). Do not edit other capabilities' specs; cross-spec needs are already under `## Sibling-spec follow-ups` in `gaps.md` (add a bullet there if new work changes a name, header, status code or contract another spec relies on).

**Story map**: US1 token bucket · US2 sliding window · US3 concurrency · US4 local lease · US5 fail modes · US6 HTTP contract · US7 subjects · US8 failure-only counting · US9 penalties · US10 defaults, exemptions, registry · US11 observability · US12 edge worker · US13 fleet.

## Phase 1: Setup

- [X] T001 Run `pnpm --dir packages/backend check:boundaries` and `check:table-ownership --strict` and record the baseline for `infrastructure/rate-limit` (expected 0 table lines; D-17 cycle present) at the top of `specs/domains/S50-rate-limiter/research.md` under a "Baseline" heading (G debt register)
- [X] T002 Read `RL/rate-limit.*.ts`, `lua.ts`, `rate-limiter.service.ts`, `libs/common/core/clock`, `libs/common/resilience` (CircuitBreaker), `libs/common/telemetry` (MetricsRegistry), `infrastructure/platform/bootstrap-http.ts:72,184` and decide the R-06 question (reuse `CircuitBreaker` only if it supports N failures / open window / single probe; else local breaker in `RL/store-guard.ts`); note the decision in `research.md` R-06
- [X] T003 [P] Create `RL/rate-limit.metadata.ts` (the `RATE_LIMIT_METADATA` keys) and make `rate-limit.decorator.ts` and `rate-limit.interceptor.ts` import it instead of each other (D-17; check: `check:boundaries` shows no rate-limit cycle)

## Phase 2: Foundational (blocks every story)

**Pure code, unit tests first (time is an argument, never read)**

- [X] T004 [P] Write failing table-driven `RL/cost.spec.ts` (AS-07): positive integer only; HTTP normalization = `max(1, ceil(cost))`-style rule of FR-003 as written in spec.md; invalid cost throws `InvalidRateLimitCostError`
- [X] T005 [P] Write failing `RL/rate-limit-headers.spec.ts` (AS-82, G-04/G-05): `RateLimit-Policy: "<name>";q=<limit>;w=<s>`, `RateLimit: "<name>";r=<remaining>;t=<s>`, one item per non-concurrency policy in declaration order, `Retry-After` = largest denying wait and ≥ 1, rounding rules of AS-82
- [X] T006 [P] Write failing `RL/subject.spec.ts` (AS-51, AS-53, G-15): typed subjects `ip:|user:|key:|shop:<id>|email:<32 hex>|custom:`; e-mail = SHA-256 of trimmed lower-cased value truncated to 32 hex; non-string/undefined e-mail maps to the one fixed empty subject; custom value over 128 characters is replaced by its hash; absent value falls back to the address
- [X] T007 [P] Write failing `RL/policy-validation.spec.ts` (AS-69, G-02): name grammar `<area>.<name>[.<q>…]` in `[a-z0-9-]`; positive integer `limit`/`windowMs`; `localLeaseFraction` in `(0, 0.5]` and only for token bucket; `failMode` required (no default); `count: 'failures-only'` only with a key that can fail and `failureStatuses` ⊆ 4xx/5xx; `custom` key requires an extractor; all offences reported together
- [X] T008 [P] Write failing `RL/policy-keys.spec.ts` (AS-73, G-18): every key of one decision shares one hash tag `{<policy>|<subject>}`; layout `rl:{p|s}:tb`, `rl:{p|s}:sw:<index>`, `rl:{p|s}:cc`
- [X] T009 [P] Write failing `RL/fallback-limiter.spec.ts` (AS-29, G-26): capacity `max(1, floor(limit ÷ rate_limit_fallback_instances))`, charges `cost`, proportional refill, sliding-window policies use the same share, concurrency semaphore of `max(1, floor(limit ÷ instances))`, bound of 50,000 subjects with LRU eviction
- [X] T010 [P] Write compile-time `RL/policy-names.type-spec.ts` (AS-72): `@RateLimit('undeclared')` and `check('undeclared', …)` fail with `// @ts-expect-error`; declared names compile
- [X] T011 [P] Implement `RL/cost.ts` (G-10, G-23) to pass T004
- [X] T012 [P] Implement `RL/rate-limit-headers.ts` (G-04, G-05) to pass T005
- [X] T013 [P] Implement `RL/subject.ts` (G-14, G-15; address comes only from `req.clientIp`, no `cf-connecting-ip`) to pass T006
- [X] T014 [P] Implement `RL/policy-validation.ts` to pass T007
- [X] T015 [P] Implement `RL/policy-keys.ts` to pass T008
- [X] T016 [P] Implement `RL/fallback-limiter.ts` (replaces `in-memory-token-bucket.ts`; delete the old file; G-26) to pass T009
- [X] T017 Implement `RL/rate-limit.types.ts` (Policy, Subject, Decision `{ allowed, policy, limit, remaining, retryAfterMs: number|null, resetMs, source: 'store'|'local-lease'|'fallback', reason?: 'limit-exceeded'|'store-unavailable'|'cost-exceeds-limit'|'paused' }`; keep only `default.read` 300/min and `default.write` 60/min, `userOrIp`, fail open, no lease) and `RL/policy.ts` (`definePolicies(owner, table)` with `satisfies`, name union by module augmentation `PolicyNameRegistry`) to pass T010 (G-01, P0113)
- [X] T018 Implement `RL/rate-limit.errors.ts`: `Domain_RateLimitedError` (429, `code: 'rate_limited'`, `retryAfterSeconds`, generic detail), `Domain_RateLimiterUnavailableError` (503, `rate_limiter_unavailable`), `Domain_RateLimitCostExceededError` (422, `rate_limit_cost_exceeded`), `InvalidRateLimitCostError`, `InvalidPenaltyError`, `UnsupportedPenaltyError`, all extending `AppError` (G-07)
- [X] T019 Implement `RL/rate-limit.config.ts` and edit `libs/common/config/api-config.service.ts` and `types.ts`: add `rate_limit_store_timeout_ms` (200), `rate_limit_breaker_failures` (3), `rate_limit_breaker_open_ms` (2000), `rate_limit_fallback_instances` (4), `rate_limit_lease_ttl_ms` (1000), `rate_limit_penalty_max_ms` (3,600,000), validated at startup (FR-055, G-26/27/28/32); the `throttle_api_*` keys are removed later in T053
- [X] T020 Write `RL/time-source.ts`: `TimeSource` port, `StoreTimeSource` (Redis `TIME`, the production default) and an injectable test source (FR-010, G-24); plus `RL/script-loader.ts`: load once, call by digest, one reload on NOSCRIPT without counting a failure (FR-012, G-22)
- [X] T021 Create the test scaffolding in `RL/test/`: probe controller module (test code only) with `GET /probe/token`, `POST /probe/login`, `POST /probe/slow`, `POST /probe/idempotent`, `GET /probe/shop/:shopId`, `GET /probe/plain`, `GET /probe/exempt`; app bootstrap with the production pipe, filter, prefix and interceptors on the real test Redis; helpers using `test/fakes/tcp-fault-proxy.ts` (outage), `CLIENT PAUSE` (timeout), `SCRIPT FLUSH`, store-time source + `FakeClock`; a helper to read stored keys and TTLs. No import of any domain module (G-38a)

**Checkpoint**: `pnpm test libs/infrastructure/rate-limit` green; `pnpm exec tsc --noEmit` green.

## Phase 3: US1 — Token bucket (P1)

**Goal**: bursts allowed, average bounded, exact under concurrency. **Independent test**: `token-bucket.e2e-spec.ts` green.

- [X] T022 [US1] Write failing `RL/token-bucket.e2e-spec.ts` against the real service and store: AS-01 (burst 10, 50 parallel → exactly 10), AS-02 (one token per interval, retry delay in (0, 6000]), AS-03 (idle never above capacity), AS-04 (subjects/policies independent), AS-05 (weighted cost; denial consumes nothing), AS-08 (bounded expiry `ceil(limit/rate)` + 1 s, every key has a TTL), AS-83 (lowering or raising the policy clamps state)
- [X] T023 [US1] Write the token-bucket script in `RL/lua.ts` on the store clock: refill, take `cost`, `cost > capacity` guard returning permanent denial (G-19), expiry per data-model, `paused_until` field read (used by US9); capacity clamp on read
- [X] T024 [US1] Implement `RL/rate-limiter.service.ts` `check(policy, subject, cost = 1)` for token bucket through `script-loader` and `time-source`, returning the new Decision shape with `reason`, `retryAfterMs` (0 when allowed, `null` for `cost-exceeds-limit`) (G-23); make T022 pass

## Phase 4: US2 — Sliding window (P1)

**Goal**: smooth exact window on the store clock. **Independent test**: `sliding-window.e2e-spec.ts` green.

- [X] T025 [US2] Write failing `RL/sliding-window.e2e-spec.ts`: AS-09 (5 per 15 min, sequence of six), AS-10 (200 parallel against 100 → exactly 100), AS-11 (none admitted in first second of a window beyond the weighted estimate), AS-12 (previous window weighs 50% → 5 admitted), AS-13 (admitted at R, denied at R−1 with the injected store time), AS-14 (two service instances with skewed application clocks share one budget; 2 s expiry check = 2 × windowMs)
- [X] T026 [US2] Write the sliding-window script in `RL/lua.ts`: window index and elapsed from the store clock inside the atomic step, both keys from the one hash-tagged base, exact `retryAfterMs`, `cost` handling (G-18); extend `check` for `slidingWindow`; make T025 pass

## Phase 5: US3 — Concurrency limiter (P1)

**Goal**: at most N in-flight, crashed holders recover. **Independent test**: `concurrency-limit.e2e-spec.ts` green.

- [X] T027 [US3] Write failing `RL/concurrency-limit.e2e-spec.ts`: AS-15, AS-16 (20 parallel on limit 2 → exactly 2), AS-17 (crashed holder frees at lease expiry using the injected time), AS-18 (double and stale release harmless; release frees only its own id), AS-19 (retry hint = earliest lease expiry clamped 1–5 s), AS-20 (route lease released on success, 500, 422 and client abort, via `POST /probe/slow`)
- [X] T028 [US3] Write the concurrency script in `RL/lua.ts` (prune expired, count, add, expiry 2 × lease) and an idempotent id-scoped release; implement `acquire(policy, subject)` returning `{ acquired, release, decision }` (never `null`; outage distinguishable from "limit reached") (G-25, G-09); make the service parts of T027 pass

## Phase 6: US4 — Local leased budget (P2)

**Goal**: hot key costs few store calls. **Independent test**: `local-lease.e2e-spec.ts` green.

- [X] T029 [US4] Write failing `RL/local-lease.e2e-spec.ts`: AS-21 (hot key: ≤ 60 and ≥ 54 allowed, ≤ 40 store calls — count calls with Redis `INFO commandstats`/a command counter, not a mock), AS-22 (lease expires after `rate_limit_lease_ttl_ms`; unspent tokens dropped), AS-23 (two instances, one hot key: 48–60 allowed), AS-24 (no lease for cost > 1, fraction 0, other algorithms), AS-25 (denial memo `min(retryAfterMs, 1 s)`, then store again) (G-32)
- [X] T030 [US4] Implement `RL/local-lease.ts`: slice `max(1, floor(limit × fraction))`, adds to existing lease never overwrites, single-flight refill per key, lifetime from `rate_limit_lease_ttl_ms`, denial memo, `drop(key)`; wire into `check` for token bucket cost 1 with a fraction only; make T029 pass

## Phase 7: US5 — Fail modes, breaker, timeout (P1)

**Goal**: outage handled as each owner declared. **Independent test**: `fail-modes.e2e-spec.ts` green.

- [X] T031 [US5] Write failing `RL/fail-modes.e2e-spec.ts` (outage via TcpFaultProxy, timeout via `CLIENT PAUSE`, lost scripts via `SCRIPT FLUSH`; no mock of the project's store client): AS-26 (closed → 503, handler not run), AS-27 (open → served, counter +1, no headers), AS-28 (fallback wiring: 15 served then 429), AS-30 (3 failures, 2 s zero store calls, one probe), AS-31 (timeout → failure path within timeout + 100 ms, no retry), AS-32 (recovery continues from stored counters), AS-33 (lost scripts reloaded transparently), AS-34 (concurrency: closed 503; open semaphore of 1), AS-35 (code callers get `reason: 'store-unavailable'`, no throw), AS-36 (extractor/cost resolver throws → fail mode, never raw 500)
- [X] T032 [US5] Implement `RL/store-guard.ts`: per-call timeout `rate_limit_store_timeout_ms`, no retry in a decision (G-27), breaker with configurable failures/open window and single probe (G-28), breaker state gauge hook, one log line per transition, never the driver text (G-29)
- [X] T033 [US5] Extend `RL/rate-limiter.service.ts`: route every store call through `store-guard`; fail closed → `allowed:false`, `reason:'store-unavailable'`, `retryAfterMs:1000`; fail open → `fallback-limiter` (token bucket, sliding window, concurrency, charging cost); `fallback` source (G-08, G-26, G-31); helper errors follow the fail mode (G-30); make T031 pass
- [X] T034 [US5] Remove the `RedisThrottlerStorage` fail-open catch path (the file itself is deleted in T051, after `core.module` and `sse-gateway.module` stop importing it; G-31)

## Phase 8: US6 — HTTP contract (P1)

**Goal**: same standard answer on every route. **Independent test**: `rate-limit-http.e2e-spec.ts` green.

- [X] T035 [US6] Write failing `RL/rate-limit-http.e2e-spec.ts` (production pipe/filter/prefix; assert response and stored state): AS-06 (422 `rate_limit_cost_exceeded`, no `Retry-After`), AS-37 (429 problem+json with all FR-029 fields, `Retry-After`, `RateLimit*`, `Cache-Control: no-store`, handler not run, no policy/subject in body), AS-38 (success headers; remaining decrements), AS-39 (two policies listed, larger `Retry-After`), AS-40 (later policy denial refunds earlier token-bucket, sliding-window and concurrency units), AS-41 (429 before 400; under limit 400 costs one unit), AS-42 (401 consumes no budget), AS-43 (stranger cannot spend another shop's budget), AS-44 (throttled request has no side effect), AS-45 (handler error responses keep headers), AS-46 (OPTIONS not counted), AS-47 (replays consume budget; response carries `Idempotency-Replayed`, not `Idempotent-Replayed`; exposed by CORS). Also assert (S52 follow-up) that 429, 503 and write responses carry no body-hash `ETag` and are never answered 304, and that `app.set('etag', false)` remains in `bootstrap-http.ts`
- [X] T036 [US6] Implement `refund(policy, subject, units = 1)` in `RL/lua.ts` (token bucket: add up to capacity; sliding window: decrement current key ≥ 0; idempotent, creates nothing for unknown subjects) and in the service (G-06)
- [X] T037 [US6] Rewrite `RL/rate-limit.decorator.ts`: `@RateLimit(...(name | { policy, cost?, subject?, failureStatuses? }))` option-object form and `@RateLimitExempt(reason)` (G-10)
- [X] T038 [US6] Rewrite `RL/rate-limit.interceptor.ts`: skip `OPTIONS` (G-12); resolve subject via `subject.ts`; resolve cost safely; decide policies in declaration order; on a later denial refund/release earlier units (G-06); set headers on allowed, denied and handler-error paths (G-05, FR-030); `Retry-After` = max denying wait; `Cache-Control: no-store` on 429/503; throw `Domain_*` errors with generic detail (G-07); release leases on success, error and abort via `finalize` (G-11); helper errors follow the fail mode (G-30). Make T035 pass
- [X] T039 [US6] Verify and, if needed, fix registration order so guards → rate-limit interceptors → pipes → idempotency interceptor (route-scoped, after the global ones) in `apps/core/src/core.module.ts` and `RL/rate-limit.module.ts` (G-13)
- [X] T040 [US6] Rename every `Idempotent-Replayed` to `Idempotency-Replayed` everywhere it occurs (S50 code, other owners' code, CORS exposure lists, test helpers) under `packages/` and `apps/`; it is a header string, not a spec contract (S54 follow-up); `grep -rn "Idempotent-Replayed" packages apps` must return nothing

## Phase 9: US7 — Subjects and privacy (P1)

**Goal**: right budget owner, no secrets in keys. **Independent test**: `rate-limit-subjects.e2e-spec.ts` green.

- [X] T041 [US7] Write failing `RL/rate-limit-subjects.e2e-spec.ts`: AS-48 (rotating `X-Forwarded-For`/`cf-connecting-ip` do not bypass), AS-49 (user, key, shop isolation), AS-50 (missing identity → address subject, `rate_limit_subject_fallback_total` +1), AS-52 (no secret or e-mail in any key; every key has a TTL — scan with `SCAN` of `rl:*` only in the test) (G-16)
- [X] T042 [US7] Wire `subject.ts` into the interceptor and service (`shop:<id>` typed subject, `user` vs `userOrIp` distinct, `apiKey` from `request.apiKey.id`, `custom` source, address fallback with counter) and make T041 pass (G-14, G-15)

## Phase 10: US8 — Failure-only counting (P1)

**Goal**: only failed attempts count, parallel guesses cannot slip. **Independent test**: `failure-counting.e2e-spec.ts` green.

- [X] T043 [US8] Write failing `RL/failure-counting.e2e-spec.ts` via `POST /probe/login`: AS-54 (6th attempt with correct credential is 429), AS-55 (success clears counter), AS-56 (20 parallel wrong attempts on limit 5 → exactly 5 reach the handler), AS-57 (only `failureStatuses` keep the slot; others refund), AS-58 (shared counter across code paths with `refund` and `reset`), AS-59 (`reset`/`refund` on empty state, bounds, creates nothing)
- [X] T044 [US8] Implement reset script and `reset(policy, subject)` in `RL/lua.ts` and the service (deletes the subject's items, no `SCAN`/`KEYS`), and the failures-only outcome handling in the interceptor `tap` (reserve at admission, keep on `failureStatuses` default 401/403, clear on 2xx with `resetOnSuccess`, refund otherwise) (G-17, G-11); make T043 pass

## Phase 11: US9 — Penalties (P2)

**Goal**: a provider's "slow down" honoured by every worker. **Independent test**: `penalize.e2e-spec.ts` green.

- [X] T045 [US9] Write failing `RL/penalize.e2e-spec.ts`: AS-60 (`penalize` pauses every instance; other subjects unaffected), AS-61 (monotonic, capped at `rate_limit_penalty_max_ms`, invalid values throw `InvalidPenaltyError`), AS-62 (returns `false` when store down, never throws), AS-63 (`UnsupportedPenaltyError` on sliding window and concurrency), AS-64 (lease dropped locally; others stop within 1 s), AS-65 (no burst after the pause)
- [X] T046 [US9] Implement the penalty script (empty bucket, set `paused_until` monotonically, expiry until + 1 s) in `RL/lua.ts`, pause check in the token-bucket script (`reason:'paused'`, `retryAfterMs` = remaining pause), and `penalize(policy, subject, ms)` in the service with local lease drop and `rate_limit_penalties_total` (G-20); make T045 pass

## Phase 12: US10 — Defaults, exemptions, registry (P1)

**Goal**: every route limited, exempt or explicitly policed; one limiter. **Independent test**: `rate-limit-registry.e2e-spec.ts` green.

- [X] T047 [US10] Write failing `RL/rate-limit-registry.e2e-spec.ts`: AS-66 (default `default.read`/`default.write` on undeclared routes), AS-67 (explicit policy replaces the default), AS-68 (exempt route unlimited; blank reason fails boot; exempt list logged once), AS-70 (duplicate policy name fails boot naming both modules), AS-71 (undeclared policy on a route fails boot)
- [X] T048 [US10] Implement `RL/policy-registry.ts` (validates whole tables with `policy-validation`, duplicates naming both owners, undeclared references, exempt list) and move today's central table out of the lib into the domains that own the policies (constitution X.3; no `legacy` table in infrastructure): each domain adds a small `rate-limit-policies.ts` with `definePolicies('<domain>', {...})` registered by `RateLimitModule.forFeature(...)`, names and numbers unchanged, then delete `RATE_LIMIT_POLICIES` from `rate-limit.types.ts`. Owners: identity `auth.login.ip`, `auth.login.account`; catalog `search.query`; orders `checkout.create`; developer-platform `public-api.default`; catalog-sync `imports.concurrent`, `integrations.shopify`; statements `exports.concurrent`; auctions `auction.bid`; community `discussion.write`, `discussion.vote`; notifications `notify.email`, `notify.sms`, `notify.push`; launch-events `live.comment`, `live.reaction`; assistant `llm.messages`, `rag.ask`, `llm.provider.tpm`. Other domains using `search.query` or `discussion.write` keep referencing the name (G-35 follow-ups). Update `assistant-quota.service.ts` to stop reading the central table (G-01, G-02)
- [X] T049 [US10] Implement `RL/default-rate-limit.interceptor.ts` (APP_INTERCEPTOR; `default.read` for safe methods else `default.write`, `userOrIp`, fail open, skip routes with `@RateLimit` or `@RateLimitExempt`) and `RL/rate-limit.module.ts` with `forRoot()` (service, registry, default interceptor, config) and `forFeature(table)`, global (G-03, G-33); make T047 pass
- [X] T050 [US10] Add `RL/index.ts` barrel exporting only: service, decorators, `RateLimitModule`, `definePolicies`, errors, types, `RateLimitDecision` (FR-056, G-21); migrate the five deep imports to the barrel: `assistant/application/answer.service.ts`, `assistant-quota.service.ts`, `catalog-sync/application/integration-sync.service.ts`, `catalog-import.service.ts`, `notifications/infra/notification-workers.service.ts`, adapting them to `acquire`'s new result and the new Decision fields (`source` values, `reason`)
- [X] T051 [US10] Remove the second limiter: delete `ThrottlerModule`/`ThrottlerGuard`/`RedisThrottlerStorage` from `apps/core/src/core.module.ts`, `apps/sse-gateway/src/sse-gateway.module.ts`, `test/utils/global-modules.ts`; import `RateLimitModule.forRoot()` in these and in `apps/public-api/src/public-api-app.module.ts` and the worker apps (G-33); delete `RL/redis-throttler.storage.ts` (closes T034)
- [X] T052 [US10] Remove `throttle` and `skipThrottle` from `libs/domains/identity/api/decorators/firewall.decorator.ts` and migrate each site listed in G-34 to the default, an explicit existing policy (declared by its owning domain, T048), or `@RateLimitExempt(<reason>)` (Stripe webhook: `@RateLimitExempt('payment provider webhook, signature-verified')`); remove `@nestjs/throttler` imports from the repo
- [X] T053 [US10] Remove config keys `throttle_api_limit`/`throttle_api_ttl` from `libs/common/config/api-config.service.ts` and `types.ts`; `grep -rn "@nestjs/throttler\|throttle_api_\|skipThrottle\|SkipThrottle" packages apps` returns nothing (G-33)
- [X] T054 [US10] Replace uses of mis-used policies only where removing the central table forces it; otherwise leave the call sites and rely on the sibling follow-ups already listed in `gaps.md` for G-35 (record in `gaps.md` which sites were left, no spec edits)
- [X] T055 [US10] Run the app suites that lost the throttler once (`apps/core`, `apps/sse-gateway`, domain e2e that asserted a global 429) via `test-spec.sh`; fix breakage caused by this change; list any failure with a different cause in `questions.md`

## Phase 13: US11 — Observability (P2)

**Goal**: operators can see what the limiter does. **Independent test**: `rate-limit-observability.e2e-spec.ts` green.

- [X] T056 [US11] Write failing `RL/rate-limit-observability.e2e-spec.ts`: AS-74 (metrics for every path: store, local-lease, fallback, store-unavailable, subject fallback, penalty, breaker gauge, duration histogram), AS-75 (one log line per breaker transition; denial logs sampled to one per policy per second, with `requestId`, no subject, no e-mail, no driver text)
- [X] T057 [US11] Implement `RL/rate-limit.metrics.ts`: `rate_limit_decisions_total{policy,allowed,source,reason}`, `rate_limit_check_duration_seconds`, `rate_limit_store_unavailable_total`, `rate_limit_breaker_state`, `rate_limit_subject_fallback_total`, `rate_limit_penalties_total`, sampled redacted denial log; wire into service, guard and interceptor (G-36, G-29); make T056 pass

## Phase 14: US13 — Fleet guarantee (P1)

**Goal**: exact guarantee across instances. **Independent test**: `rate-limit-fleet.e2e-spec.ts` green.

- [X] T058 [US13] Write `RL/rate-limit-fleet.e2e-spec.ts` with two Nest apps on the same Redis: AS-80 (200 parallel against limit 100 → exactly 100), AS-81 (concurrency 2 → exactly 2); run it and fix any defect it exposes in the service/scripts (SC-001, SC-009)

## Phase 15: US12 — Edge worker (P2)

**Goal**: the edge stops floods with the same answer shape. **Independent test**: `packages/edge-be/src/rate-limit.spec.ts` green (`cd packages/edge-be && pnpm test`).

- [X] T059 [US12] Write failing `packages/edge-be/src/rate-limit.spec.ts` driving the worker `fetch` handler against a fake edge store: AS-76 (window boundary: at most limit + 2 in the second after it; one atomic store call per decision), AS-77 (429 problem+json with `Retry-After`, `RateLimit-Policy`, `RateLimit`, `Cache-Control: no-store`), AS-78 (fail open on slow or down store, 500 ms timeout, counted and logged), AS-79 (subject: verified user id, else CDN connecting address, else `anonymous`)
- [X] T060 [US12] Edit `packages/edge-be/src/index.ts`: script returns allowed, remaining and reset; one `rateLimitResponse()` helper replacing the two duplicated blocks (`:336`, `:401`); count and log the fail-open path; subject choice per FR-058 (G-37); make T059 pass

## Phase 16: Polish and cross-cutting

- [X] T061 Delete the old `RL/rate-limit.e2e-spec.ts` (mocked store client, imports `AuthApiModule`) once T022–T058 are green (G-38)
- [X] T062 [P] Update `scripts/load-tests/ratelimit.test.js` for the new headers and the 503 path; add the 1/2/4-instance run and the store-call ratio (G-39). Do not claim it was run
- [X] T063 Confirm the S52 follow-up: `app.set('etag', false)` still present next to `disable('x-powered-by')` in `infrastructure/platform/bootstrap-http.ts`; add nothing else there; note in `gaps.md` that handlers needing ETags use `VersionEtagInterceptor`/`withEtag`
- [X] T064 Confirm `quickstart.md` "Ops artifacts" lists SC-001 (4 instances), SC-002, SC-003, SC-007 and that `specs/UNVERIFIED.md` has exactly one "not run" row for each of them (already present: keep, never mark verified); add a row for any further criterion that no test proves
- [X] T065 [P] Confirm the `## Sibling-spec follow-ups` section in `gaps.md` still matches what shipped (acquire result shape, header format, 503/422, `Idempotency-Replayed`, `penalize`, policy declarations); add bullets for any new contract change
- [X] T066 Run static gates: `pnpm exec tsc --noEmit` and ESLint for `packages/backend` and `packages/edge-be`; `pnpm check:boundaries` (no rate-limit cycle); `pnpm check:table-ownership --strict` (0 lines for `infrastructure/rate-limit`); grep confirms no `sequelize.transaction` added in the lib; paste results in the report (G debt register)
- [X] T067 Update pattern-map rows P0113, P0214, P0327, P0416 from `implemented` to `verified` and SD-28's implementation notes (new header format, throttler removed), only after T068 is green (G-40)
- [X] T068 Run the whole capability suite once: `/opt/sdd/repo/scripts/sdd/test-spec.sh libs/infrastructure/rate-limit`, `pnpm test libs/infrastructure/rate-limit` and `(cd packages/edge-be && pnpm test)`; report results faithfully

## Dependencies and execution order

- Phase 1 → Phase 2 (blocks all stories). T017 needs T010; T020/T021 block every e2e task.
- US1 (T022–T024) first: it creates `check` and the Lua file. US2 and US3 extend the same files (`lua.ts`, service): run sequentially in file terms, tests can be written in parallel.
- US4 depends on US1; US5 depends on US1–US3 (fallback covers all algorithms); US6 depends on US1–US3 and US5; US7, US8, US9 depend on US6; US10 depends on US6 (T049 needs the interceptor) and must finish before T061; US11 after US5/US6; US13 after US2/US3; US12 is independent of the backend and can run in parallel after Phase 1.
- Within each phase: the test task precedes its code task.

## Parallel opportunities

- T004–T010 (unit specs) all [P]; then T011–T016 [P]. T003 [P] with Phase 2 start.
- After Phase 2: US12 (T059–T060) in parallel with US1–US6. Test-writing tasks T025, T027, T029 can be drafted while T024 lands.
- T062, T065 [P] in Polish.

## Implementation strategy

- **MVP**: Phase 1–2, US1, US5, US6 and US10 (one limiter, standard answer, fail modes, throttler removed); this is the smallest set that lets the throttler be deleted safely.
- Then US2, US3, US8 (needed by S01/S02), US7, US9, US4, US11, US13, US12.
- Gaps coverage: G-01–03 T017/T048/T049; G-04/05 T012/T038; G-06 T036/T038; G-07 T018/T038; G-08 T033; G-09 T028; G-10 T011/T037; G-11 T038/T044; G-12 T038; G-13 T039; G-14/15 T013/T042; G-16 T041; G-17 T044; G-18/19 T015/T023/T026; G-20 T046; G-21 T050; G-22 T020; G-23 T011/T024; G-24 T020; G-25 T028; G-26–32 T019/T030/T032/T033; G-33 T049/T051/T053; G-34 T052; G-35 T054; G-36 T057; G-37 T060; G-38 T021/T061; G-39 T062; G-40 T067.
