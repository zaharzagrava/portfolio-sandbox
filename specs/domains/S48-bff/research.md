# Research: S48 BFF composition

Decisions that were not fixed by `spec.md` or `questions.md`. Each was checked against the code on 2026-10-10.

## R-1 One upstream layer instead of `CoreClient`
- **Decision**: `UpstreamClient.call(endpoint, params, ctx)` over `ResilientHttpClient`, one client instance per upstream capability name (`bff-product`, `bff-shop`, …), endpoints declared as data per capability.
- **Rationale**: X.8.2 wants typed clients validated by contracts; A8/A12 want one place where identity and headers are decided; per-capability client names give per-upstream metrics and pools.
- **Alternatives**: keep `CoreClient` with a schema argument (still one untyped bag of paths, no identity policy); hand-write a class per capability (more code, same behaviour).
- **Verified**: `ResilientHttpClient` follows no redirects (class doc), takes `signal`, `timeoutMs`, `maxAttempts`, `breaker: false`, `headers`, has a 1 MiB response cap, and pools with keep-alive. A test (T-U4) proves redirects and pooling at the BFF boundary; a fix in the shared client would be recorded as an S54 follow-up.

## R-2 Breaker and gate are BFF-local pure classes
- **Decision**: `circuit-breaker.ts` (5 consecutive failures within 10 s, open 10 s, one probe) and `concurrency-gate.ts` (100 per upstream, 12 per request) in the BFF; the shared client is created with `breaker: false` and a `maxConcurrent` above the gate.
- **Rationale**: `@app/common/resilience` is rate-based (minimum calls, failure rate); the spec's AS-17 is consecutive-failure with exactly one probe, and the section must report `CIRCUIT_OPEN` vs `UPSTREAM_OVERLOADED` distinctly. One breaker layer only (IV.6).
- **Alternatives**: configure the shared breaker (`minimumCalls: 5`, threshold 1.0, `halfOpenCalls: 1`) — close but counts a window, not consecutive failures, and is not unit-testable under U3 as the spec's table requires.
- **Failures that count**: timeouts, resets, 5xx, invalid bodies; not 404, 429-as-caller-error, aborts caused by the page itself (required failure, deadline of another section).

## R-3 Client address for identity calls
- **Decision**: read `req.clientIp` (set by `configureHttpApp` from `trusted_proxies`) and send it as the last element of `X-Forwarded-For` to S01/S02; never copy the inbound header.
- **Rationale**: the bootstrap already resolves the address; importing `@app/infrastructure/platform` from the composition lib is outside the X.8.4 allowlist, so the lib reads the request property only. AS-46 asserts an untrusted client-supplied header is ignored.
- **Sibling**: S01 must trust the BFF peer (R-11).

## R-4 Session encryption and keys
- **Decision**: AES-256-GCM, 12-byte random nonce, record = `kid.nonce.ciphertext.tag` (base64url), key ring of at most two keys (`bff_session_keys`, first encrypts, all decrypt), `kid` = first 4 bytes of the key's SHA-256. Store key = `bff:sess:` + SHA-256(cookie value) hex. CSRF MAC key is a separate secret (`bff_csrf_key`).
- **Rationale**: AS-43 requires the stored bytes to contain neither token; rotation needs two keys (questions.md). Node `crypto` only, no new dependency.
- **Alternatives**: Redis-side encryption (not available), signing only (leaks tokens on store leak).

## R-5 CSRF token shape
- **Decision**: cookie `__Host-bff-csrf` = `base64url(random16) + "." + base64url(HMAC-SHA256(csrfKey, sessionKey + "." + random16))`; the header must equal the cookie bytes (double submit) *and* the MAC must verify against the session of the session cookie; compare with `timingSafeEqual`. Issued at login/MFA success and re-issued on `GET /session` when absent.
- **Rationale**: AS-59 "issued for another session" is only detectable with a binding; the double-submit match stops cookie-injection from a sibling subdomain, which `__Host-` already blocks.

## R-6 Origin and CSRF rules
- **Decision**: login and `mfa` check `Origin` against `bff_allowed_origins` (exact match, scheme+host+port); with no `Origin`, accept only if `Sec-Fetch-Site` is `same-origin`/`same-site`/`none` or absent *and* the request is not cookie-bearing (login has no session cookie to protect). Cookie-authenticated `POST` (logout, GraphQL `POST`) additionally requires the CSRF token. Bearer-only and `GET` are exempt.
- **Rationale**: spec FR-043. GraphQL `POST` with cookie and a persisted query is still a state-capable channel in principle; protecting it is cheap and AS-42 requires it.

## R-7 Refresh single flight across instances
- **Decision**: Redis `SET NX PX 5000` lock per session key with an owner token; losers poll the record for a higher `tokenVersion` (25–50 ms, ≤ 3 s). The record write is a Lua compare-version-and-set so a slow holder can never overwrite a newer record.
- **Risk accepted**: if the holder dies after S01 rotated but before the write lands, the next refresh presents a spent token; S01 has no grace, the family is revoked and the user signs in again (fail closed, AS-57). The lock lease (5 s) exceeds the refresh timeout (2 s) plus 3 write attempts.
- **Alternatives**: pub/sub wake-up (more moving parts, and IV.3 limits pub/sub to a realtime backplane); `DistributedLock` from `cache` (not in the narrow allowlist use planned; same semantics).

## R-8 Shaped cache and single flight
- **Decision**: cache the *validated body* of public sections for `min(s-maxage, 30 s)`; key from the final URL (path + query) and endpoint name; single flight in process via a promise map, across instances via the Redis entry. Eligible: product, shop (batch item), recommendations, trending, discussions, videos, flash sale, auction, pickup (only if it answers shared-cacheable); never flags, chat, or any call that carried `Authorization`.
- **Rationale**: FR-011. Product is called with no identity (spec A8) so it is shareable; AS-20 requires 50 visitors → 1 call per public upstream.
- **Redis down**: cache errors are treated as a miss (cache is never the source of truth, III.9); asserted in a P test.

## R-9 GraphQL: where each limit runs
- **Decision**: Express middleware on `/api/graphql` does everything that needs the raw request (media type 415, content length / buffered bytes 413 before parse, array body 400, GET rules, hash verification and trusted-document lookup). Validation rules inside Apollo do depth/cost/root fields/introspection. A `didResolveOperation` Apollo plugin charges the cost rate limit and sets the operation deadline.
- **Rationale**: rejections must precede any resolver (zero upstream calls); the custom rules must not loop on fragment cycles, so the estimator keeps a visited set and the `NoFragmentCycles` result is reported as a validation error.
- **Open point checked at implementation**: Apollo's body parser may run before the middleware; if so the 413 check uses `Content-Length` plus a streaming cap in a dedicated `json({limit: '8kb'})` mounted for the path ahead of Apollo.

## R-10 Money scalar
- **Decision**: custom scalar `MinorUnits` serialized as a decimal string, parsed from string or integer; `currency: String`. `price: Float` removed per questions.md (BREAKING accepted). The persisted `ProductScreen` document and its hash change in the same task.
- **Rationale**: JS `number` is lossless only to 2^53; III.8.

## R-11 What S01/S02 must accept (sibling follow-up)
- **Decision**: no S01/S02 code change here. Recorded in `gaps.md` "Sibling-spec follow-ups": treat the BFF's peer as a trusted proxy, accept body-token refresh, no cookie delivery. If S01 is not yet configured that way the e2e uses a stub identity service, and the production config key (`trusted_proxies`) is operations work.

## R-12 Playwright and web work
- **Decision**: the BFF side is complete when contracts and endpoints are tested; web changes are limited to what the BFF contract forces (no bearer in memory, session client, rewrites, `priceMinor`). Screens, navbar and recovery-code prompts are W01/W02.

## R-13 Clock and randomness
- **Decision**: pure modules take `now: number`; services inject `Clock` from `@app/common/core/clock`; jitter takes a `RandomSource`-style function so tests are deterministic. `check:no-wallclock` stays green.

## R-14 Items I could not settle from the repo (carry into tasks as verify-first steps)
1. Whether Nest's `ZodValidationPipe` helper for contracts exists in `@app/common`; if not, validate with `schema.parse` in a pipe local to the BFF.
2. Whether `@app/infrastructure/rate-limit` exports `headersFor`/`formatRetryAfter`; the GraphQL cost path needs the structured headers (`RateLimit`, `RateLimit-Policy`, `Retry-After`). If not exported, add the export to the rate-limit barrel (a code change, not a spec edit) and list it as an S50 sibling follow-up.
3. Which of the upstream capabilities (S38, S25, S19, S11, S21, S30, S24) already publish a schema in `packages/contracts`; today only S05, S34, S35 and auth do. Missing ones are added in `bff/upstream.ts` and listed in `gaps.md` so the owners adopt them.
