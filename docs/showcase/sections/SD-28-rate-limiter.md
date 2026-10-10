# SD-28 — Distributed Rate Limiter (edge + gateway + business limits)

Status: ☑ done (typechecked; spec + k6 written, not run) · Phase 0 · Depends on: F-01 · Used by: SD-07, 21, 30, 36, 42 · README showcase #20

## Marketplace adaptation
Three layers protect the marketplace: Cloudflare edge (per IP / per user, already a fixed window in `edge-be`), backend per **API key / user / shop** limits on expensive endpoints (checkout, search, public API), and **business quotas** (e.g. "5 bulk imports/hour per shop", "LLM tokens per plan").

## Existing code
`packages/edge-be/src/index.ts` (fixed window INCR+EXPIRE via Upstash REST), `@nestjs/throttler` global guard (in-memory per instance → wrong under N instances).

## Patterns showcased
| Pattern | Lesson |
|---|---|
| **Token bucket** (Lua, atomic, `PEXPIRE` idle keys) — bursts allowed | 03/04 §7, 04/03 §3, 10/02 Ex3 |
| **Sliding window counter** (two fixed windows weighted) — smooth, cheap | 04/03 §3 |
| **Concurrency limiter** (in-flight semaphore in Redis ZSET with lease expiry) for expensive endpoints (exports, LLM) | 04/03 §3 |
| Local pre-check / **leased budget**: each instance takes a slice of tokens (e.g. 10%) to cut Redis round trips for hot keys | 10/02 Ex3 |
| Fail-open vs fail-closed **per endpoint**, in-memory fallback limiter when Redis is down + circuit breaker around Redis | 10/02 Ex3, 06/03 |
| Headers: IETF `RateLimit` + `RateLimit-Policy`, `Retry-After`, 429 Problem Details | 04/03 §3 |
| Redis Cluster hash tags `{key}` for multi-key scripts | 03/04 §8 |
| Edge: upgrade the worker from fixed window to sliding window (Upstash `EVAL`) | — |
| Replace in-memory `ThrottlerGuard` storage with Redis storage (`@nest-lab/throttler-storage-redis` or own) | — |

## Steps
- [x] `libs/common/src/rate-limit/` — `RateLimiter` port; `RedisTokenBucket`, `RedisSlidingWindow`, `RedisConcurrencyLimiter` (Lua in `.lua` files loaded with `defineCommand`), `LocalLeaseLimiter` decorator, `InMemoryFallbackLimiter`.
- [x] `@RateLimit({ policy: 'checkout', key: 'user'|'apiKey'|'shop'|'ip', failMode: 'open'|'closed' })` decorator + guard; policies in config.
- [x] Response headers interceptor.
- [x] Swap ThrottlerGuard storage to Redis.
- [x] Edge worker: sliding-window via single `EVAL`.
- [x] Shared-logic specs (real Redis): 200 parallel requests against limit 100 → exactly 100 allowed; Redis down → fail-open/closed per policy.
- [x] k6 `loadtest:ratelimit`.

## Scale
- Target: 100k RPS checks (D25); added latency < 1 ms p99.
- Hot path: guard → (local lease hit, no I/O) or 1 Redis `EVALSHA` → allow/deny. Never touches Postgres.
- First bottleneck & fix: a hot key (one big API client) pins one Redis shard → local leased budget reduces Redis calls ~10×; keys spread by hash slots otherwise.
- Partitioning: Redis Cluster by `{limiterKey}`.
- Capacity model: Redis ~100k+ simple ops/s per shard; with leases (~10% of checks hit Redis) 100k RPS ≈ 10k ops/s → 1 shard + replica, 3 shards for headroom.
- Proof: k6 at 2× limit → exactly limit admitted ±1% across 1/2/4 API instances; p99 overhead < 1 ms.

## FE visualisation (phase 2)
Seller API dashboard shows usage vs limits (SD-07).

## Implementation notes (2026-10-01)
- `libs/common/src/rate-limit/`: Lua (`TOKEN_BUCKET` with partial grants for leases, `SLIDING_WINDOW`, `CONCURRENCY_ACQUIRE` with lease expiry) using Redis `TIME`; typed policy table (`satisfies`); `RateLimiterService` (local lease slices for hot keys, in-memory fallback for fail-open, fail-closed, 3-strike/2 s breaker around Redis, decision metrics); `@RateLimit(...policies)` interceptor (runs after auth guards → can key by user/API key/shop; hashed email keys; IETF `RateLimit-*` + `Retry-After`; `Domain_RateLimitedError` 429 Problem Details; concurrency leases released in `finalize`); `RedisThrottlerStorage` (global `@nestjs/throttler` now fleet-wide).
- Applied: `POST /api/auth/login` (`auth.login.ip` + `auth.login.account`), `GET /api/products/search` (`search.query`, lease 10 %). `core` imports `RedisModule` + `RateLimitModule`.
- Edge (`packages/edge-be`): fixed window (INCR + separate EXPIRE, 2× burst at boundaries) → sliding window in one atomic `EVAL`, 500 ms timeout, fail-open. Edge typecheck clean.
- Spec `rate-limit/rate-limit.e2e-spec.ts`; k6 `scripts/load-tests/ratelimit.test.js` (`pnpm loadtest:ratelimit`).

## Update (S50, 2026-10-10)
- One limiter: the global `@nestjs/throttler` guard, `RedisThrottlerStorage`, `Firewall({ throttle, skipThrottle })` and the `throttle_api_*` config are gone. `RateLimitModule.forRoot()` installs a global interceptor: explicit `@RateLimit(...)`, else `default.read` (300/min) / `default.write` (60/min), unless `@RateLimitExempt(reason)`.
- Headers are the IETF structured fields (`RateLimit-Policy: "p";q=5;w=900`, `RateLimit: "p";r=0;t=12`) plus `Retry-After`; a fail-closed outage answers `503 rate_limiter_unavailable`, a cost above the limit `422 rate_limit_cost_exceeded`. The sliding window reads the store clock inside the script; `acquire` returns `{ acquired, release, decision }`; failures-only counting, `penalize`, `refund`, `reset` exist.
- Policies are declared by their owning domain (`rate-limit-policies.ts` + `RateLimitModule.forFeature`), validated at startup. Edge: same `429` shape, `Retry-After` and `RateLimit*` headers.
