# Feature Specification: S50 — Distributed rate limiter

**Feature Branch**: `S50-rate-limiter` (spec directory only; no branch is created by this run)

**Created**: 2026-10-06

**Status**: Draft

**Domain**: `infrastructure` (lib `libs/infrastructure/rate-limit`; no table; key prefixes `rl:` and, until removed by FR-048, `throttle:` in the shared in-memory store, owned by this lib per constitution I.4; plus the edge worker `packages/edge-be`, which applies the same algorithm at the edge)

**Input**: "Rate limiting: token bucket, sliding window, concurrency limits, fail modes, headers"

## Summary

Three layers protect the marketplace. The **edge** (Cloudflare worker) stops floods per address before they cost anything. The **backend** limits per principal (user, API key, shop, address) on expensive or abusable endpoints. **Budgets for outbound work** (provider send rates, third-party API credentials, LLM tokens per minute) keep the platform inside quotas it does not control. This capability is the one engine and the one HTTP contract behind all three.

It gives the rest of the platform:

1. **Three algorithms with exact semantics**: a *token bucket* (bursts allowed, average rate bounded), a *sliding window counter* (smooth, no double burst at window boundaries), and a *concurrency limiter* (at most N operations in flight, with leases that expire if the holder dies).
2. **Fleet-wide correctness**: a limit holds across any number of instances. Two hundred parallel requests against a limit of one hundred admit exactly one hundred, whichever instances receive them.
3. **A local leased budget** for hot keys, so a busy subject does not cost a network round trip per request.
4. **A fail mode per policy** (open or closed), an in-process fallback limiter and a circuit breaker, so a store outage degrades each endpoint the way its owner decided and never turns into a pile-up of timeouts.
5. **Failure-only counting with reset on success** for credential-guessing defences (login, second factor), safe under parallel attempts.
6. **Cost-weighted consumption and pausing** for token-denominated budgets (LLM tokens) and for third-party `Retry-After` hints shared by every worker.
7. **One HTTP contract**: IETF `RateLimit` and `RateLimit-Policy` headers, `Retry-After`, a `429` problem+json for "you are over", a `503` for "the limiter cannot decide and this endpoint fails closed", and a `422` for a request that can never fit its budget.
8. **A policy registry that other capabilities declare into**, validated at startup, with a platform default limit on every route that has no explicit one.

## Scope

In scope:

- The three algorithms, their atomicity and their single time source; time-to-live on every stored item.
- Local leased budget, denial memo, single-flight refill.
- Fail modes, the store timeout, the circuit breaker, the in-process fallback limiter, recovery.
- The programmatic surface (`check`, `acquire`, `refund`, `reset`, `penalize`) and the HTTP surface (`@RateLimit`, `@RateLimitExempt`, the platform default limit, headers, problem responses).
- Subject derivation (address, user, API key, shop, hashed e-mail, custom) and its privacy rules.
- Failure-only counting, cost, penalties.
- The policy declaration mechanism, startup validation, naming grammar, and the two platform-owned policies `default.read` and `default.write`.
- Metrics and logs of the limiter.
- The edge worker's limiter (sliding window in one atomic step, `429` with headers, fail open).
- Removal of the second, fixed-window limiter (`@nestjs/throttler` with its store) so one engine remains.

Out of scope (owned elsewhere, named so nobody re-specifies them):

- **The numbers and names of each endpoint's policy.** Each owning capability declares its own policies (the specs of S01–S48 already name them) into this capability's registry. This spec fixes how a policy is declared, validated and enforced, and owns only `default.read` and `default.write`. The full list of names other specs require is the to-do list in `gaps.md`.
- **Billed quotas and plan entitlements** ("LLM tokens per plan", "imports per plan"): S18. A rate limit is a protective limit, not a billed quota.
- **Choosing which endpoint uses which policy**: the endpoint's owner.
- **Trusted-proxy resolution of the client address** and CORS exposure of response headers: platform bootstrap (S54, origin S01 FR-014); this capability consumes the resolved address and requires the headers to be exposed (Requires).
- **The idempotency facility** (V.6): S54. This capability fixes only the order relative to it (FR-031).
- **CAPTCHAs, per-device lockouts, WAF rules, DDoS scrubbing**: operations artifacts.
- **A leaky-bucket algorithm**: the notes list it, but the token bucket with an average rate covers every use here (Assumptions).
- **A dashboard of usage against limits** (SD-28 "FE visualisation, phase 2"): a later web capability; it would read through an R1 service this capability does not yet provide.

## User Scenarios & Testing *(mandatory)*

Actors: **a client** (an anonymous visitor, a signed-in user, a seller holding an API key), **a domain service** (declares policies, calls the limiter from code), **a background worker** (spends budgets for outbound calls), **an operator** (watches metrics, decides fail modes), **an edge worker** (the first line of defence).

Time in scenarios: the limiter takes its time from the shared store's clock, and tests drive that clock through an injectable time source (FR-010). "Advance 6 s" means advance that source, never sleep.

### User Story 1 - A token bucket allows bursts and bounds the average (Priority: P1)

A buyer can fire ten checkout attempts at once (the burst) but not sustain more than ten a minute. Every instance of the service enforces the same bucket.

**Why this priority**: The most common limit on the platform (checkout, search, public API, provider send rates) and the base of the exactness guarantee.

**Independent Test**: Call the limiter 50 times in parallel on a fresh subject with a burst of 10 and count the allowed.

**Acceptance Scenarios**:

1. **AS-01** — **Given** a policy "burst 10, refill 10 per minute" and a fresh subject, **When** 50 `check` calls arrive in parallel, **Then** exactly 10 return `allowed: true` and 40 return `allowed: false` with `reason: 'limit-exceeded'`; the allowed decisions report `remaining` values that are distinct and descend from 9 to 0; no decision reports more than `limit` or less than 0.
2. **AS-02** — **Given** that bucket now empty, **When** the time source advances 6 s (one refill interval), **Then** exactly one further `check` is allowed and the next is denied; **And** the denial's `retryAfterMs` is the time until the next token, in `(0, 6000]`.
3. **AS-03** — **Given** a bucket that has been idle for 10 times its time-to-full, **When** 50 `check` calls arrive in parallel, **Then** exactly 10 are allowed (idle time never stores more than the capacity).
4. **AS-04** — **Given** two subjects on the same policy, and one subject on two policies, **When** one is exhausted, **Then** the others are unaffected (a full burst remains available to each).
5. **AS-05** — **Given** burst 10 and `cost` 4, **When** three `check(policy, subject, 4)` calls run in sequence, **Then** the first two are allowed (remaining 6, then 2) and the third is denied with `remaining: 2`; **And** a following `check` with cost 2 is allowed (a denial consumes nothing).
6. **AS-06** — **Given** burst 10, **When** `check` is called with cost 11, **Then** the decision is `allowed: false`, `reason: 'cost-exceeds-limit'`, `retryAfterMs: null` (waiting never helps), the bucket is unchanged, and **When** the same cost reaches the HTTP surface, **Then** the response is `422` `rate_limit_cost_exceeded` with no `Retry-After`.
7. **AS-07** — **Given** a cost of 0, -1, 1.5, `NaN` or `Infinity` passed to `check`, **Then** the call throws `InvalidRateLimitCostError` and changes nothing; **Given** an HTTP cost resolver that returns those values, **Then** the cost used is `max(1, ceil(value))` and `1` for non-finite values.
8. **AS-08** — **Given** any token-bucket decision, **Then** the stored state carries an expiry no later than the policy's time-to-full plus 1 s, so an idle subject leaves nothing behind.
9. **AS-83** — **Given** a bucket with 100 tokens stored under a policy of burst 100, **When** a deployment lowers the policy to burst 10, **Then** the next decision sees at most 10 tokens; **When** a later deployment raises it to burst 50, **Then** the bucket refills at the new rate from its current level and does not jump to 50 at once.

---

### User Story 2 - A sliding window counter is smooth and exact (Priority: P1)

A login endpoint allows five failed attempts per account in 15 minutes. An attacker cannot double that by timing attempts around a window boundary.

**Why this priority**: Used by every credential defence; the boundary weakness of a fixed window is the textbook attack the notes call out.

**Independent Test**: With a controlled clock, fill one window, cross the boundary, and count what is admitted.

**Acceptance Scenarios**:

1. **AS-09** — **Given** a policy "5 per 15 minutes", **When** six `check` calls arrive in sequence for one subject, **Then** the first five are allowed with `remaining` 4, 3, 2, 1, 0 and the sixth is denied with `retryAfterMs > 0` and `remaining: 0`.
2. **AS-10** — **Given** a policy "100 per 60 s", **When** 200 `check` calls arrive in parallel on a fresh subject, **Then** exactly 100 are allowed.
3. **AS-11** — **Given** a policy "10 per 60 s" with 10 requests admitted in the last second of one fixed window, **When** 10 more arrive in the first second of the next, **Then** none is admitted during that first second (a fixed window would admit all 10), and the first admission happens when the previous window's weight has fallen enough that `estimate + 1 ≤ 10`.
4. **AS-12** — **Given** a policy "10 per 60 s" with 10 requests admitted in the previous fixed window and none in the current one, **When** the time source is exactly half-way into the current window, **Then** exactly 5 further requests are admitted (the previous window weighs 50%).
5. **AS-13** — **Given** a denied sliding-window decision with `retryAfterMs = R` and no other traffic, **When** the time source advances by `R`, **Then** the identical request is admitted; **When** it advances by `R - 1` ms instead, **Then** it is still denied.
6. **AS-14** — **Given** two service instances whose own system clocks differ by 30 s, **When** both serve 60 parallel `check` calls each against "100 per 60 s", **Then** exactly 100 in total are allowed (local clocks never enter a decision).

---

### User Story 3 - A concurrency limiter protects expensive endpoints (Priority: P1)

A shop can run at most two exports at the same time. If an export's process dies, the slot comes back by itself.

**Why this priority**: Rate does not protect against slow, expensive calls; concurrency does. A leaked slot is a permanent outage for that shop, so expiry is part of the contract.

**Independent Test**: Acquire three slots on a limit of two, release one, acquire again.

**Acceptance Scenarios**:

1. **AS-15** — **Given** a concurrency policy with limit 2, **When** three `acquire` calls run in sequence for one subject, **Then** the first two return `acquired: true` and the third returns `acquired: false` with a decision whose `retryAfterMs >= 1000`; **When** the first lease is released, **Then** a new `acquire` succeeds.
2. **AS-16** — **Given** limit 2, **When** 20 `acquire` calls arrive in parallel, **Then** exactly 2 are acquired.
3. **AS-17** — **Given** a policy with lease length 30 s and a holder that never releases (its process died), **When** the time source is 29.9 s after the acquisition, **Then** the slot is still taken; **When** it is 30 s after, **Then** the next `acquire` succeeds.
4. **AS-18** — **Given** a lease that was released, **When** `release()` is called a second time, **Then** nothing changes (it frees no other holder's slot); **Given** a lease that expired and whose slot was taken by another holder, **When** the first holder calls `release()`, **Then** the second holder's lease stays in force.
5. **AS-19** — **Given** a full concurrency limit whose earliest lease expires in 12 s, **Then** a denied `acquire` reports `retryAfterMs` of `min(12000, 5000)`; **Given** the earliest lease expires in 400 ms, **Then** it reports 1000 (never below one second).
6. **AS-20** — **Given** a route guarded by a concurrency policy with limit 2 and a handler that takes 300 ms, **When** two requests are in flight, **Then** a third gets `429` with `Retry-After >= 1`; **And** the slot is free again after the handler completes successfully, after it throws a `500`, after it throws a `422`, and after the client aborts the request (four follow-up requests are each admitted).

---

### User Story 4 - A hot key does not cost a round trip per request (Priority: P2)

One large API client sends thousands of requests a second. Each instance takes a slice of that client's budget and answers from memory, going back to the store only for a refill.

**Why this priority**: It is the documented scaling answer (about 10× fewer store calls); correctness must hold while it is on.

**Independent Test**: 200 parallel checks on a policy with a 10% lease; count admitted and store calls.

**Acceptance Scenarios**:

1. **AS-21** — **Given** "burst 60" with a lease fraction of 0.1 (slice 6), **When** 200 `check` calls arrive in parallel on one instance, **Then** at most 60 are allowed, at least 54 are allowed (the shortfall is at most one unspent slice), and the number of store calls is at most 40 (at least 5× fewer than requests), including calls made while the first refill is in flight (one refill at a time per key).
2. **AS-22** — **Given** an instance holding 4 unspent leased tokens, **When** more than 1 s passes on that instance, **Then** its next `check` for the key goes to the store and the 4 tokens are not spent afterwards.
3. **AS-23** — **Given** two instances sharing one hot key with "burst 60" and a 0.1 lease, **When** each receives 100 parallel `check` calls, **Then** the total allowed is at most 60 and at least 48 (one unspent slice per instance).
4. **AS-24** — **Given** a policy with a lease fraction, **When** a `check` has cost 3, **Then** it is decided by the store directly (one store call per `check`); the same holds for a policy with lease fraction 0 and for sliding-window and concurrency policies.
5. **AS-25** — **Given** a leased policy whose bucket is empty, **When** a denial returns `retryAfterMs = 400` and 50 more `check` calls arrive on that instance within 400 ms, **Then** they are denied locally with no store call; **When** the memo (`min(retryAfterMs, 1 s)`) ends, **Then** the next `check` asks the store again.

---

### User Story 5 - A store outage degrades each endpoint the way its owner chose (Priority: P1)

If the shared store is unreachable, search keeps working under a per-instance safety net and checkout, which cannot afford abuse, refuses with a clear `503`. Neither waits on a timeout for every request.

**Why this priority**: A limiter that takes the platform down, or silently stops limiting, is worse than none.

**Independent Test**: Break the store connection; call a fail-open route and a fail-closed route.

**Acceptance Scenarios**:

1. **AS-26** — **Given** a fail-closed policy and an unreachable store, **When** a request reaches its route, **Then** the response is `503` problem+json with `code: 'rate_limiter_unavailable'`, a generic `detail` (no store address, no error text), `Retry-After: 1`, the handler did not run, and no row was written.
2. **AS-27** — **Given** a fail-open policy and an unreachable store, **When** a request reaches its route, **Then** the handler runs and answers normally, no `RateLimit` header is sent, and `rate_limit_store_unavailable_total{policy, fail_mode="open"}` increased by 1.
3. **AS-28** — **Given** a fail-open policy "60 per minute" with the fleet-size setting at 4 and an unreachable store, **When** 20 requests arrive in sequence on one instance, **Then** the first 15 are served and the remaining 5 get `429`; the decisions carry `source: 'fallback'`.
4. **AS-29** — **Given** the in-process fallback limiter, **Then** (a) its per-instance capacity is `max(1, floor(limit / fleetSize))`, (b) a `cost` of 5 consumes 5 of it, (c) its refill and `retryAfterMs` follow the token-bucket arithmetic exactly, and (d) it retains at most 50,000 distinct subjects, evicting the least recently used (an evicted subject starts with a full bucket).
5. **AS-30** — **Given** three consecutive store failures, **Then** for the next 2 s no call reaches the store (zero calls observed) and each decision follows the fail mode; **When** the 2 s end, **Then** exactly one probe call is made; **If** it succeeds the breaker closes and decisions come from the store, **if** it fails the breaker stays open for another 2 s.
6. **AS-31** — **Given** a store that accepts connections but does not answer (a paused server), **When** a `check` is made, **Then** the call is abandoned after the configured timeout (default 200 ms), counts as a store failure, and the fail mode applies; the caller waits no more than the timeout plus 100 ms.
7. **AS-32** — **Given** a store that was down and is reachable again with its previous counters intact, **When** the breaker closes, **Then** the next decisions have `source: 'store'` and continue from the stored counters (nothing is reset, nothing is counted twice).
8. **AS-33** — **Given** the store lost its loaded scripts (restart or script flush), **When** the next `check` runs, **Then** the script is reloaded transparently, the decision is correct, `source` is `'store'`, and no fail mode, breaker strike or failure metric is recorded.
9. **AS-34** — **Given** a fail-closed concurrency policy and an unreachable store, **Then** `acquire` returns `acquired: false` with `reason: 'store-unavailable'` and the route answers `503`; **Given** a fail-open concurrency policy with limit 2 and fleet size 4, **Then** `acquire` is served by a per-process semaphore of `max(1, floor(2 / 4)) = 1`: the first `acquire` succeeds and the second is denied with `source: 'fallback'` (`429` on a route).
10. **AS-35** — **Given** a code caller (a worker) and a fail-closed policy with an unreachable store, **Then** `check` returns `{ allowed: false, reason: 'store-unavailable', retryAfterMs: 1000 }` without throwing, so the caller can re-queue the work; **And** an over-limit denial of the same policy carries `reason: 'limit-exceeded'` (the two are never confused).
11. **AS-36** — **Given** a policy whose subject extractor or cost resolver throws for some request, **Then** the policy's fail mode applies exactly as in an outage (fail open: the request is served and a counter and a log line record it; fail closed: `503`); the caller never sees a raw `500` caused by the limiter.

---

### User Story 6 - Every client gets the same, standard answer (Priority: P1)

An API client reads `RateLimit` headers to pace itself, and on `429` waits `Retry-After` seconds and succeeds.

**Why this priority**: The contract every other capability's "429 with Retry-After" depends on.

**Independent Test**: Exhaust a policy over HTTP; read status, headers and body.

**Acceptance Scenarios**:

1. **AS-37** — **Given** an exhausted policy `p` ("limit 5, window 15 min"), **When** a further request arrives, **Then** the response is `429` with `Content-Type: application/problem+json`, body fields `type`, `title: 'Too Many Requests'`, `status: 429`, `detail` (a generic sentence with the wait in seconds, no policy name, no subject), `instance`, `requestId`, `code: 'rate_limited'`, `retryAfterSeconds`; headers `Retry-After: <integer >= 1>`, `RateLimit-Policy: "p";q=5;w=900`, `RateLimit: "p";r=0;t=<seconds until a request would be admitted>`, and `Cache-Control: no-store`; the handler did not run.
2. **AS-38** — **Given** policy `p` with limit 5 and a subject that has used 1, **When** a request is allowed, **Then** its response carries `RateLimit-Policy: "p";q=5;w=900` and `RateLimit: "p";r=3;t=<seconds until the full limit is restored or the window rolls>`; the next response reports `r=2`.
3. **AS-39** — **Given** a route with two policies `a` (limit 20) and `b` (limit 5), **When** a request is allowed, **Then** both headers list one item per policy in declaration order (`"a";q=20;w=60, "b";q=5;w=900`); **When** both deny, **Then** `Retry-After` is the larger of the two waits.
4. **AS-40** — **Given** a route with policies `a` (limit 5) and `b` (limit 2), **When** three requests arrive in sequence and the third is denied by `b`, **Then** `a` still reports `r=3` (only two requests consumed it); a request denied by any policy leaves every policy's budget as it was.
5. **AS-41** — **Given** an over-limit subject and a request whose body is invalid, **Then** the response is `429` (not `400`): throttling runs before validation; **Given** an under-limit subject and an invalid body, **Then** `400` and one unit of budget was consumed (validation failures count).
6. **AS-42** — **Given** a protected route and a request without credentials, **Then** the response is `401` and no policy keyed by user, API key or shop (and no address policy of that route) recorded a request: authentication runs before throttling.
7. **AS-43** — **Given** a member of shop A who calls a shop-B route (denied `403` or `404` by the shop's own check) 1,000 times, **Then** shop B's budget for every shop-keyed policy is unchanged (a stranger cannot spend a victim's budget).
8. **AS-44** — **Given** a throttled request to a route whose handler consumes a one-time token, **Then** the token is not consumed and no state anywhere changed (the handler never ran).
9. **AS-45** — **Given** an allowed request whose handler answers `404`, `409` or `500`, **Then** the error response still carries the `RateLimit-Policy` and `RateLimit` headers of the request.
10. **AS-46** — **Given** a CORS preflight (`OPTIONS`) to a limited route, **Then** it is answered without consuming budget (1,000 preflights leave the policy untouched).
11. **AS-47** — **Given** a mutating route that honours `Idempotency-Key` and is limited to 3 requests, **When** the same request with the same key is sent four times, **Then** the first creates the resource, the second and third return the stored response (`Idempotency-Replayed: true`), and the fourth is `429`: replays consume budget because throttling runs before the idempotency check.
12. **AS-82** — **Given** the header and wait formatting rules, **Then** (a) `Retry-After` is `max(1, ceil(ms / 1000))` as a decimal integer, (b) `r` is `max(0, floor(remaining))`, (c) `t` is `ceil(resetMs / 1000)`, (d) `w` is `round(windowMs / 1000)` with no sign, (e) a policy name is emitted as a quoted string with `"` and `\` escaped, (f) items are joined with `, `, (g) a decision from a local lease reports the stored limit and the lease's remaining count.

---

### User Story 7 - Whose budget is it? (Priority: P1)

Each limit belongs to exactly one subject (an address, a user, a key, a shop). One tenant cannot spend, starve or learn about another's budget, and a spoofed header cannot fake a new identity.

**Why this priority**: A limiter keyed on attacker-controlled input is a bypass, and one keyed on the wrong tenant is an outage.

**Independent Test**: Exhaust one subject's budget and check its neighbours; rotate forwarding headers.

**Acceptance Scenarios**:

1. **AS-48** — **Given** an address policy "20 per minute" and a client that sends `CF-Connecting-IP`, `X-Forwarded-For` and `X-Real-IP` with a new value on every request from the same connection (no trusted proxy configured), **When** it sends 21 requests, **Then** the 21st is `429` (the limiter uses only the address the platform resolved).
2. **AS-49** — **Given** user A exhausted a user-keyed policy, **Then** user B is unaffected; **Given** two API keys of one shop, **Then** an API-key policy counts them separately and a shop policy counts them together; **Given** shop 1 exhausted a shop policy, **Then** shop 2 is unaffected.
3. **AS-50** — **Given** a policy keyed by user, API key or shop reaches a request that has no such identity, **Then** the request is limited by the client address instead (never unlimited) and `rate_limit_subject_fallback_total{policy}` increases by 1.
4. **AS-51** — **Given** the e-mail subject, **Then** `"  Alice@Example.COM "` and `"alice@example.com"` map to one subject, different addresses map to different subjects, a missing, empty or non-string `email` maps to one fixed "empty" subject without error, and the subject contains no part of the address (only a hash).
5. **AS-52** — **Given** a run of requests with e-mails, bearer tokens, API-key secrets and passwords in them, **When** every key in the store is listed, **Then** none contains any of those values, and every key has an expiry.
6. **AS-53** — **Given** a custom subject value of up to 128 characters, **Then** it is used as given inside its policy's namespace; **Given** a longer value, **Then** it is replaced by its hash; **Given** the extractor returns nothing, **Then** the client address is used (as AS-50).

---

### User Story 8 - Failed attempts count, successes clear them, parallel guesses do not slip through (Priority: P1)

A login allows 5 wrong passwords per account per 15 minutes. A right password clears the count. An attacker who fires 20 guesses at once still gets exactly 5.

**Why this priority**: Required by S01 and S02 (`auth.login.account`, `auth.mfa.account`); a check-then-count implementation fails the parallel case.

**Independent Test**: Fire 20 parallel wrong-password logins at a failures-only policy of 5.

**Acceptance Scenarios**:

1. **AS-54** — **Given** a failures-only policy "5 per 15 min" on an account, **When** five wrong credentials are submitted and then a sixth request with the **correct** credential, **Then** the sixth is `429` with `Retry-After > 0` and its handler did not run.
2. **AS-55** — **Given** four failed attempts, **When** a request succeeds (reset on success), **Then** the counter is cleared: five further failures are admitted and the sixth is `429`.
3. **AS-56** — **Given** limit 5, **When** 20 wrong-credential requests arrive in parallel, **Then** exactly 5 reach the handler and 15 get `429` (a slot is reserved when the request is admitted).
4. **AS-57** — **Given** an admitted request, **Then** its slot is kept only if the outcome is one of the policy's failure statuses (default `401` and `403`); a `2xx` clears the counter (when the policy resets on success), and any other outcome (`400`, `5xx`, client abort) returns the slot. Six requests ending in `500` followed by a request that ends in `401` leave one slot used.
5. **AS-58** — **Given** one failures-only policy and subject shared by three code paths (verify, confirm, regenerate), **When** each calls `check` (reserve) and `refund` or `reset` according to its outcome, **Then** their failures add up, a `reset` after a success clears all of them, and `refund` returns exactly the slot it names.
6. **AS-59** — **Given** a subject with no state, **When** `reset` or `refund` is called, **Then** it succeeds, creates nothing, and a `refund` can never take a counter below zero or a bucket above its capacity.

---

### User Story 9 - A provider's "slow down" is honoured by every worker (Priority: P2)

A third-party API answers `429 Retry-After: 30` to one worker. Every worker, on every instance, stops calling that credential for 30 s; other credentials are unaffected.

**Why this priority**: Required by S08; without it each worker discovers the pause by being rejected itself.

**Independent Test**: Penalize a subject for 30 s on one instance and `check` on another.

**Acceptance Scenarios**:

1. **AS-60** — **Given** two instances and a token-bucket policy, **When** instance 1 calls `penalize(policy, subject, 30000)`, **Then** `check` on instance 2 is denied with `reason: 'paused'` and `retryAfterMs` equal to the remaining pause (within 50 ms of 30000 at once); another subject of the policy is unaffected.
2. **AS-61** — **Given** a pause with 20 s left, **When** `penalize(..., 5000)` is called, **Then** the pause is unchanged; **When** `penalize(..., 40000)` is called, **Then** it extends to 40 s; **When** a value above the cap (1 hour) is given, **Then** 1 hour is applied; **When** `ms` is 0, negative or not finite, **Then** `InvalidPenaltyError` is thrown.
3. **AS-62** — **Given** an unreachable store, **When** `penalize` is called, **Then** it returns `false`, logs, and never throws into the caller's flow; with the store reachable it returns `true`.
4. **AS-63** — **Given** a sliding-window or concurrency policy, **When** `penalize` is called, **Then** it throws `UnsupportedPenaltyError` and nothing changes.
5. **AS-64** — **Given** a lease-enabled policy, **When** instance 1 penalizes, **Then** instance 1 drops its local lease for the subject at once and instance 2 stops admitting within the lease lifetime (1 s), having admitted at most one slice in between.
6. **AS-65** — **Given** a pause that has just ended, **When** 10 `check` calls arrive in parallel on a policy with burst 10, **Then** none is admitted at the instant the pause ends (the bucket was emptied), and after one refill interval exactly one is admitted (no burst after a pause).

---

### User Story 10 - Every route is limited, and exceptions are explicit (Priority: P1)

A route nobody thought about still has a limit. Opting out is a visible, reasoned decision. Policies are declared once, by their owner, and typos fail at startup.

**Why this priority**: Removes the "anonymous reads have no limit at all" gap (S25) and makes the policy set auditable.

**Independent Test**: Boot with a duplicate policy name; call a route with no declaration.

**Acceptance Scenarios**:

1. **AS-66** — **Given** a route with no `@RateLimit` and no exemption, **When** a `GET` arrives, **Then** policy `default.read` applies (token bucket 300 per 60 s per user-or-address, fail open); **When** a `POST`, `PUT`, `PATCH` or `DELETE` arrives, **Then** `default.write` applies (60 per 60 s per user-or-address, fail open); both send the standard headers.
2. **AS-67** — **Given** a route with an explicit `@RateLimit('x')`, **Then** `default.*` does not apply to it (policies do not stack with the default), and the response headers list only `x`.
3. **AS-68** — **Given** a route marked `@RateLimitExempt('payment provider webhook, signature-verified')`, **Then** 1,000 requests are never limited and carry no `RateLimit` headers; **Given** an exemption with an empty or blank reason, **Then** the application refuses to start; **And** at startup the full list of exempt routes with their reasons is logged once.
4. **AS-69** — **Given** a policy declaration, **Then** it is rejected, with every offence of the whole table reported at once, when: the name does not match `<area>.<name>[.<qualifier>…]` in lowercase letters, digits and hyphens; `limit` is not a positive integer; `windowMs` is not a positive integer; the algorithm is unknown; `failMode` is missing; the lease fraction is set on anything but a token bucket or is outside `(0, 0.5]`; a failures-only mode is set on a concurrency policy; `key` is not one of the known sources.
5. **AS-70** — **Given** two modules that declare a policy of the same name, **Then** application startup fails with an error naming both declaring modules.
6. **AS-71** — **Given** a route or a code call that names a policy nobody declared, **Then** startup fails (for decorators) naming the route and the policy.
7. **AS-72** — **Given** source code that names an undeclared policy in `@RateLimit(...)` or `check(...)`, **Then** it does not compile.
8. **AS-73** — **Given** any decision that touches several stored items (the two windows of a sliding window), **Then** all item names share one hash-tag section made of the policy and subject, so a clustered store keeps them in one shard.

---

### User Story 11 - Operators can see what the limiter is doing (Priority: P2)

An operator sees allowed and denied rates per policy, how many decisions came from leases and fallbacks, when the breaker opened, and how long a decision takes.

**Why this priority**: A limiter that fails silently is unfixable; SD-28's proof (latency, store load) needs these numbers.

**Independent Test**: Make decisions through each path; read the metrics.

**Acceptance Scenarios**:

1. **AS-74** — **Given** decisions through every path, **Then** `rate_limit_decisions_total{policy, allowed, source, reason}` counts each decision once; `rate_limit_check_duration_seconds{policy, source}` records one observation per decision; `rate_limit_store_unavailable_total{policy, fail_mode}` counts each store failure that reached a fail mode; `rate_limit_breaker_state` is `1` while the breaker is open and `0` otherwise; `rate_limit_subject_fallback_total{policy}` and `rate_limit_penalties_total{policy}` count AS-50 and AS-60 events.
2. **AS-75** — **Given** the breaker opening and closing, **Then** one structured log line is written per transition (`warn` on open, `info` on close) and no line per skipped call; **Given** denials, **Then** log lines are structured, carry `requestId`, `policy`, `source` and `reason`, are sampled to at most one line per policy per second, and contain no e-mail, token, secret or raw request body.

---

### User Story 12 - The edge stops floods first (Priority: P2)

The edge worker applies a sliding window per user (or address) to proxied reads and payment submissions, answers a standard `429`, and never takes the edge down if its store is slow.

**Why this priority**: The first of the three layers; the notes' upgrade from a fixed to a sliding window.

**Independent Test**: Drive the worker against a fake store through its request handler.

**Acceptance Scenarios**:

1. **AS-76** — **Given** the edge policy "120 per 60 s" and 120 requests admitted at the end of one window, **When** 120 more arrive right after the boundary, **Then** at most 2 are admitted during the first second (a fixed window would admit all 120), and each decision is one atomic call to the store.
2. **AS-77** — **Given** a denied request, **Then** the edge answers `429` with `Content-Type: application/problem+json` (fields `type`, `title`, `status`, `detail`), `Retry-After`, `RateLimit-Policy` and `RateLimit` in the same format as AS-37, and `Cache-Control: no-store`.
3. **AS-78** — **Given** an unreachable or slow store (no answer within 500 ms), **Then** the request is proxied (fail open), the edge records a counter and a log line, and it is not delayed by more than the timeout.
4. **AS-79** — **Given** a request with a verified user, **Then** the subject is the user id; **Given** none, **Then** the connecting address given by the CDN; **Given** neither, **Then** one shared `anonymous` subject.

---

### User Story 13 - The guarantee holds across the fleet (Priority: P1)

Whichever instances receive a burst, the limit holds.

**Why this priority**: The whole point of moving the limiter out of process memory.

**Independent Test**: Two application instances against one store; 100 parallel requests each.

**Acceptance Scenarios**:

1. **AS-80** — **Given** two application instances on one store and a token bucket "burst 100" without lease, **When** each receives 100 parallel requests for the same subject (200 in all), **Then** exactly 100 are allowed; **And** the same holds for a sliding window "100 per 60 s".
2. **AS-81** — **Given** two instances and a concurrency limit of 2, **When** each receives 10 parallel `acquire` calls for one subject, **Then** exactly 2 are acquired in total.

---

### Edge Cases

- **Concurrency**: parallel `check` (AS-01, AS-10), parallel `acquire` (AS-16, AS-81), two instances (AS-14, AS-23, AS-80), parallel failures with reservation (AS-56), stampede on a hot key (AS-21).
- **Idempotent replay**: replays consume budget (AS-47); `release`, `reset` and `refund` repeated safely (AS-18, AS-59).
- **Illegal transitions**: double or stale release (AS-18); penalizing an algorithm that cannot be paused (AS-63); invalid cost and penalty (AS-07, AS-61); a refund below zero or above capacity (AS-59).
- **Cross-tenant access**: a stranger cannot spend another shop's budget (AS-43); subject isolation (AS-49); no personal data in keys (AS-52).
- **Limits**: boundary of a window (AS-11, AS-12, AS-76); cost larger than the budget (AS-06); lowering or raising a policy (AS-83); key length (AS-53); fallback key bound (AS-29).
- **Timeouts and outages**: store timeout (AS-31), breaker (AS-30), recovery (AS-32), lost scripts (AS-33), extractor failure (AS-36), edge timeout (AS-78).
- **Pipeline order**: throttling after authentication, before validation, before idempotency replay (AS-41, AS-42, AS-47).
- **Not applicable here**: out-of-order or duplicate events (the limiter consumes no messages, so the consumer pair of VII.4 does not apply); HTTP create endpoints with `Idempotency-Key` of its own (the limiter has no write endpoints).

## Requirements *(mandatory)*

### Functional Requirements

**Algorithms and correctness**

- **FR-001**: A **token bucket** policy MUST hold a capacity equal to its `limit`, start full for a new subject, refill continuously at `limit` tokens per `windowMs`, never exceed its capacity, and take `cost` tokens per decision (AS-01, AS-02, AS-03, AS-05, AS-83).
- **FR-002**: A token-bucket denial MUST consume nothing and report the time until `cost` tokens will exist (`retryAfterMs`); an allowed decision reports `retryAfterMs: 0` (AS-02, AS-05).
- **FR-003**: `cost` MUST be a positive integer. A `cost` above the policy's `limit` MUST be denied with `reason: 'cost-exceeds-limit'` and `retryAfterMs: null`, changing nothing. On the HTTP surface the cost used is `max(1, ceil(value))` of the resolver's result (`1` for non-finite values) and a cost above the limit answers `422` (AS-06, AS-07).
- **FR-004**: A **sliding window counter** policy MUST estimate usage as `previousWindowCount × (1 − elapsedInWindow ÷ windowMs) + currentWindowCount`, admit a request only when `estimate + 1 ≤ limit`, and count a request only when it is admitted (AS-09, AS-11, AS-12).
- **FR-005**: A sliding-window denial MUST report as `retryAfterMs` the earliest delay after which the same request would be admitted if no other traffic arrived; waiting exactly that long admits it and waiting 1 ms less does not (AS-13).
- **FR-006**: A **concurrency** policy MUST admit at most `limit` unexpired leases per subject, with a lease length of `windowMs`; `acquire` returns a lease that `release()` frees (AS-15, AS-16, AS-17).
- **FR-007**: `release()` MUST be idempotent and MUST free only its own lease; expired leases MUST be pruned before counting, so a crashed holder frees its slot when its lease ends (AS-17, AS-18).
- **FR-008**: A denied `acquire` MUST report `retryAfterMs = clamp(timeUntilEarliestLeaseExpiry, 1000, 5000)` (AS-19).
- **FR-009**: Each decision MUST be one atomic step in the shared store, so that for any policy and subject the number of admitted units never exceeds the budget, whatever the number of instances and the concurrency (AS-01, AS-10, AS-16, AS-80, AS-81).
- **FR-010**: Decisions MUST use one time source shared by all instances: the shared store's clock. System clocks of application instances MUST NOT enter a decision. The time source MUST be replaceable in tests (AS-14).
- **FR-011**: Every stored item MUST carry an expiry bounded by the policy (token bucket: time-to-full plus 1 s; sliding window: two windows; concurrency: two lease lengths; pause: its length plus 1 s), no operation may enumerate keys with a blocking scan, and all item names MUST share the `rl:` prefix owned by this lib (AS-08, AS-52).
- **FR-012**: Scripts MUST be loaded once and invoked by digest; a "script not found" reply MUST be recovered by reloading and retrying once, without counting as a failure (AS-33).
- **FR-013**: All items of one decision MUST share one hash tag built from policy and subject (AS-73).

**Local leased budget**

- **FR-014**: A token-bucket policy MAY set `localLeaseFraction` in `(0, 0.5]`. An instance then takes `max(1, floor(limit × fraction))` tokens in one store call, spends them locally for at most 1 s, adds new leases to unexpired ones and never overwrites them; the sum admitted across the fleet never exceeds the budget and the shortfall is at most one unspent slice per instance (AS-21, AS-22, AS-23).
- **FR-015**: At most one refill per key MUST be in flight per instance; concurrent misses MUST wait for it and share its outcome (AS-21).
- **FR-016**: After a denial, an instance MUST answer further decisions for that key locally for `min(retryAfterMs, 1 s)` without store calls (AS-25).
- **FR-017**: Leases MUST NOT apply to a `cost` above 1, to a policy without a fraction, or to the other algorithms (AS-24).

**Fail modes**

- **FR-018**: Every policy MUST declare `failMode` as `open` or `closed` (no default) (AS-69).
- **FR-019**: A store call fails when it errors or gives no reply within `rate_limit_store_timeout_ms` (default 200 ms). A failure MUST NOT be retried inside the same decision (IV.6: retries live at one layer, and the caller's client retries on `429`/`503`) (AS-31).
- **FR-020**: Under **fail closed**, a failed decision is `allowed: false` with `reason: 'store-unavailable'` and `retryAfterMs: 1000`; code callers receive it as a return value, and HTTP answers `503` problem+json `rate_limiter_unavailable` with `Retry-After: 1` and a generic `detail` (V.3) (AS-26, AS-34, AS-35).
- **FR-021**: Under **fail open**, a failed decision MUST be served by an in-process fallback limiter: a token bucket of capacity `max(1, floor(limit ÷ rate_limit_fallback_instances))` refilling proportionally, charging the request's `cost`, retaining at most 50,000 subjects (least recently used evicted), and applying to token-bucket and sliding-window policies alike; for concurrency policies a per-process semaphore of `max(1, floor(limit ÷ rate_limit_fallback_instances))`. Its decisions carry `source: 'fallback'` and no `RateLimit` headers are sent (AS-27, AS-28, AS-29, AS-34).
- **FR-022**: A circuit breaker MUST open after `rate_limit_breaker_failures` (default 3) consecutive store failures, skip the store for `rate_limit_breaker_open_ms` (default 2000), then allow one probe; a successful probe closes it (AS-30, AS-32).
- **FR-023**: Errors raised by the limiter's own helpers (subject extractor, cost resolver, header formatting) MUST follow the policy's fail mode and MUST NOT surface as a raw `500`; a fail-open policy MUST never turn a limiter fault into a failed request (AS-36).
- **FR-024**: On recovery the limiter MUST resume from the store's state without resetting or double counting (AS-32).

**HTTP surface**

- **FR-025**: `@RateLimit(...)` MUST accept one or more policy names or option objects (`policy`, optional `cost`, `subject`, `failureStatuses`) and run as an interceptor: after authentication and role guards, before validation pipes, before the idempotency check (P0214; AS-41, AS-42, AS-47). All listed policies MUST allow the request; they are evaluated in declaration order.
- **FR-026**: When a later policy denies, the units already taken from earlier policies MUST be returned (refund, release) (AS-40).
- **FR-027**: A throttled or refused request MUST NOT run its handler, and no state changes (AS-44).
- **FR-028**: Allowed and denied responses of rate-limited routes MUST carry `RateLimit-Policy: "<name>";q=<limit>;w=<windowSeconds>` and `RateLimit: "<name>";r=<remaining>;t=<resetSeconds>`, one item per non-concurrency policy of the route in declaration order, formatted per AS-82; `429` and `503` MUST also carry `Retry-After` and `Cache-Control: no-store`; the `Retry-After` of a multi-policy denial is the largest of the denying policies' waits (AS-37, AS-38, AS-39, AS-82).
- **FR-029**: A `429` MUST be problem+json with `type`, `title`, `status`, `detail`, `instance`, `requestId`, `code: 'rate_limited'` and `retryAfterSeconds`; `detail` and every field MUST omit policy names and subjects (AS-37).
- **FR-030**: The rate-limit headers MUST be present on error responses produced by the handler or the exception filter for an admitted request; CORS preflight (`OPTIONS`) requests MUST NOT consume budget (AS-45, AS-46).
- **FR-031**: Throttling MUST run before the idempotency check, so a replay of a stored response consumes budget like any request (AS-47).
- **FR-032**: A request whose resolved cost exceeds the policy's limit MUST answer `422` problem+json `rate_limit_cost_exceeded` without `Retry-After` (AS-06).
- **FR-033**: A concurrency lease taken for a request MUST be released on every outcome: success, thrown error, and client abort (AS-20).
- **FR-034**: Requests that fail authentication or authorization before the interceptor runs MUST NOT consume any identity-keyed budget (AS-42, AS-43).

**Subjects and privacy**

- **FR-035**: A policy's `key` MUST be one of `ip`, `user`, `userOrIp`, `apiKey`, `shop`, `body.email`, or `custom` (a pure function of the request returning a string or nothing). Stored subjects MUST be typed (`ip:`, `user:`, `key:`, `shop:`, `email:`, `custom:`) and live inside the policy's namespace (AS-49, AS-53).
- **FR-036**: The client address MUST be the one resolved by the platform from the trusted proxy chain; the limiter MUST NOT read forwarding headers itself (AS-48).
- **FR-037**: When a user, API-key or shop policy meets a request without that identity, the limiter MUST use the client address and count `rate_limit_subject_fallback_total`; no request may bypass a policy for lack of an identity (AS-50).
- **FR-038**: The e-mail subject MUST be the SHA-256 of the trimmed, lower-cased value, truncated to 32 hex characters; stored items MUST never contain e-mails, tokens, passwords or API-key secrets (the API-key subject is the key's id) (AS-51, AS-52).
- **FR-039**: A custom subject longer than 128 characters MUST be replaced by its hash; an absent value falls back to the address (AS-53).

**Failure-only counting**

- **FR-040**: A policy MAY declare `count: 'failures-only'` with `resetOnSuccess: true`. The slot is **reserved at admission** (a normal decision), so concurrent attempts cannot all pass a pre-check (AS-54, AS-56).
- **FR-041**: After the handler, the slot is kept if the response status is in the policy's `failureStatuses` (default `401`, `403`); on a `2xx` with `resetOnSuccess` the whole counter is cleared; any other outcome, including a client abort, returns the slot (AS-55, AS-57).
- **FR-042**: The service MUST expose `refund(policy, subject, units = 1)` and `reset(policy, subject)` so code paths that are not one HTTP handler can follow the same rule; both are idempotent, create nothing for unknown subjects, and never push a counter below zero or a bucket above its capacity (AS-58, AS-59).

**Penalties**

- **FR-043**: `penalize(policy, subject, ms)` on a token-bucket policy MUST empty the bucket and pause it until now + `ms` for every instance; decisions during the pause are denied with `reason: 'paused'` and `retryAfterMs` equal to the remainder; after it the bucket refills from empty (AS-60).
- **FR-044**: A penalty MUST never shorten an existing pause, is capped at `rate_limit_penalty_max_ms` (default 1 hour), and an invalid `ms` throws `InvalidPenaltyError` (AS-61).
- **FR-045**: `penalize` MUST be best-effort: it returns `true` when stored and `false` on store failure, never throwing into the caller (AS-62).
- **FR-046**: `penalize` on another algorithm MUST throw `UnsupportedPenaltyError` (AS-63); the calling instance MUST drop its local lease for the subject and other instances stop within one lease lifetime (AS-64).

**Defaults, exemptions, declarations**

- **FR-047**: A route with neither `@RateLimit` nor `@RateLimitExempt(reason)` MUST be limited by `default.read` (safe methods) or `default.write` (others), keyed `userOrIp`, fail open; an explicit policy replaces the default (AS-66, AS-67).
- **FR-048**: The second limiter (a fixed-window throttler guard with its own store and its `Firewall` options) MUST be removed so there is one algorithm set, one set of headers and one fail-mode model (AS-66).
- **FR-049**: `@RateLimitExempt(reason)` MUST require a non-blank reason; startup MUST fail on a blank reason and MUST log the list of exempt routes once (AS-68).
- **FR-050**: Policies MUST be declared by their owning capability through the registry (`definePolicies` and the module's `forFeature`), never by editing a central table in this lib, and this lib MUST declare only `default.read` and `default.write` (constitution X.3; AS-70).
- **FR-051**: The registry MUST validate the full table at startup and report every offence at once (AS-69), reject a duplicate name naming both declaring modules (AS-70), and reject a decorator or code reference to an undeclared policy (AS-71); undeclared names in source MUST fail type checking (AS-72, P0113).
- **FR-052**: Policy names MUST follow `<area>.<name>[.<qualifier>…]` in lower-case letters, digits and hyphens (AS-69).
- **FR-053**: A policy name MUST be declared once; the capability that declares it owns it, and no other capability may reuse it (AS-70).

**Observability and operations**

- **FR-054**: The limiter MUST record the metrics of AS-74 and the logs of AS-75, with no personal data or secret in either.
- **FR-055**: The limiter MUST add no database access on the decision path and own no table (IX); its configuration (`rate_limit_store_timeout_ms`, `rate_limit_breaker_failures`, `rate_limit_breaker_open_ms`, `rate_limit_fallback_instances`, `rate_limit_lease_ttl_ms`, `rate_limit_penalty_max_ms`) MUST be validated at startup (VIII.5).
- **FR-056**: The module MUST export only the service, decorators, registry helpers, error classes and types (X.4); application services of other domains call it as an R1 exported provider.

**Edge worker**

- **FR-057**: The edge limiter MUST be a sliding window evaluated in one atomic store call, with a 500 ms timeout and fail-open behaviour (AS-76, AS-78).
- **FR-058**: The edge `429` MUST use the problem+json and header format of FR-028 and FR-029 (AS-77); its subject is the verified user id, else the CDN-provided connecting address, else `anonymous` (AS-79).

### Key Entities

- **Policy**: a named rule. Attributes: `name`, `algorithm` (`tokenBucket` | `slidingWindow` | `concurrency`), `limit`, `windowMs` (refill period, window, or lease length), `key` source, `failMode`, optional `localLeaseFraction`, optional `count` mode with `resetOnSuccess` and `failureStatuses`. Declared by its owner; validated at startup.
- **Subject**: the thing being limited, typed and namespaced by policy (`ip:…`, `user:…`, `key:…`, `shop:…`, `email:<hash>`, `custom:…`).
- **Decision**: `allowed`, `policy`, `limit`, `remaining`, `retryAfterMs` (number, or `null` when waiting never helps), `resetMs`, `source` (`store` | `local-lease` | `fallback`), and `reason` (`limit-exceeded` | `store-unavailable` | `cost-exceeds-limit` | `paused`) on a denial.
- **Lease** (concurrency): an unexpired slot with an identifier, expiring at a store-clock time; `release()` frees it.
- **Pause**: a store-side "do not admit until T" marker on a token-bucket subject, set by `penalize`.
- **Breaker**: per-instance state (closed, open until T, probing) over the store.
- **Exemption**: a route's explicit opt-out with a mandatory reason.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In a test of 2× the limit sent in parallel through 1, 2 and 4 instances, the admitted count never exceeds the limit (0 overshoot in all trials) and, for policies without a local lease, equals the limit exactly (AS-01, AS-10, AS-80).
- **SC-002**: A decision answered from a local lease adds less than 1 ms at the 99th percentile; a decision that needs the store adds at most one store round trip; the sustained decision rate of 100,000 per second is reached with at most 10% of decisions touching the store on hot keys.
- **SC-003**: With the store down, a fail-open route returns normal responses with no 5xx caused by the limiter, and a fail-closed route returns `503` within the store timeout plus 100 ms; after the first three failures no request waits for a timeout at all for 2 s at a time.
- **SC-004**: In 100% of single-client trials, a client that waits the `Retry-After` of a `429` and retries is admitted (AS-02, AS-13).
- **SC-005**: A hot key with a 10% lease causes at least 5× fewer store calls than requests (AS-21).
- **SC-006**: Exhausting one subject never changes another subject's remaining budget (0 interference in the isolation scenarios AS-04, AS-43, AS-49).
- **SC-007**: 100% of routes are either limited by an explicit policy, limited by the default, or exempt with a logged reason; 0 references to undeclared policies survive startup.
- **SC-008**: A burst straddling a window boundary admits at most the limit plus 2 requests in the second after the boundary (AS-11, AS-76), never `2 × limit`.
- **SC-009**: Parallel credential guesses against a failures-only policy admit exactly the limit (20 parallel attempts against 5 admit 5).

## Assumptions

- **Decision policy**: this is a portfolio showcase with no external clients; each open choice took the most production-grade option the notes and the constitution support. Choices that change today's behaviour are in `questions.md` tagged `[BREAKING]`.
- **Store**: the shared limiter store is the platform's shared in-memory data store, reached through `infrastructure/redis` (a client library, not a capability), with atomic server-side scripts and a server clock. It holds only limiter state; losing it resets limits and nothing else.
- **Header format**: the notes' example (`RateLimit-Policy: "default";q=100;w=60`, `RateLimit: "default";r=0;t=12`) is the contract. The older `RateLimit-Limit/-Remaining/-Reset` fields and `X-RateLimit-*` are dropped.
- **`503` for a closed outage**: the notes say fail-closed "rejects"; `429` would tell a client it exceeded a quota it did not, so `503` is used. The specs of S07, S15 and S30 already assume `503`.
- **Default limits**: `default.read` is a token bucket of 300 per 60 s and `default.write` of 60 per 60 s, per user or address, fail open, no lease. They are a floor against scraping and runaway clients, below every explicit policy a real endpoint needs; owners lift them by declaring their own.
- **Subject for the default**: user-or-address means a BFF forwarding many users' calls is bucketed by the forwarded user; anonymous traffic through a BFF is bucketed by the client address the BFF forwards through the trusted chain (S48's duty).
- **Unauthenticated floods** reaching a guard that rejects them (`401`) are not counted by interceptor-based limits; the edge limiter and an explicit per-address policy on the guard path (S42's `public-api.auth-failure.ip`) cover them.
- **Leaky bucket** is not provided (see Scope).
- **Lease numbers**: lease lifetime 1 s, denial memo up to 1 s, breaker 3 failures and 2 s, store timeout 200 ms, fallback fleet size 4, penalty cap 1 hour, concurrency retry hint capped at 5 s. All are configuration with these defaults, validated at startup.
- **Fallback fleet size** is a fixed configured estimate of the number of instances; the fallback limiter is a safety net, not a precise limiter.
- **Concurrency lease renewal** is not offered: a lease length must exceed the longest legitimate operation; a holder that outlives its lease is no longer counted. Capabilities with long jobs use their own fenced lease (S07, S49).
- **Policies for the edge** are two constants of the edge worker (120 per 60 s, fail open), not entries of the backend registry; the edge cannot import it.
- **Cost resolvers** read only the already-parsed request (params, query, body fields) and return a number; they must be pure, total and cheap, and run before validation so they must tolerate hostile input (AS-36).
- **Client-visible policy names**: names appear in `RateLimit` headers and are not secret.
- **Time in tests**: tests drive the store-time source and a fake application clock; there are no fixed sleeps.

## Cross-capability contracts

### Provides

Exported by `@app/infrastructure/rate-limit` (module, services, decorators, types); every other capability reads these names exactly.

- **`RateLimitModule.forRoot()`**: imported once per app; registers the service and the platform default limit (FR-047). **`RateLimitModule.forFeature(policies)`**: each owning capability registers its policy table (FR-050).
- **`definePolicies(owner, table)`**: typed declaration of a policy table (the `satisfies`/`as const` pattern, P0113). A policy has `{ algorithm, limit, windowMs, key, failMode, localLeaseFraction?, count?, resetOnSuccess?, failureStatuses? }`; `key` is one of `'ip' | 'user' | 'userOrIp' | 'apiKey' | 'shop' | 'body.email' | 'custom'`.
- **`RateLimiterService`** (R1 exported provider):
  - `check(policy, subject, cost = 1): Promise<RateLimitDecision>`: never throws for a denial or an outage; throws `InvalidRateLimitCostError` for a malformed cost.
  - `acquire(policy, subject): Promise<{ acquired: true; release(): Promise<void>; decision: RateLimitDecision } | { acquired: false; decision: RateLimitDecision }>`.
  - `refund(policy, subject, units = 1): Promise<void>` and `reset(policy, subject): Promise<void>`.
  - `penalize(policy, subject, ms): Promise<boolean>`; throws `UnsupportedPenaltyError` or `InvalidPenaltyError`.
  - `RateLimitDecision = { allowed: boolean; policy: string; limit: number; remaining: number; retryAfterMs: number | null; resetMs: number; source: 'store' | 'local-lease' | 'fallback'; reason?: 'limit-exceeded' | 'store-unavailable' | 'cost-exceeds-limit' | 'paused' }`. For a caller that needs only `{ allowed, retryAfterMs }` those two fields suffice.
  - `subject` is a string the caller builds from its own identifiers (user id, credential id, provider, model, shop id plus device id, …); it must not contain secrets or e-mails.
- **`@RateLimit(...policies)`** where each argument is a policy name or `{ policy, cost?: (req) => number, subject?: (req) => string | undefined, failureStatuses?: number[] }`; **`@RateLimitExempt(reason: string)`**.
- **Errors and problem codes**: `Domain_RateLimitedError` (`429`, `rate_limited`), `Domain_RateLimiterUnavailableError` (`503`, `rate_limiter_unavailable`), `Domain_RateLimitCostExceededError` (`422`, `rate_limit_cost_exceeded`), `InvalidRateLimitCostError`, `InvalidPenaltyError`, `UnsupportedPenaltyError`.
- **Response headers**: `Retry-After`, `RateLimit`, `RateLimit-Policy` as in FR-028.
- **Platform policies**: `default.read`, `default.write`.
- **Metrics**: `rate_limit_decisions_total`, `rate_limit_check_duration_seconds`, `rate_limit_store_unavailable_total`, `rate_limit_breaker_state`, `rate_limit_subject_fallback_total`, `rate_limit_penalties_total` (labels per AS-74). A capability that wants its own counter name for "limiter unavailable" (S24's `chat_limiter_unavailable_total`) derives it from `rate_limit_store_unavailable_total` filtered by its policy prefix.
- **Guarantees**: a decision is atomic and fleet-wide exact (FR-009); the limiter adds no database access; a fail-open policy never converts a limiter fault into a failed request; a throttled request never runs its handler.
- **Contracts asked by other specs and honoured**: failure-only counting with reset on success (S01 `auth.login.account`, S02 `auth.mfa.account`); per-request `cost` (S42 `public-api.default`, S46 `llm.provider.tpm`, S47, S48 `bff.graphql.cost`); `penalize` (S08); `check(policy, subject)` with `{ allowed, retryAfterMs }` (S28 send budgets, S08); fail mode per policy; `Retry-After` and `RateLimit-*` on `429` (every capability); fail-closed `503` (S07, S15, S30). Deviations from other specs are in `questions.md` as `[CONTRACT]` lines (the policy registry is no longer one file in this lib; the guard-level `Firewall({ skipThrottle, throttle })` options go away).

### Requires

- **S54 (platform toolkit)**: (1) the exception filter that renders `AppError` subclasses as problem+json with `type`, `title`, `status`, `detail`, `instance`, `requestId`, plus extension members; `code` for the three problem codes above; (2) a resolved client address on the request that honours the trusted proxy chain (origin S01 FR-014) and ignores untrusted forwarding headers; (3) CORS `Access-Control-Expose-Headers` listing `Retry-After`, `RateLimit` and `RateLimit-Policy` (today present in the bootstrap); (4) the metrics registry and structured logger with `requestId`; (5) startup configuration validation for the keys of FR-055; (6) global interceptor ordering such that the default limit and `@RateLimit` run after guards and before pipes and before the idempotency interceptor; (7) the idempotency facility's replay marker (`Idempotency-Replayed`, already in the bootstrap's CORS exposure list) for AS-47.
- **S01 (auth)**: guards that populate `request.user` (`id`) and `request.apiKey` (`id`, `shopId`) before interceptors run; the anonymous-route marker; removal of `Firewall({ skipThrottle, throttle })` in favour of `@RateLimitExempt` and `@RateLimit`; authentication before throttling (S01 FR-018).
- **S42 (public API)**: sets `request.apiKey` as above for API-key policies.
- **Shared store client** (`infrastructure/redis`, no capability ID): `eval` and `evalsha` with an explicit per-call timeout, script loading, the server clock command, and key deletion; health owned by S54.
- **Owning capabilities** (S01–S48): each declares its own policies through `forFeature`; the names and numbers they require are in their specs and listed in `gaps.md`.

## Pattern coverage (pattern-map rows whose Specs column names S50)

| Pattern | Where it is a requirement and a scenario |
|---|---|
| **P0113** `satisfies` / `as const` policy tables | FR-050, FR-051, FR-052; AS-69, AS-70, AS-71, AS-72 |
| **P0214** Nest request lifecycle placement (guards → interceptors → pipes → filters) | FR-025, FR-031, FR-034, FR-047; AS-41, AS-42, AS-43, AS-47, AS-66 |
| **P0327** Rate limiting in Redis (Lua): atomic scripts, single clock, key expiry, hash tags | FR-009 to FR-013; AS-01, AS-10, AS-14, AS-33, AS-52, AS-73, AS-80 |
| **P0416** Rate limiting as provider (algorithms, `RateLimit` headers, 429) | FR-001 to FR-008, FR-028, FR-029; AS-01 to AS-20, AS-37 to AS-39, AS-76, AS-77 |
