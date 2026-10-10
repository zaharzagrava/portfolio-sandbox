# Research: S50 — Distributed rate limiter

Each item resolves a design choice; no `NEEDS CLARIFICATION` remains. Facts about the repo were checked in the code on 2026-10-09.

## Baseline

Recorded when the work finished (T001 was not captured before the first edit, so there is no "before" number): `pnpm check:boundaries` → 0 errors, 61 warnings, none naming `infrastructure/rate-limit` (the decorator ↔ interceptor cycle D-17 is gone: both import `rate-limit.metadata.ts`); `pnpm check:table-ownership --strict` → 0 lines for `infrastructure/rate-limit`; `grep -rn "sequelize.transaction" libs/infrastructure/rate-limit` → nothing (the lib owns no table and runs no SQL).

## R-01 Time source

- **Decision**: a `TimeSource` port. Production = the store's `TIME`, read **inside every script** (`redis.call('TIME')`) so the decision and the clock are one atomic step. The test source supplies an offset the script adds to `TIME` (passed as an argument, `0` in production).
- **Rationale**: FR-010 forbids instance clocks in a decision; an argument offset keeps scripts deterministic enough for replication-safe effects (Redis ≥ 5 replicates effects) and lets tests move time without sleeps (AS-02, 11–13, 17, 19).
- **Alternatives**: `Date.now()` passed in (today; skew between instances, AS-14); `redis.call('TIME')` only with real sleeps (slow, flaky).

## R-02 Sliding window

- **Decision**: window index and elapsed time computed in the script from store time; both window keys derive from one hash-tagged base `rl:{<policy>|<subject>}:sw:<index>`. The script returns the exact `retryAfterMs`: the smallest `d` such that `prev × (1 − (e+d)/w) + cur + 1 ≤ limit` (closed form, clamped to `[1, remaining window + w]`), verified by AS-13 (admit at R, deny at R−1).
- **Rationale**: FR-004/005/010/013. **Alternatives**: sorted-set log (exact but O(n) memory per subject, rejected for hot keys).

## R-03 Failure-only counting

- **Decision**: reserve at admission with the normal decision; after the handler the interceptor keeps the slot on `failureStatuses`, calls `reset` on `2xx` when `resetOnSuccess`, else `refund`. Scripts: `refund(units)` clamps at capacity (token bucket) or zero (sliding window current key); `reset` deletes the subject's keys. Both are no-ops for unknown subjects (no key creation).
- **Rationale**: FR-040–042; reservation is what stops 20 parallel guesses passing a pre-check (AS-56). **Alternatives**: pre-check then increment (race); lock per subject (extra round trips).

## R-04 Refund of earlier policies (AS-40)

- **Decision**: the interceptor records each admitted policy's taken units and, on a later denial, calls `refund` (bucket, window) or `release` (concurrency) for each, best effort and in parallel. A refund failure is logged once per transition and never changes the response.
- **Rationale**: FR-026. **Alternative**: evaluate all policies in one multi-key script (would need cross-policy hash tags, breaking FR-013).

## R-05 Penalty / pause

- **Decision**: fields on the token-bucket hash: `paused_until` (store ms). The decision script returns `reason: 'paused'` with `retryAfterMs = paused_until − now`. `penalize` sets tokens to 0, `paused_until = max(existing, now + min(ms, cap))`, last-refill = `paused_until` so the bucket refills from empty (AS-65). Expiry = pause + 1 s (FR-011). The calling instance drops its lease; others stop when their lease (≤ 1 s) expires (AS-64).
- **Alternatives**: separate pause key (second key, still same tag, but more round trips and expiry bookkeeping).

## R-06 Breaker

- **Decision (confirmed at T002)**: a small lib-local consecutive-failure breaker (`store-guard.ts`; closed → open until T → one probe → closed), 3 failures / 2 s from config, gauge `rate_limit_breaker_state`, one log line per transition. `CircuitBreaker` (`libs/common/resilience/circuit-breaker.ts`) was read: it opens on a failure **rate** over a rolling window with `minimumCalls`, and admits `halfOpenCalls` trial calls, so it cannot give "3 in a row, then exactly one probe".
- **Rationale**: `libs/common/resilience` `CircuitBreaker` is failure-**rate** based over a rolling window with `minimumCalls`; FR-022 and AS-30 need "3 consecutive failures, 2 s of zero store calls, exactly one probe". **Alternative**: configure the shared breaker to approximate it (`minimumCalls: 3`, threshold 1): the semantics differ under mixed outcomes and fail AS-30's exactness.

## R-07 Store timeout and script loading

- **Decision**: every store call races a timer of `rate_limit_store_timeout_ms` (200 ms); a timed-out call is a failure, no retry. `script-loader` runs `SCRIPT LOAD` once per script at first use (and after reconnect), calls `EVALSHA`, and on `NOSCRIPT` reloads and retries once without counting a failure (AS-33).
- **Rationale**: FR-012, FR-019; `RedisService` already sets `enableOfflineQueue: false`, so a down store fails fast. **Alternative**: ioredis `defineCommand` (hides the reload; harder to prove AS-33).

## R-08 Fail open fallback

- **Decision**: `fallback-limiter.ts` is a pure class taking time as an argument: token bucket of `max(1, floor(limit / instances))`, refilling at the policy rate share, charging `cost`, LRU of 50,000 subjects (Map-based, evicts oldest on insert); a semaphore map for concurrency. Used for token-bucket and sliding-window policies alike (AS-28/29).
- **Rationale**: FR-021. The existing `in-memory-token-bucket.ts` is already bounded; it is renamed and extended.

## R-09 Local lease

- **Decision**: keep the existing slice/single-flight logic, move it to `local-lease.ts`, add the denial memo (`min(retryAfterMs, 1 s)`), lease TTL from config, fraction validated in `(0, 0.5]`. Leases apply only to token-bucket, `cost = 1`, fraction set (FR-017). A pause or penalty clears the local lease for that subject.

## R-10 Policy declaration and the name type

- **Decision**: `definePolicies(owner, table)` returns the table typed with `satisfies Record<string, RateLimitPolicy>`-style generics. Names become a union by **module augmentation**: each owner writes `declare module '@app/infrastructure/rate-limit' { interface PolicyNameRegistry { 'x.y': true } }` next to its table; `PolicyName = keyof PolicyNameRegistry`. `check('x', …)` and `@RateLimit('x')` fail to compile for undeclared names (AS-72, a `*.type-spec.ts` run by `tsc`). Runtime registry (global provider) collects `forFeature` tables, validates, rejects duplicates naming both owners, and a bootstrap hook (`OnApplicationBootstrap`) resolves every `@RateLimit` reference through `DiscoveryService`/`Reflector` and fails on an undeclared name (AS-71).
- **Alternatives**: one central table (violates X.3); string-only names with runtime check (loses AS-72).

## R-11 Default limit

- **Decision**: a global `APP_INTERCEPTOR` registered by `forRoot()` applies `default.read`/`default.write` (by method) to handlers with neither `@RateLimit` nor `@RateLimitExempt`. An explicit `@RateLimit` replaces it (the default interceptor reads the same metadata and steps aside). The exempt list is collected at bootstrap, validated (non-blank reason) and logged once.
- **Ordering**: `APP_INTERCEPTOR` providers and controller-level interceptors run after guards and before pipes; the idempotency interceptor is controller/route scoped, and global interceptors run before route ones, so throttling precedes idempotency (FR-031). The HTTP e2e proves it (AS-47) and fails if the order changes.

## R-12 Headers and problem body

- **Decision**: a pure formatter produces structured-field items `"<name>";q=<limit>;w=<s>` and `"<name>";r=<remaining>;t=<s>` (seconds rounded up, `r` floored at 0, names quoted and escaped); `Retry-After` = ceil of the largest denying wait in seconds, min 1; `Cache-Control: no-store` on `429`/`503`. Headers are attached in the interceptor's `tap`/`catchError` so handler errors and filter-produced responses keep them (AS-45). The `429` body comes from `Domain_RateLimitedError` rendered by the S54 filter; the header values are written on the response before the throw.
- **Follow-up (S52)**: Express' automatic ETag is off (`bootstrap-http.ts:184`); no S50 route relies on it.
- **Follow-up (S54)**: the replay header name is `Idempotency-Replayed` everywhere.

## R-13 Client address

- **Decision**: read `req.clientIp` (set by the bootstrap from the trusted-proxy chain, `bootstrap-http.ts:191`); never `cf-connecting-ip` or `x-forwarded-for` (AS-48). Missing identity → address subject plus `rate_limit_subject_fallback_total`.

## R-14 Removing the throttler

- **Decision**: delete `redis-throttler.storage.ts`, the `ThrottlerModule`/`ThrottlerGuard` wiring in `core`, `sse-gateway` and `global-modules.ts`, the two config keys, and the `Firewall` options. Existing e2e that rely on a `429` from the global guard (grep `ThrottlerGuard|throttle_api`) are re-pointed to the default interceptor or explicit policies. State under `throttle:` simply expires.
- **Risk**: a route that was `skipThrottle: true` now gets `default.*`; the G-34 list picks, per site, default / explicit / exempt (streams and signed webhooks exempt with a reason).

## R-15 Edge worker

- **Decision**: one script returns `{allowed, remaining, retryAfterMs, resetMs}` from the edge store's single atomic call; one `rateLimitResponse()` builds the problem+json with `Retry-After` and `RateLimit*`; fail-open path counts and logs. Constants stay in the worker. The new `rate-limit.spec.ts` calls the worker's `fetch` handler with a fake edge store (system edge), which is allowed by VII.2.

## R-16 Observability

- **Decision**: `MetricsRegistry` counters/histogram/gauge named in the spec; labels `policy`, `allowed`, `source`, `reason`; policy label cardinality is bounded by the registry. Denial logs: one line per policy per second, fields `policy`, `reason`, `requestId`, never the subject or driver message.
