---
id: S50
title: Rate limiting: token bucket, sliding window, concurrency limits, fail modes, headers
kind: capability
status: draft
generated_at: e95ce81
depends_on: [S54, S01, S03, S53]
concepts: [rate-limit-policy, problem-json-errors, idempotency-key, tenant-shop-rbac, request-context]
models: []
scope:
  - packages/backend/libs/domains/assistant/**
  - packages/backend/libs/domains/auctions/**
  - packages/backend/libs/domains/catalog/**
  - packages/backend/libs/domains/catalog-sync/**
  - packages/backend/libs/domains/community/**
  - packages/backend/libs/domains/developer-platform/**
  - packages/backend/libs/domains/discovery/**
  - packages/backend/libs/domains/fulfilment/**
  - packages/backend/libs/domains/identity/**
  - packages/backend/libs/domains/launch-events/**
  - packages/backend/libs/domains/marketing/**
  - packages/backend/libs/domains/notifications/**
  - packages/backend/libs/domains/orders/**
  - packages/backend/libs/domains/statements/**
  - packages/backend/libs/infrastructure/rate-limit/**
---
# S50 - Rate limiting: token bucket, sliding window, concurrency limits, fail modes, headers

## Purpose
Platform operators and domain teams need one shared limiter that caps how often a subject (address, user, API key, shop, hashed e-mail) can use a route or a code path. It protects login, ordering, bidding and write routes from abuse and overload. It gives every caller the same three algorithms, the same {{concept:rate-limit-policy}} model, the same headers, the same {{concept:problem-json-errors}} responses and one fail-mode model. It replaces the earlier fixed-window throttler.

## Entry points
- `@RateLimit(...)` decorator on a route: runs the policies of the route as an interceptor. [code: packages/backend/libs/infrastructure/rate-limit/rate-limit.decorator.ts#RateLimit]
- `@RateLimitExempt(reason)` decorator: excludes a route from all limiting and requires a non-blank reason. [code: packages/backend/libs/infrastructure/rate-limit/rate-limit.decorator.ts#RateLimitExempt]
- Default limit: a route with neither decorator is limited by `default.read` (safe methods) or `default.write` (other methods). [code: packages/backend/libs/infrastructure/rate-limit/default-rate-limit.ts#defaultEntryFor]
- Programmatic service `check`, `acquire`, `refund`, `reset`, `penalize` for workers and application services. [code: packages/backend/libs/infrastructure/rate-limit/rate-limiter.service.ts#RateLimiterService]
- Policy registry: each owning capability declares its policies with `definePolicies` and the module's `forFeature`. [code: packages/backend/libs/infrastructure/rate-limit/policy.ts#definePolicies]
- Edge worker: a sliding-window limiter in front of the application, answering `429` or proxying. [code: packages/edge-be/src/index.ts#SLIDING_WINDOW_LUA]
- Local-profile key `rate_limit_allow_ips` (comma-separated client addresses that skip the limiter; refused in production). Configuration keys: `rate_limit_store_timeout_ms`, `rate_limit_breaker_failures`, `rate_limit_breaker_open_ms`, `rate_limit_fallback_instances`, `rate_limit_lease_ttl_ms`, `rate_limit_penalty_max_ms`.

## Rules
- **S50.R-01** A [token bucket ↗](../sw-external-terms.md#token-bucket) MUST hold a capacity equal to its [`limit`](../terms/rate-limit.md), start full, refill continuously at `limit` tokens per [`windowMs`](../terms/rate-limit-policy.md), and never exceed its capacity. [proof: S50 AS-01, S50 AS-02, S50 AS-03] [code: packages/backend/libs/infrastructure/rate-limit/lua.ts#TOKEN_BUCKET]
- **S50.R-02** A token-bucket denial MUST consume nothing and report [`retryAfterMs`](../terms/retry-after-seconds.md), the time until [`cost`](../terms/rate-limit-cost.md) tokens exist; an allowed decision reports `0`. [proof: S50 AS-02, S50 AS-05]
- **S50.R-03** [Buckets](../terms/rate-limit-bucket.md) of different [subjects](../terms/rate-limit-subject.md), and of one subject on different [policies](../terms/rate-limit-policy.md), MUST be independent. [proof: S50 AS-04]
- **S50.R-04** A `cost` MUST be a positive integer; [`check`](../terms/rate-limit-check.md) MUST throw [`InvalidRateLimitCostError`](../terms/invalid-rate-limit-cost-error.md) for 0, negatives, fractions, [`NaN` ↗](../sw-external-terms.md#nan) and `Infinity`, and change nothing. [proof: S50 AS-07] [code: packages/backend/libs/infrastructure/rate-limit/cost.ts#assertValidCost]
- **S50.R-05** A `cost` above the policy `limit` MUST be denied with [`reason: 'cost-exceeds-limit'`](../terms/rate-limit-cost-exceeded.md) and `retryAfterMs: null`; over HTTP it MUST answer `422` [`rate_limit_cost_exceeded`](../terms/rate-limit-cost-exceeded.md). [proof: S50 AS-06]
- **S50.R-06** On the [HTTP surface](../terms/http-surface.md) the cost used MUST be `max(1, ceil(value))` of the [resolver result](../terms/rate-limit-cost-resolver.md), and `1` for non-finite values. [proof: S50 AS-07] [code: packages/backend/libs/infrastructure/rate-limit/cost.ts#normalizeHttpCost]
- **S50.R-07** A [lowered policy](../terms/rate-limit-policy-change.md) MUST cap a [stored bucket](../terms/rate-limit-counter-store.md) at the new capacity at the next decision; a raised policy MUST refill from the current level and MUST NOT jump to the new capacity. [proof: S50 AS-83]
- **S50.R-08** A [sliding-window ↗](../sw-external-terms.md#sliding-window) policy MUST [estimate usage](../terms/sliding-window-estimate.md) as `previous × (1 − elapsed ÷ windowMs) + current`, admit only when `estimate + 1 ≤ limit`, and count only admitted requests. [proof: S50 AS-09, S50 AS-11, S50 AS-12] [code: packages/backend/libs/infrastructure/rate-limit/lua.ts#SLIDING_WINDOW]
- **S50.R-09** A sliding-window denial MUST report the [earliest delay](../terms/retry-after-seconds.md) at which the same request is admitted; waiting 1 ms less MUST still deny. [proof: S50 AS-13]
- **S50.R-10** A [concurrency policy](../terms/concurrency-limit.md) MUST admit at most `limit` unexpired [leases](../terms/concurrency-lease.md) per subject; [`release()`](../terms/concurrency-lease-release.md) MUST be [idempotent ↗](../sw-external-terms.md#idempotency) and MUST free only its own lease. [proof: S50 AS-15, S50 AS-16, S50 AS-18] [code: packages/backend/libs/infrastructure/rate-limit/lua.ts#CONCURRENCY_ACQUIRE]
- **S50.R-11** A [lease](../terms/concurrency-lease.md) MUST expire after [`windowMs`](../terms/window-ms.md), so a crashed holder frees its slot; a denied [`acquire`](../terms/acquire.md) MUST report [`retryAfterMs`](../terms/retry-after-ms.md) [clamped](../terms/clamping.md) to 1000–5000 ms. [proof: S50 AS-17, S50 AS-19]
- **S50.R-12** A [concurrency lease](../terms/concurrency-lease.md) taken for a request MUST be released on success, on a thrown error and on [client abort](../terms/client-abort.md). [proof: S50 AS-20]
- **S50.R-13** Each decision MUST be one [atomic step ↗](../sw-external-terms.md#atomicity) in the [shared store](../terms/rate-limit-counter-store.md), so admitted units never exceed the [budget](../terms/rate-limit-budget.md) across instances. [proof: S50 AS-10, S50 AS-80, S50 AS-81]
- **S50.R-14** Decisions MUST use the [store's clock](../terms/store-clock.md) only; instance system clocks MUST NOT enter a decision. [proof: S50 AS-14] [code: packages/backend/libs/infrastructure/rate-limit/time-source.ts#StoreTimeSource]
- **S50.R-15** Every stored item MUST carry an expiry bounded by the [policy](../terms/rate-limit-policy.md) ([token bucket ↗](../sw-external-terms.md#token-bucket): [time-to-full](../terms/time-to-full.md) plus 1 s), and all items of one decision MUST share one [hash tag](../terms/hash-tag.md) of policy and [subject](../terms/rate-limit-subject.md). [proof: S50 AS-08, S50 AS-73] [code: packages/backend/libs/infrastructure/rate-limit/policy-keys.ts#hashTag]
- **S50.R-16** Every policy MUST declare [`failMode`](../terms/rate-limit-fail-mode.md) as `open` or `closed`; a store call fails on error or after [`rate_limit_store_timeout_ms`](../terms/rate-limit-store-timeout-ms.md) (default 200 ms). [proof: S50 AS-31, S50 AS-69]
- **S50.R-17** Under [fail closed ↗](../sw-external-terms.md#fail-open-fail-closed), a failed decision MUST be `allowed: false`, `reason: 'store-unavailable'`, `retryAfterMs: 1000`; HTTP MUST answer `503` [`rate_limiter_unavailable`](../terms/rate-limiter-unavailable.md) with [`Retry-After: 1` ↗](../sw-external-terms.md#retry-after) and a generic detail. [proof: S50 AS-26, S50 AS-35]
- **S50.R-18** Under [fail open ↗](../sw-external-terms.md#fail-open-fail-closed), an [in-process fallback token bucket](../terms/fallback-token-bucket.md) of capacity `max(1, floor(limit ÷ fleetSize))` MUST decide, keeping at most 50,000 subjects. [proof: S50 AS-27, S50 AS-28, S50 AS-29] [code: packages/backend/libs/infrastructure/rate-limit/fallback-limiter.ts#FallbackLimiter]
- **S50.R-19** The [circuit breaker ↗](../sw-external-terms.md#circuit-breaker) MUST open after 3 consecutive store failures, skip the store for 2 s, then allow one [probe](../terms/circuit-breaker-probe.md). [proof: S50 AS-30, S50 AS-32] [code: packages/backend/libs/infrastructure/rate-limit/store-guard.ts#StoreGuard]
- **S50.R-20** A faulty [subject extractor](../terms/subject-extractor.md) or [cost resolver](../terms/rate-limit-cost-resolver.md) MUST follow the [policy's fail mode](../terms/rate-limit-fail-mode.md) and MUST NOT surface as a raw `500`. [proof: S50 AS-36]
- **S50.R-21** In the local profile, a client address listed in `RATE_LIMIT_ALLOW_IPS` MUST skip every HTTP policy (a test runner creates many accounts from one address), any other address MUST stay limited, and the app MUST NOT boot with the setting in production. [proof: S50 G-01, S50 G-02] [code: packages/backend/libs/infrastructure/rate-limit/rate-limit.interceptor.ts#RateLimitInterceptor]

## Behaviors
- **S50.B-01** Given [burst](../terms/rate-limit-policy.md) 10 and 50 parallel [`check`](../terms/rate-limit-check.md) calls on a fresh [subject](../terms/rate-limit-subject.md), when they run, then exactly 10 are allowed with [`remaining`](../terms/rate-limit-check.md) 9 down to 0 and 40 are denied with [`limit-exceeded`](../terms/rate-limited.md). [proof: S50 AS-01]
- **S50.B-02** Given an empty [bucket](../terms/rate-limit-bucket.md), when the clock advances one [refill interval ↗](../sw-external-terms.md#token-bucket) (6 s), then exactly one further `check` is allowed. [proof: S50 AS-02]
- **S50.B-03** Given ["5 per 15 minutes"](../terms/rate-limit-policy.md), when six requests arrive, then the sixth is denied with [`retryAfterMs > 0`](../terms/retry-after-seconds.md). [proof: S50 AS-09]
- **S50.B-04** Given 10 requests in the last second of a [window ↗](../sw-external-terms.md#sliding-window), when 10 more arrive in the first second of the next, then none is admitted. [proof: S50 AS-11]
- **S50.B-05** Given a [concurrency limit](../terms/concurrency-limit.md) of 2 and a 300 ms handler, when a third request arrives, then it gets `429` with [`Retry-After >= 1` ↗](../sw-external-terms.md#retry-after). [proof: S50 AS-20]
- **S50.B-06** Given an allowed request on [policy `p`](../terms/rate-limit-policy.md) (limit 5, 15 min), then the response carries [`RateLimit-Policy: "p";q=5;w=900`](../terms/rate-limit-response-headers.md) and `RateLimit: "p";r=…;t=…`. [proof: S50 AS-38]
- **S50.B-07** Given an [exhausted policy](../terms/rate-limit-policy.md), when a request arrives, then the response is `429` [problem+json ↗](../sw-external-terms.md#problem-json) with no policy name and no [subject](../terms/rate-limit-subject.md) in its fields. [proof: S50 AS-37]
- **S50.B-08** Given a route with [two policies](../terms/rate-limit-policy.md) where the second denies, when the request ends, then the [units taken](../terms/rate-limit-cost.md) from the first are returned. [proof: S50 AS-40]
- **S50.B-09** Given an [over-limit subject](../terms/rate-limit-subject.md) and an invalid body, then the answer is `429`, not `400`; given an under-limit subject, then `400` and [one unit is consumed](../terms/rate-limit-cost.md). [proof: S50 AS-41]
- **S50.B-10** Given a request without [credentials](../terms/credential.md), then the answer is `401` and no [identity-keyed policy](../terms/rate-limit-policy.md) records it. [proof: S50 AS-42, S50 AS-43]
- **S50.B-11** Given a [mutating route](../terms/mutating-route.md) with an [`{{concept:idempotency-key}}`](../terms/idempotency-key.md) [limited to 3 requests](../terms/rate-limit.md), when the same request is sent four times, then the fourth is `429`. [proof: S50 AS-47]
- **S50.B-12** Given a client that rotates [`CF-Connecting-IP`](../terms/forwarding-headers.md), `X-Forwarded-For` and `X-Real-IP`, then it is still limited by [the address the platform resolved](../terms/client-address.md). [proof: S50 AS-48]
- **S50.B-13** Given a [user, API-key or shop policy](../terms/rate-limit-policy.md) and a request without that identity, then [the client address is the subject](../terms/rate-limit-subject.md) and [the fallback counter](../terms/rate-limit-subject-fallback.md) increases. [proof: S50 AS-50]
- **S50.B-14** Given `" Alice@Example.COM "` and `"alice@example.com"`, then both map to one [hashed subject](../terms/rate-limit-subject.md), and no [stored key](../terms/rate-limit-bucket.md) contains the address. [proof: S50 AS-51, S50 AS-52]
- **S50.B-15** Given a [failures-only policy](../terms/failures-only-policy.md) "5 per 15 min", when five wrong credentials and then the correct one arrive, then the sixth is `429` and [its handler does not run](../terms/rate-limit-check.md). [proof: S50 AS-54]
- **S50.B-16** Given four failures, when a request succeeds with [reset on success](../terms/reset-on-success.md), then [the counter clears](../terms/rate-limit-bucket.md). [proof: S50 AS-55]
- **S50.B-17** Given [20 parallel wrong-credential requests ↗](../sw-external-terms.md#race-condition) with limit 5, then exactly 5 [reach the handler](../terms/rate-limit-check.md). [proof: S50 AS-56]
- **S50.B-18** Given a route with [no decorator](../terms/rate-limit-decorator.md), then `GET` uses [`default.read`](../terms/default-rate-limit-policies.md) and other methods use `default.write`. [proof: S50 AS-66, S50 AS-67]
- **S50.B-19** Given a route [exempt with a blank reason](../terms/rate-limit-exemption.md), then the application [refuses to start ↗](../sw-external-terms.md#fail-fast). [proof: S50 AS-68]
- **S50.B-20** Given a [duplicate policy name](../terms/rate-limit-policy.md) in two modules, then startup fails naming both modules. [proof: S50 AS-70]

## Lifecycles
Not applicable. The limiter owns no business status. The circuit breaker moves between closed, open and probing; instances move it, as shown in R-19. A penalty pause is a stored item that ends by expiry.

## Owns
- No database table and no database access on the decision path.
- Store items (token bucket, sliding-window counters, concurrency leases, pauses), each with an expiry.
- Metrics: `rate_limit_decisions_total`, `rate_limit_check_duration_seconds`, `rate_limit_store_unavailable_total`, `rate_limit_subject_fallback_total`.
- Policies `default.read` and `default.write`; all other policies belong to the declaring capability.
- Configuration: the six `rate_limit_*` keys listed under Entry points.

## Decisions
- One limiter replaces the fixed-window throttler, so the platform has one algorithm set, one set of headers and one fail-mode model.
- The store's clock is the only time source, so instances with different system clocks cannot change a decision.
- Every policy declares its fail mode with no default, so each owner chooses between safety and availability.
- Retries live at one layer: the limiter does not retry a failed store call, and the caller retries on `429` or `503`.
- Throttling runs after authentication and before validation and the idempotency check, so strangers cannot spend a victim's budget and replays consume budget.
- Failures-only counting reserves the slot at admission, so parallel attempts cannot all pass a pre-check.
- Policy owners declare their own policies through the registry, not in a central table.
- Stored subjects are typed and hashed where personal, so no e-mail, token, password or secret appears in the store.

## Known gaps
- Local leased budget (AS-21 to AS-25) and penalties (AS-60 to AS-65) are P2 stories. Tests exist, but this page states no rule for them; they need a review.
- Header formatting rules (AS-82), the full 429 body fields and multi-policy headers have no dedicated rule here; only B-06 and B-07 summarize them.
- Rules for subject length (128 characters, AS-53), `refund` and `reset` safety (AS-58, AS-59) and the metric and log contents (AS-74, AS-75) are not stated as rules.
- Edge worker rules (AS-76 to AS-79) have tests but no rule or behavior on this page.
- Policy-name grammar and compile-time rejection of undeclared names (AS-69, AS-72) are not expanded.
- CORS preflight exemption (AS-46) and error responses keeping headers (AS-45) have no rule.
- Concurrency fail-open semaphore size (AS-34) is cut off in the facts and is not stated.
- Several rules list no `[proof: none]` item, but R-07 and R-12 rely on single tests that I could not confirm in detail.