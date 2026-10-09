# Implementation Plan: S50 — Distributed rate limiter (domain `infrastructure`)

**Branch**: `S50-rate-limiter` | **Date**: 2026-10-09 | **Spec**: [spec.md](spec.md)

**Input**: `spec.md` (FR-001–058, AS-01–83, SC-001–009), `test-plan.md`, `gaps.md` (G-01–G-40, debt register, policy declarations), `questions.md` (defaults accepted as written), and the two follow-ups from the run prompt.

## Summary

Rework `packages/backend/libs/infrastructure/rate-limit/` (962 lines, one 6-test e2e that mocks the store client) into the engine the spec describes, and bring `packages/edge-be` to the same contract. The decision path becomes: pure policy/subject/cost/header/key code → store scripts (token bucket, sliding window, concurrency, penalty, failure-only refund/reset) that read the **store clock** and are called by digest → a service with timeout, breaker, fail modes, in-process fallback, lease and denial memo → an interceptor that implements the IETF header contract, refund on a later denial, failures-only outcome handling and release on abort. The central domain-named policy table is replaced by `definePolicies` + `forFeature` and a startup-validating registry; the fixed-window `@nestjs/throttler` second limiter, its store, its config keys and the `Firewall({ throttle, skipThrottle })` options are deleted in favour of a `default.read`/`default.write` interceptor and `@RateLimitExempt(reason)`. The lib owns no table, runs no SQL and opens no transaction (rule 4: nothing to migrate, no `sequelize.transaction` added).

## Technical Context

**Language/Version**: TypeScript strict, NestJS, repo-pinned Node; Lua (store scripts)

**Primary Dependencies**: `ioredis` through `RedisService.client`; `Clock`/`FakeClock` (`@app/common/core/clock`); `MetricsRegistry` (`@app/common/telemetry`); `CircuitBreaker` (`@app/common/resilience`) only if its semantics match FR-022, else a 30-line breaker local to the lib (research R-06); `resolveClientIp`/`req.clientIp` from `infrastructure/platform`; `AppError` + S54 filter; `fast-check` not needed. Removed: `@nestjs/throttler` use in apps and lib.

**Storage**: the shared Redis only, keys under `rl:`; no database table.

**Testing**: Jest e2e against the real test Redis with `TcpFaultProxy` (`test/fakes/tcp-fault-proxy.ts`) for outages, `CLIENT PAUSE` for timeouts, `SCRIPT FLUSH` for lost scripts, an injectable store-time source plus `FakeClock`; table-driven unit specs for pure logic; edge worker spec against a fake edge store. Run through `scripts/sdd/test-spec.sh`.

**Target Platform**: Linux server, N instances; single Redis node or Cluster (one hash tag per decision, FR-013).

**Project Type**: backend infrastructure library + Cloudflare worker; HTTP surface is interceptors on other routes (test-only probe controller module).

**Performance Goals**: lease-served decision < 1 ms p99; one store round trip otherwise; ≤ 10 % store calls on hot keys (SC-002, SC-005).

**Constraints**: store timeout 200 ms, no retry inside a decision, breaker 3 failures / 2 s, fallback bounded to 50,000 subjects, every stored item has an expiry.

**Scale/Scope**: 40 gap items, 83 scenarios, 13 e2e files + 7 unit files, ~25 `skipThrottle` sites, 5 deep-import callers.

No `NEEDS CLARIFICATION` remains (see [research.md](research.md)).

## Constitution Check

| Rule | Status |
|---|---|
| I, X.3, X.5 infrastructure imports no domain, names no domain | **Pass after G-01/G-38** except the transitional `legacy-policies.ts` (Complexity Tracking). The old e2e's `AuthApiModule` import goes. |
| III, IX no table, SQL or transaction | Pass. No `InjectModel`, `.query(`, `sequelize.transaction` in the lib; `check:table-ownership --strict` must print 0 lines for `infrastructure/rate-limit`. T-count in domain unchanged. |
| IV communication | Pass. Callers use the new barrel `@app/infrastructure/rate-limit` (G-21); no events; the store call has a timeout (IV.6) and no retry inside a decision. |
| V errors | `Domain_RateLimitedError` 429, `Domain_RateLimiterUnavailableError` 503, `Domain_RateLimitCostExceededError` 422 extend `AppError`; the S54 filter renders `code`, `retryAfterSeconds`; `detail` generic and without policy/subject (FR-029). |
| II request pipeline | Interceptors run after guards, before pipes, before the idempotency interceptor (G-13). The guard-level throttler is deleted. |
| VII testing | Every AS has one `test-plan.md` row; real Redis, no mock of the project's store client (VII.2); every degradation path forced (VII.9); `403/401/IDOR/429/concurrency/idempotency` cases map to HTTP/SUBJ/FONLY/FLEET. Unverified SC rows go to `UNVERIFIED.md`. |
| VIII operations | Config keys validated at startup (FR-055); logs structured, `requestId`, no driver text, no subject; one breaker log per transition; sampled denial logs. |
| X.4 public entry | New `index.ts` barrel exporting only the Provides list; five deep imports migrate. |
| Debt register | **D-17** (decorator ↔ interceptor cycle) fixed by `rate-limit.metadata.ts`. D-1/2/3 resolved; D-14/16 not ours; D-6/8 satisfied by the barrel. |
| Follow-up (S52) | `app.set('etag', false)` in `bootstrap-http.ts:184` is **kept**; HTTP e2e asserts a `429`/`503`/write response carries no body-hash `ETag` and is never turned into `304`; S50 handlers never rely on automatic ETags. |
| Follow-up (S54) | The replay header is `Idempotency-Replayed`: AS-47 and Requires (7) in `spec.md` are updated (done); bootstrap already exposes it (`bootstrap-http.ts:72`); HTTP e2e AS-47 asserts the new name. |

Post-design re-check: no new violation beyond the one tracked below.

## Project Structure

### Documentation

```text
specs/domains/S50-rate-limiter/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/rate-limit.md
└── tasks.md   # /speckit-tasks, not created here
```

### Source code (`packages/backend/libs/infrastructure/rate-limit/`)

```text
index.ts                    public barrel = spec "Provides" (G-21, FR-056)
rate-limit.metadata.ts      RATE_LIMIT_METADATA keys; breaks the D-17 cycle
rate-limit.types.ts         policy/decision types, default.read/default.write only (G-01)
policy.ts                   definePolicies, name-union augmentation point (P0113, AS-72)
policy-validation.ts        pure validator, reports all offences (G-02, AS-69)
policy-registry.ts          runtime registry: forFeature tables, duplicates, undeclared refs (AS-70/71)
legacy-policies.ts          TRANSITIONAL: today's central table, declared as owner "legacy"; deleted with the last owner (G-01)
rate-limit.config.ts        six rate_limit_* keys + validation (FR-055, G-26/27/28/32)
rate-limit.errors.ts        three Domain_* errors, InvalidRateLimitCostError, InvalidPenaltyError, UnsupportedPenaltyError
cost.ts                     cost validation (code) and HTTP normalization (AS-07)
subject.ts                  typed subjects, e-mail hash, custom >128 hash (G-15)
policy-keys.ts              one hash-tagged base per decision (AS-73)
rate-limit-headers.ts       RateLimit / RateLimit-Policy / Retry-After formatter (AS-82)
time-source.ts              TimeSource port; StoreTimeSource (TIME) and test source (G-24)
lua.ts                      scripts: token bucket, sliding window, concurrency, penalty, refund, reset
script-loader.ts            load once, call by digest, one reload on NOSCRIPT (G-22)
store-guard.ts              timeout, breaker, metrics of availability (G-27, G-28, G-29)
fallback-limiter.ts         was in-memory-token-bucket.ts; cost-aware, sliding/concurrency, 50,000 LRU (G-26)
local-lease.ts              lease slices, single-flight refill, denial memo (G-32)
rate-limiter.service.ts     check/acquire/refund/reset/penalize
rate-limit.metrics.ts       the six metrics and sampled denial log (G-36)
rate-limit.decorator.ts     @RateLimit(...) option objects, @RateLimitExempt(reason)
rate-limit.interceptor.ts   @RateLimit interceptor: order, refund, outcome, abort, OPTIONS
default-rate-limit.interceptor.ts  APP_INTERCEPTOR applying default.read/default.write (G-33)
rate-limit.module.ts        forRoot(), forFeature(table); global
test/                       probe controller module, fault helpers (test code only)
```

Deleted: `redis-throttler.storage.ts`, `in-memory-token-bucket.ts` (renamed), the old `rate-limit.e2e-spec.ts` (replaced by 13 files).

Outside the lib:

- `apps/core/src/core.module.ts`, `apps/sse-gateway/src/sse-gateway.module.ts`, `test/utils/global-modules.ts`: remove `ThrottlerModule`, `ThrottlerGuard`, `RedisThrottlerStorage`; import `RateLimitModule.forRoot()`. `apps/public-api` and the worker apps import `forRoot()` too.
- `libs/common/config/api-config.service.ts` and `types.ts`: drop `throttle_api_limit`/`throttle_api_ttl`; add the six `rate_limit_*` keys.
- `libs/domains/identity/api/decorators/firewall.decorator.ts`: remove `throttle`/`skipThrottle` options; ~25 controller sites migrate to default, explicit policy or `@RateLimitExempt` (G-34 list).
- Five deep-import callers migrate to the barrel (G-21); mis-used policies (G-35) are noted in sibling follow-ups, not rewritten here beyond what the removal of the central table forces.
- `packages/edge-be/src/index.ts` + new `rate-limit.spec.ts` (G-37).
- `scripts/load-tests/ratelimit.test.js` (G-39); pattern map rows P0113, P0214, P0327, P0416 and SD-28 notes (G-40) only after the suite is green.

**Structure Decision**: keep the single existing lib directory; split by responsibility so the pure files (policy, validation, cost, subject, keys, headers, fallback) are unit-testable with time as an argument, and the stateful files (scripts, service, lease, guard) are covered only by e2e against real Redis.

## Phases and ordering (maps to gaps "Suggested order")

1. **Pure code**: `rate-limit.metadata.ts`, types, `definePolicies`, validator, cost, subject, keys, header formatter, fallback limiter + unit specs (AS-07, 29, 51, 53, 69, 72, 73, 82).
2. **Time source and scripts**: TB, SW (store clock, exact retry), CONC, PEN, refund/reset; digest loading; TB/SW/CONC/PEN/FONLY e2e.
3. **Service**: timeout, breaker, fail modes and reasons, denial memo, lease, `acquire` result shape, helper-error handling; LEASE/FAIL/OBS e2e.
4. **Interceptor and default**: headers, refund on later denial, failures-only, OPTIONS, order versus idempotency, abort release; delete throttler, `Firewall` options, config keys; HTTP/SUBJ/REG e2e; the `etag` and `Idempotency-Replayed` assertions.
5. **Owners**: transitional `legacy-policies.ts` keeps today's policies working; callers move to the barrel; owners' own tables are sibling follow-ups.
6. **Edge, load script, gates**: EDGE spec, k6 update, `tsc`, ESLint, `check:boundaries`, `check:table-ownership --strict`, pattern map; whole capability suite once.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| `legacy-policies.ts` names domain policies (checkout, auction, chat, LLM, notify…) inside infrastructure (X.3) | ~25 live call sites use these names today; owners' specs land one by one (gaps step 5) | Moving every table now edits ~15 domains this capability does not own and breaks their suites; deleting it now breaks callers. The file is declared as owner `legacy`, validated like any table, and removed with the last owner; a test fails if it grows. |
