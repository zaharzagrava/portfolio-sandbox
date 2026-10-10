# Contract: S50 rate limiter

S50 has no endpoint of its own. Its contracts are the programmatic surface (barrel `@app/infrastructure/rate-limit`), the headers and problem bodies on any limited route, and the edge worker's `429`. Authoritative text: `spec.md` FR-025–034, FR-047–053, "Provides".

## Programmatic surface

```ts
RateLimitModule.forRoot()                 // once per app: service, registry, default.read/default.write interceptor
RateLimitModule.forFeature(table)         // each owner registers its definePolicies(owner, table)
definePolicies(owner, table)              // typed; names join PolicyNameRegistry by module augmentation

RateLimiterService
  check(policy, subject, cost = 1): Promise<RateLimitDecision>   // never throws for denial/outage
  acquire(policy, subject): Promise<{ acquired: true; release(): Promise<void>; decision } | { acquired: false; decision }>
  refund(policy, subject, units = 1): Promise<void>
  reset(policy, subject): Promise<void>
  penalize(policy, subject, ms): Promise<boolean>                // token bucket only; false when the store is down

@RateLimit(...(name | { policy, cost?, subject?, failureStatuses? })[])
@RateLimitExempt(reason: string)                                  // non-blank, logged at boot
```

Errors: `Domain_RateLimitedError` (429), `Domain_RateLimiterUnavailableError` (503), `Domain_RateLimitCostExceededError` (422), `InvalidRateLimitCostError`, `InvalidPenaltyError`, `UnsupportedPenaltyError`.

## HTTP responses on a limited route

| Case | Status | Headers | Body |
|---|---|---|---|
| Allowed | handler's | `RateLimit-Policy: "<name>";q=<limit>;w=<s>`, `RateLimit: "<name>";r=<remaining>;t=<s>`, one item per non-concurrency policy in declaration order | handler's |
| Over limit / paused | 429 | the above + `Retry-After` (largest denying wait, ≥ 1) + `Cache-Control: no-store` | problem+json: `type, title, status, detail (generic), instance, requestId, code: "rate_limited", retryAfterSeconds` |
| Fail closed, store down | 503 | `Retry-After: 1`, `Cache-Control: no-store` | problem+json `code: "rate_limiter_unavailable"`, generic `detail` |
| Cost above limit | 422 | no `Retry-After` | problem+json `code: "rate_limit_cost_exceeded"` |
| Fail open, store down | handler's | no `RateLimit*` headers | handler's |
| `OPTIONS` | not counted | — | — |

Never present: policy names or subjects in `detail`; `RateLimit-Limit/-Remaining/-Reset`, `X-RateLimit-*`; an automatic body-hash `ETag` (Express `etag` is off in `bootstrap-http.ts`). Exposed to browsers by the bootstrap: `Retry-After`, `RateLimit`, `RateLimit-Policy`, `Idempotency-Replayed`.

Order: guards → default / `@RateLimit` interceptor → pipes → idempotency interceptor → handler → exception filter.

## Metrics and logs (AS-74, AS-75)

`rate_limit_decisions_total{policy,allowed,source,reason}`, `rate_limit_check_duration_seconds`, `rate_limit_store_unavailable_total`, `rate_limit_breaker_state`, `rate_limit_subject_fallback_total`, `rate_limit_penalties_total`. Breaker transitions: one log line each. Denials: sampled one line per policy per second with `requestId`; no subject, no driver text.

## Configuration (validated at startup)

`rate_limit_store_timeout_ms` (200), `rate_limit_breaker_failures` (3), `rate_limit_breaker_open_ms` (2000), `rate_limit_fallback_instances` (4), `rate_limit_lease_ttl_ms` (1000), `rate_limit_penalty_max_ms` (3,600,000). Removed: `throttle_api_limit`, `throttle_api_ttl`.

## Edge worker (`packages/edge-be`)

Sliding window, 120 per 60 s per subject (verified user id, else CDN connecting address, else `anonymous`), one atomic store call, 500 ms timeout, fail open (counted and logged). `429` = problem+json with `Retry-After`, `RateLimit-Policy`, `RateLimit`, `Cache-Control: no-store`.
