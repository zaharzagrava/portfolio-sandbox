# Test Plan: S50 — Distributed rate limiter (domain `infrastructure`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md) (83 scenarios, AS-01 to AS-83). A dash means the layer does not test that scenario. Each scenario is proven once, at the lowest layer that can prove it.

- **API e2e** files live in `packages/backend/libs/infrastructure/rate-limit/` unless a path is given. S50 has no HTTP endpoint of its own. Its HTTP surface is the interceptor and default limit on other routes, so each file boots a Nest app from the real `RateLimitModule` with the production pipe, filter, prefix and interceptors, plus a small **test controller module** (test code only) with routes that carry each policy shape: `GET /probe/token`, `POST /probe/login` (failures-only), `POST /probe/slow` (concurrency), `POST /probe/idempotent`, `GET /probe/shop/:shopId`, `GET /probe/plain` (default limit), `GET /probe/exempt`. They run against the real test Redis of `docker-compose.test.yaml` and assert the response **and** the stored state (keys, expiries, counters) in every test. The limiter's store clock is driven through the injectable time source (FR-010); application clocks are frozen separately; no fixed sleeps.
- **Store outage** cases break the connection of the Redis client under test (stop-the-connection helper, not a mock of the lib's own code); **store timeout** (AS-31) uses a paused server (`CLIENT PAUSE`); **lost scripts** (AS-33) use `SCRIPT FLUSH`.
- **Concurrency rows** use `Promise.all` over the limiter (and, for "several instances", over two Nest apps on the same Redis: AS-14, AS-23, AS-64, AS-60, AS-80, AS-81).
- **VII.3 mandatory cases**: happy path (AS-38), validation failures (AS-41), `401` (AS-42), cross-tenant (AS-43, AS-49), rate limit `429` (AS-37), concurrency (AS-01, AS-10, AS-16, AS-56, AS-80, AS-81), idempotency (AS-47). No state-transition endpoint exists. No async consumer exists, so the VII.4 pair does not apply.
- **Unit** specs sit beside the code, are table-driven (`it.each`), and cover only pure logic: cost and header formatting, subject derivation, policy validation, key building, the in-process fallback limiter. Time is an argument, never read. No unit tests for the service, interceptor, scripts or glue. The type-level check (AS-72) is a compile-time test.
- **UI journeys**: none. S50 has no UI. A web client's handling of `429` belongs to the web capabilities' journeys.
- **Static gates** (VII.1): `tsc --noEmit` strict and ESLint for `packages/backend` and `packages/edge-be`; `pnpm --dir packages/backend check:boundaries`; `pnpm --dir packages/backend check:table-ownership --strict`.
- **Load proof** of SC-001, SC-002 and SC-005 (`pnpm loadtest:ratelimit`, k6 at 2× the limit across 1, 2 and 4 instances; p99 overhead; store-call ratio on a hot key) is an operations artifact, not an e2e row.

e2e files:

| Short name | File |
|---|---|
| TB | `token-bucket.e2e-spec.ts` |
| SW | `sliding-window.e2e-spec.ts` |
| CONC | `concurrency-limit.e2e-spec.ts` |
| LEASE | `local-lease.e2e-spec.ts` |
| FAIL | `fail-modes.e2e-spec.ts` |
| HTTP | `rate-limit-http.e2e-spec.ts` |
| SUBJ | `rate-limit-subjects.e2e-spec.ts` |
| FONLY | `failure-counting.e2e-spec.ts` |
| PEN | `penalize.e2e-spec.ts` |
| REG | `rate-limit-registry.e2e-spec.ts` |
| OBS | `rate-limit-observability.e2e-spec.ts` |
| FLEET | `rate-limit-fleet.e2e-spec.ts` |
| EDGE | `packages/edge-be/src/rate-limit.spec.ts` (worker `fetch` handler against a fake edge store, the system edge) |

Unit files: `cost.spec.ts`, `fallback-limiter.spec.ts`, `rate-limit-headers.spec.ts`, `subject.spec.ts`, `policy-validation.spec.ts`, `policy-names.type-spec.ts`, `policy-keys.spec.ts`.

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 burst 10, 50 parallel → exactly 10 allowed | TB | — | — |
| AS-02 refill: one token after one interval; retry delay in (0, 6000] | TB | — | — |
| AS-03 idle bucket never exceeds capacity | TB | — | — |
| AS-04 subjects and policies independent | TB | — | — |
| AS-05 weighted cost; denial consumes nothing | TB | — | — |
| AS-06 cost above limit: permanent denial, HTTP `422`, no `Retry-After` | HTTP | — | — |
| AS-07 cost normalization and invalid cost errors | — | — | `cost.spec.ts` |
| AS-08 token-bucket state has bounded expiry | TB | — | — |
| AS-09 sliding window 5 per 15 min, sequence of six | SW | — | — |
| AS-10 200 parallel against 100 → exactly 100 | SW | — | — |
| AS-11 window boundary: none admitted in the first second | SW | — | — |
| AS-12 previous window weighs 50% → 5 admitted | SW | — | — |
| AS-13 `retryAfterMs` exact: admitted at R, denied at R-1 | SW | — | — |
| AS-14 two instances with skewed clocks share one budget | SW | — | — |
| AS-15 concurrency limit 2: third denied, release frees | CONC | — | — |
| AS-16 20 parallel acquires on limit 2 → exactly 2 | CONC | — | — |
| AS-17 crashed holder: slot returns at lease expiry | CONC | — | — |
| AS-18 double release and stale release harmless | CONC | — | — |
| AS-19 concurrency retry hint clamp 1–5 s | CONC | — | — |
| AS-20 route lease released on success, 500, 422, abort | CONC | — | — |
| AS-21 hot key: ≤ 60 and ≥ 54 allowed, ≤ 40 store calls | LEASE | — | — |
| AS-22 lease expires after 1 s; unspent tokens dropped | LEASE | — | — |
| AS-23 two instances on one hot key: 48–60 allowed | LEASE | — | — |
| AS-24 no lease for cost > 1, fraction 0, other algorithms | LEASE | — | — |
| AS-25 denial memo: local denials, then store again | LEASE | — | — |
| AS-26 fail-closed outage → `503`, handler not run | FAIL | — | — |
| AS-27 fail-open outage → served, counter +1, no headers | FAIL | — | — |
| AS-28 fallback limiter wiring: 15 served then `429` | FAIL | — | — |
| AS-29 fallback arithmetic: capacity, cost, refill, 50,000-subject bound | — | — | `fallback-limiter.spec.ts` |
| AS-30 breaker: 3 failures, 2 s of zero store calls, one probe | FAIL | — | — |
| AS-31 store timeout → failure path within timeout + 100 ms | FAIL | — | — |
| AS-32 recovery continues from stored counters | FAIL | — | — |
| AS-33 lost scripts reloaded transparently | FAIL | — | — |
| AS-34 concurrency fail modes (closed `503`; open semaphore of 1) | FAIL | — | — |
| AS-35 code callers get `reason: 'store-unavailable'`, no throw | FAIL | — | — |
| AS-36 extractor or cost resolver throws → fail mode, never `500` | FAIL | — | — |
| AS-37 `429` problem+json, headers, `no-store`, handler not run | HTTP | — | — |
| AS-38 success headers; remaining decrements | HTTP | — | — |
| AS-39 two policies: both listed, larger `Retry-After` | HTTP | — | — |
| AS-40 denial by a later policy refunds earlier policies | HTTP | — | — |
| AS-41 `429` before `400`; under limit `400` costs one unit | HTTP | — | — |
| AS-42 `401` consumes no budget | HTTP | — | — |
| AS-43 stranger cannot spend another shop's budget | HTTP | — | — |
| AS-44 throttled request has no side effect | HTTP | — | — |
| AS-45 handler error responses keep rate-limit headers | HTTP | — | — |
| AS-46 `OPTIONS` preflight not counted | HTTP | — | — |
| AS-47 idempotent replays consume budget | HTTP | — | — |
| AS-48 rotating forwarding headers do not bypass the limit | SUBJ | — | — |
| AS-49 user, key, shop isolation | SUBJ | — | — |
| AS-50 missing identity → address subject, counter +1 | SUBJ | — | — |
| AS-51 e-mail subject normalization and hashing | — | — | `subject.spec.ts` |
| AS-52 no secret or e-mail in any key; every key expires | SUBJ | — | — |
| AS-53 custom subject length and fallback | — | — | `subject.spec.ts` |
| AS-54 6th attempt with correct credential is `429` | FONLY | — | — |
| AS-55 success clears the counter | FONLY | — | — |
| AS-56 20 parallel wrong attempts on limit 5 → exactly 5 reach handler | FONLY | — | — |
| AS-57 only failure statuses keep the slot | FONLY | — | — |
| AS-58 shared counter across code paths with `refund` and `reset` | FONLY | — | — |
| AS-59 `reset` and `refund` on empty state, bounds | FONLY | — | — |
| AS-60 `penalize` pauses every instance; other subjects unaffected | PEN | — | — |
| AS-61 penalty monotonic, capped, invalid values rejected | PEN | — | — |
| AS-62 `penalize` best-effort when store down | PEN | — | — |
| AS-63 `penalize` on unsupported algorithms throws | PEN | — | — |
| AS-64 lease dropped locally; others stop within 1 s | PEN | — | — |
| AS-65 no burst after a pause | PEN | — | — |
| AS-66 default limit on undeclared routes | REG | — | — |
| AS-67 explicit policy replaces the default | REG | — | — |
| AS-68 exempt routes unlimited; blank reason fails boot; list logged | REG | — | — |
| AS-69 policy table validation, all offences reported | — | — | `policy-validation.spec.ts` |
| AS-70 duplicate policy name fails boot, both modules named | REG | — | — |
| AS-71 undeclared policy on a route fails boot | REG | — | — |
| AS-72 undeclared policy name fails type checking | — | — | `policy-names.type-spec.ts` |
| AS-73 one hash tag per decision | — | — | `policy-keys.spec.ts` |
| AS-74 metrics for every path | OBS | — | — |
| AS-75 breaker transition logs; sampled, redacted denial logs | OBS | — | — |
| AS-76 edge window boundary; one atomic call | EDGE | — | — |
| AS-77 edge `429` shape | EDGE | — | — |
| AS-78 edge fail open on slow or down store | EDGE | — | — |
| AS-79 edge subject choice | EDGE | — | — |
| AS-80 two instances, 200 parallel, limit 100 → exactly 100 | FLEET | — | — |
| AS-81 two instances, concurrency 2 → exactly 2 | FLEET | — | — |
| AS-82 header and wait formatting rules | — | — | `rate-limit-headers.spec.ts` |
| AS-83 lowering or raising a policy clamps state | TB | — | — |
