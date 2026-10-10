# Implementation Plan: S48 — BFF composition (product page, GraphQL, browser session)

**Branch**: `S48-bff` (working branch `sdd/auto`) | **Date**: 2026-10-10 | **Spec**: [spec.md](spec.md)

**Input**: `spec.md` (AS-01–AS-64, FR-001–FR-052, SC-001–SC-009), `test-plan.md`, `gaps.md` (C1–C4, A1–A13, G1–G10, S1–S5, T1–T8, the debt table), `questions.md` (defaults accepted as written; no line was edited by a human), the constitution, and the follow-ups left by S01, S02, S05, S10, S13, S32, S34, S35 and S50 (below).

## Summary

`libs/composition/bff` is rebuilt as four cooperating slices that share one upstream layer. Nothing in it owns data (X.8.1); the only state it writes is the Redis session store and the shaped-response cache.

1. **Upstream layer** (`upstream/`): every domain call is a declared *endpoint* (method, path builder, contract schema, budget, identity need, shared-cache eligibility, `retry` flag) grouped per owning capability. One `UpstreamClient.call()` is the only code that touches `ResilientHttpClient`: it locks the origin to `bff_upstream_url`, never follows redirects, attaches identity only when the endpoint declares it, forwards only the headers on an allowlist, validates the body with the endpoint's schema, classifies failures into the closed code set (`UPSTREAM_TIMEOUT … BUDGET_EXCEEDED`) and runs the per-upstream breaker and bulkhead. It replaces `CoreClient` (C2–C4, A8, A12, S4).
2. **Product-page aggregate** (`page/`): a section *registry* (11 entries incl. `product`), a two-wave runner (wave 0 = product + every section that needs only the product ID, wave 1 = `shop`, `trending` when the product answers), a 1,000 ms page deadline, per-section budgets `min(own, time left)`, abort on required failure, shared cache + single flight for public sections, `Server-Timing`, metrics. Problem+json for required failures, `{section, code, retryable}` for optional ones (A1–A13).
3. **GraphQL** (`graphql/`): read-only schema with `priceMinor` (string scalar) + `currency`; per-request loaders created in the Apollo context (not request-scoped providers); a validation-phase *limits* rule (depth, cost with variables, root fields, cycle-safe fragments) and a pre-parse HTTP guard (size, media type, array batching, trusted documents with hash verification, `GET` by hash); operation deadline; cost-based rate limit; error formatter with stable codes; schema snapshot (G1–G10).
4. **Session (token handler)** (`session/`): `SessionService`, Redis `SessionStore` (key = SHA-256 of cookie value, AES-256-GCM record), `CsrfService` (keyed MAC bound to the session), origin check, `RefreshCoordinator` (single flight per session across instances, never retried), `IdentityClient` (S01/S02 relay with `X-Forwarded-For`), controller `POST/GET /api/bff/session`, `/mfa`, `/logout`; a request-credential resolver shared by the page and GraphQL (`400 ambiguous_credentials`, session → bearer, `401 session_expired`, `503 session_unavailable`) (S1–S3, S5).

Contracts go to `packages/contracts/src/bff/` (page, session, GraphQL error codes) plus the upstream schemas no sibling has published yet (flags, chat unread page, board posts page, pickup page, flash-sale, auction, videos). Configuration moves to a joi-validated `bff-config.ts` (no default upstream).

## Technical Context

**Language/Version**: TypeScript (strict), NestJS, `@nestjs/graphql` + Apollo (kept), Zod in `packages/contracts`
**Primary Dependencies**: `@app/infrastructure/http-client` (`ResilientHttpClient`: undici pool, no redirects), `@app/infrastructure/redis` (session store, locks, Lua), `@app/infrastructure/cache` (`single-flight`/`cache-control` helpers if exported; otherwise own pure `shared-cache-policy.ts`), `@app/infrastructure/rate-limit` (`definePolicies`, `RateLimitModule.forFeature`, `@RateLimit`, `RateLimiterService.check(policy, subject, cost)`), `@app/infrastructure/net` (origin-lock helper if useful), `@app/common/{config,core/clock,telemetry,errors,exceptions-filter,request-context,resilience}`. `apps/bff` may additionally import `@app/infrastructure/platform` (bootstrap, client address in `req.clientIp`).
**Storage**: Redis only. Key prefixes owned here: `bff:sess:{sha256}`, `bff:mfa:{sha256}`, `bff:mfa-lock:{sha256}`, `bff:refresh:{sha256}`, `bff:cache:{section}:{hash}`. No Postgres, Kafka, SQS, outbox (AS-64).
**Testing**: jest e2e through `/opt/sdd/repo/scripts/sdd/test-spec.sh` (files P, G, S, B of `test-plan.md`), unit specs U1–U7 beside the code; stubs of the domain APIs are real loopback HTTP servers (one per upstream host/capability) serving fixtures parsed with the contract schemas
**Target Platform**: Linux, `apps/bff` (existing deployable, X.8; no new app, I.6 not triggered)
**Project Type**: backend composition lib + small web consumer changes (`packages/web/lib/api`)
**Performance Goals**: page deadline 1,000 ms; GraphQL operation 2,000 ms; keep-alive reuse (≤ 10 connections per upstream over 30 requests); 50k page rps with one dependency at 2 s is an ops artifact (SC-008)
**Constraints**: budgets/limits are the spec Assumptions numbers, all configuration keys with those defaults; no retry except the product call (once); session writes ≤ 3 attempts; refresh never retried
**Scale/Scope**: 11 page sections, 12 calls per page max, 100 in flight per upstream per instance, 20 root fields, depth 6, cost 2,000, 8 KB documents

**Connection arithmetic (III.12)**: not applicable, the BFF opens no database connection. Redis: the shared client. Upstream pool: `ResilientHttpClient` allows 128 connections per client; one client per upstream host name, 100 admitted calls per upstream by the BFF gate stays below it.

**Maximum staleness accepted (IX.7)**: R2 only, no read model. Shared cache ≤ 30 s and never longer than the upstream `s-maxage`; trusted-document `GET` shared copy 5 s.

## Constitution Check

| Gate | Status | How |
|---|---|---|
| 1 Boundaries (I, X, no `forwardRef`, no `Scope.REQUEST`) | PASS after work | composition has no layered `api/application/domain/infra` (X.8 defines its own shape); files split by slice; pure logic (cost estimator, breaker, gate, cache policy, CSRF MAC, lifetime math, chunking) takes a clock/`now` and imports no Nest/Redis; loaders live in the Apollo context (AS-64 grep + `check:no-request-scope`); `apps/bff` stays bootstrap + module list |
| 2 Controllers (II.1) | PASS after work | controllers parse (Zod/`ZodValidationPipe`), call one service, return a DTO; cookies/headers set through one `SessionCookies` helper; HTTP-shaped errors only from the global filter (`BffProblem` → filter); no `try/catch` building responses |
| 3 Data access (III) | N/A / PASS | no Postgres; `.tx.baseline` = 0 and no `sequelize.transaction` exists in `libs/composition` (grep 2026-10-10), none added; money is `priceMinor` integer (III.8); every Redis key has a TTL (III.9), no `KEYS`; session store is not cache data (no `allkeys-*`) |
| 4 Migrations (III.11) | N/A | no schema |
| 5 Messaging (IV.4–IV.6) | PASS after work | no events (X.8.4); every outbound call has an explicit timeout; retries only for the idempotent product `GET`, once, full jitter, in one layer (`maxAttempts: 1` on the client, retry in `page/`); identity headers are never trusted from the client (IV.7); tokens go only to the configured `aud` origin; upstream responses are validated (IV.8) |
| 6 Contracts (V) | PASS after work | `productPageResponseSchema`, session schemas, GraphQL code enum, upstream schemas in `packages/contracts/src/bff/`; every error is problem+json from the global filter with `code` and `requestId`, generic `detail` on 5xx (V.3); `GET` changes no state; BFF creates no order/payment/booking/bid/ledger movement so no `Idempotency-Key` route (V.6); additive-only schema snapshot (V.7) |
| 7 Web (VI) | PASS after work | browser session is an HttpOnly `__Host-` cookie + CSRF (VI.2); `lib/api/graphql.ts` stops reading a token; session calls only in `lib/api/session.ts`; no business rule in BFF (VI.9, AS-64) |
| 8 Tests (VII) | PASS after work | 64 scenarios mapped in `test-plan.md`; e2e boot the production module pipeline (T1); every fallback forced (AS-12, 13, 17, 18, 19, 37, 56, 57, 61); no wall-clock timing asserts (T2) |
| 9 Operational (VIII) | PASS after work | structured logs with `requestId`, no token/cookie/email/upstream body (AS-23); readiness = startup/shutdown only (AS-61); config validated at startup (AS-39, AS-63); session keys from env/secret store |
| 10 DB isolation (IX) | PASS | zero ownership rows for `composition` (debt table in `gaps.md`); no model, no SQL; R2 only; `check:table-ownership --strict` is run and recorded |
| 11 Monorepo (X) | PASS after work | imports limited to the X.8.4 allowlist (`http-client`, `net`, `cache`, `redis`, `rate-limit`) + `@app/common/*` + contracts; `check:boundaries` green; `CoreClient` removed |

**Complexity Tracking**: none. Two choices that look like exceptions are not: (a) a small in-process breaker and gate in `libs/composition/bff` instead of the shared client's rate-based breaker, because the spec fixes *consecutive* failures, a one-probe half-open and per-section reporting (`CIRCUIT_OPEN` vs `UPSTREAM_OVERLOADED`); the shared client is created with `breaker: false` so there is one breaker layer (IV.6). (b) Redis locks for refresh/MFA are `SET NX PX` + compare-and-delete scripts through `RedisService`, not `DistributedLock` from `cache`, to keep the allowlist narrow and the lock owner token explicit.

Post-design re-check: still PASS. Risks recorded in research.md: R-7 (refresh holder crash between rotation and store write ends the session fail-closed; S01 has no grace), R-9 (Apollo plugin ordering for the cost limiter), R-11 (S01/S02 must treat the BFF as trusted proxy: sibling follow-up).

## Follow-ups from built sibling specs (treated as requirements)

| From | Requirement | Where it is planned and tested |
|---|---|---|
| S01 | Serialize refresh per session; reuse is fatal, no grace; `delivery:"cookie"` only for direct browser calls | `RefreshCoordinator` (Phase 4, AS-53–AS-57); the BFF calls S01 with body delivery only and never sets `delivery`; S: AS-54 (one refresh for 20 requests over two app instances), AS-55 (never retried, never presented twice) |
| S02 / W01 | Gap C2 items: one origin for `__Host-` cookies; `POST …/start` then navigate to `authorizationUrl`; `/login?error=<code>`, `/login/mfa`, `?linked=google`; switch on `code`; `recoveryCodesRemaining: 0` prompt | BFF side: password + MFA login relay S01/S02 problem `code`s unchanged (AS-45, AS-49) and the OIDC redirect flow is untouched (spec Assumptions); same-origin routing already in `packages/web/next.config.ts:33-35`, verified by a config assertion task (T-W2). Screens (`/login?error`, `/login/mfa`, `?linked=google`, the recovery-codes prompt) are W01's: `lib/api/session.ts` (new, T-W1) returns typed `code`s so W01 can switch on them; the screen items go to `gaps.md` "Sibling-spec follow-ups" |
| S05 | `GET /batch/products` items `{id, shopId, title, priceMinor, currency, inStock, category, rating}` or `null`; `GET /products/:id` public view | upstream endpoints use `productBatchItemSchema` / `productPublicSchema`; GraphQL `Product` exposes only those fields (G5, AS-41, AS-25–AS-26); AS-01 parses the page with the schema |
| S10 | Checkout `202`, `Idempotency-Key`, cart/orders shapes | The BFF composes none of these in this version (read-only GraphQL, one page aggregate, FR-037). Guarded by AS-40 (no mutation) and the boundary spec B (schema has no cart/order/payment type). A future BFF mutation forwards the `Idempotency-Key` header unchanged (FR-037). Web (W03) follow-up recorded in `gaps.md` |
| S13 | Pay step, `payment.status`, replace `packages/web/lib/types.ts:98-104` | No BFF route. B asserts the GraphQL schema and REST routes contain no payment surface. The in-repo web type swap is W03's; T-W3 greps its users and records the result (no change here unless it is a pure type swap with no UI change) |
| S32 | Search page sends `limit`/`cursor`/`searchId`, reads `items`, `total.exact`, `degraded`; BFF does not compose search | B asserts the BFF exposes no search route/field (FR-050); W02 follow-up recorded |
| S34 | `product-page.service.ts` + resolver adopt `recommendationsResponseSchema`; `null` + partial error on timeout/503/404/invalid; `bff.e2e-spec.ts` gains the AS-49 cases (A25) | P: AS-15 (page), G: AS-30 (GraphQL `path: ["product","recommendations"]`, `UPSTREAM_TIMEOUT`); the A25 cases (timeout, 503, 404, invalid body, valid body unchanged) are rows of `it.each` in AS-13/AS-15 and named `S34 A25` in the title |
| S35 | Adopt `trendingResponseSchema`, keep the 200 ms budget, pass items through, own the AS-42 composition test | P: AS-15 (envelope unchanged incl. empty `items`; slow/503/429/invalid → `trending: null` + code); titled `S35 AS-42` |
| S50 | Policy numbers into the domain with `definePolicies` + `forFeature`; adopt `RateLimit`/`RateLimit-Policy`, `503 rate_limiter_unavailable`, `422 rate_limit_cost_exceeded` | `bff/rate-limit-policies.ts`: `bff.product-page.principal` (300/min, `slidingWindow`, key `userOrIp`, fail open), `bff.graphql.cost` (20,000 units/min, `tokenBucket`, key `userOrIp`, fail open), `bff.session.login.ip` (20/min, key `ip`, fail **closed**). Contracts list the structured headers and both problem codes; AS-22, AS-36, AS-45 assert the structured headers |
| S50 (S42, S43, S48 clients) | Legacy `RateLimit-Limit/Remaining/Reset` and `X-RateLimit-*` are gone; read structured `RateLimit` / `RateLimit-Policy` | The BFF reads no upstream rate-limit header except `Retry-After` (section → `UPSTREAM_RATE_LIMITED`); a grep gate task (T-X1) fails on the legacy names in `libs/composition` and `packages/web/lib` |

## Project Structure

### Documentation

```text
specs/domains/S48-bff/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/http.md
└── tasks.md   # /speckit-tasks
```

### Source code

```text
packages/contracts/src/bff/
├── index.ts               # re-exported from the contracts barrel
├── product-page.ts        # productPageResponseSchema, sectionErrorSchema, section code enum, pageQuerySchema (T-C1)
├── session.ts             # sessionLoginRequestSchema, sessionMfaRequestSchema, sessionResponseSchema, mfaRequiredResponseSchema, session problem codes (T-C1)
├── graphql.ts             # GraphQL error code enum, persisted-query request/response shapes, problem codes (T-C1)
└── upstream.ts            # schemas for upstream bodies no sibling has published: flags, chatUnreadPage, boardPostsPage, pickupPage, flashSalePublic, auctionPublic, productVideos (each with the owning spec id in a comment) (T-C2)

packages/backend/libs/common/config/bff-config.ts          # joi keys + defaults + pure cross-checks (T-K1); registered in api-config.service.ts

packages/backend/libs/composition/bff/
├── bff.module.ts                  # BffModule (wiring only); BffCoreModule/CoreClient deleted
├── index.ts                       # entry point: BffModule only (X.4 analogue)
├── bff-config.ts                  # BffSettings built from ApiConfigService, fail-fast, origin parsing (T-K1)
├── rate-limit-policies.ts         # definePolicies('bff', …) + RateLimitModule.forFeature (T-R1)
├── problem.ts                     # BffProblem: code/status/retryAfter -> global filter; closed code set (T-E1)
├── credentials/
│   ├── request-credentials.ts     # resolve cookie|bearer|anonymous, ambiguous_credentials, anonymous-id validation (T-A1)
│   └── credentials.guard.ts       # attaches Credentials to the request (cookie -> session -> access token)
├── upstream/
│   ├── upstream-client.ts         # sole ResilientHttpClient user: origin lock, header allowlist, validate, classify (T-U1)
│   ├── upstream-error.ts          # UpstreamFailure{code, retryable, status}; closed code mapping (T-U1)
│   ├── circuit-breaker.ts (+spec U3)       # consecutive failures within window, open, single probe; pure, clock injected
│   ├── concurrency-gate.ts (+spec U4)      # per-upstream cap 100, per-request cap 12
│   ├── shared-cache-policy.ts (+spec U5)   # Cache-Control parsing, ceiling 30 s, eligibility
│   ├── shaped-cache.ts            # Redis cache + in-process single flight (public sections only)
│   └── endpoints/{catalog,tenancy,discovery,flags,chat,boards,video,pickup,flash-sales,auctions,identity}.ts  # one declared endpoint per upstream call
├── page/
│   ├── section-registry.ts        # the 11 declared sections (FR-001, FR-002); adding one = one entry
│   ├── product-page.service.ts    # waves, deadline, abort, outcomes, Server-Timing, metrics (T-P1..)
│   ├── product-page.controller.ts # GET /bff/product-page/:productId (prefix gives /api/bff/…)
│   └── page-metrics.ts            # bff_section_* series, breaker gauge
├── graphql/
│   ├── schema types (types.ts), product.resolver.ts, loaders.ts (+ loader-batching.spec U2)
│   ├── limits.ts (+ limits.spec U1)           # depth, cost with variables, root fields, cycle-safe
│   ├── http-guard.middleware.ts               # size 8 KB, media type, array batching, GET rules, before body parse where possible
│   ├── trusted-documents.ts + persisted-queries.allowlist.ts   # sha256 verification, startup validation, GET by hash
│   ├── error-format.ts                        # stable extensions.code, generic messages
│   ├── cost-rate-limit.plugin.ts              # Apollo plugin: charge computed cost, 1 unit on rejection
│   └── schema.snapshot.graphql (+ schema-snapshot check in G spec)
├── session/
│   ├── session.controller.ts      # POST /bff/session, POST /bff/session/mfa, GET /bff/session, POST /bff/session/logout
│   ├── session.service.ts         # login, mfa, current, logout, relogin (fixation)
│   ├── session-store.ts           # Redis adapter: encrypt/decrypt, TTL, CAS write, atomic MFA consume
│   ├── session-crypto.ts          # AES-256-GCM with key ring (two keys), SHA-256 key derivation
│   ├── session-lifetime.ts (+spec U7)  # idle 24 h / absolute 30 d / identity cap, write-at-most-once-a-minute
│   ├── csrf-token.ts (+spec U6)   # keyed MAC bind/verify, constant-time compare
│   ├── csrf-origin.guard.ts       # origin check (login) and CSRF header check (cookie POSTs)
│   ├── refresh-coordinator.ts     # single flight per session across instances
│   ├── identity-client.ts         # S01/S02 relay with X-Forwarded-For
│   └── session-cookies.ts         # one place for cookie names, attributes, clearing
└── bff-product-page.e2e-spec.ts … (see test files)

Test files (under libs/composition/bff/): bff.e2e-spec.ts (P, `BFF product page composition`), bff-graphql.e2e-spec.ts (G), bff-session.e2e-spec.ts (S), bff-boundary.e2e-spec.ts (B), plus a `testing/` folder: stub-upstream server (records calls, headers, order, connections, aborts; delay/fail/garbage), fixtures parsed by contract schemas, app factory that boots the production `BffAppModule` with `configureHttpApp`, two-instance helper.

packages/backend/apps/bff/src/bff-app.module.ts   # + RedisModule, RateLimitModule.forRoot, request context, config; no DB module
packages/web/lib/api/graphql.ts                   # cookie + CSRF instead of bearer (T-W1)
packages/web/lib/api/session.ts (new)             # typed session client using contracts, switches on problem code (T-W1)
packages/web/next.config.ts                       # confirm /api/bff/* and /api/graphql rewrites (T-W2)
packages/web/tests/bff-session.spec.ts, product-page.spec.ts   # happy-path journeys (W01/W02 own the screens; created if the screens exist, else recorded)
specs/UNVERIFIED.md                               # SC-008 row
```

**Structure Decision**: stay in `libs/composition/bff` and `apps/bff`; no new library or deployable. Folder-per-slice rather than I.1 layers because X.8 gives composition its own operation list and the slices share only `upstream/` and `credentials/`.

## Design decisions the tasks depend on

- **Section engine.** `SectionDefinition = {name, required, budgetMs, dependsOn: 'productId' | 'product', identity: 'none' | 'optional' | 'required', sharedCache: boolean, anonymousId: boolean, applies(ctx): boolean, call(ctx, signal): endpoint call, shape(body)}`. Wave 0 starts with `Promise.allSettled` over every `dependsOn: 'productId'` section at the instant the product call starts; wave 1 starts from the product answer. One `AbortController` per page; the required product failing (`404/503/502/401`) aborts it. A section's budget is `min(budgetMs, deadlineAt - now)`; non-positive → `BUDGET_EXCEEDED` without a call. An upstream `401` on a credentialed call (flags, chat) rejects the whole page (`401 invalid_token`) and aborts the rest.
- **Outcome vocabulary** is one function `classify(error) → {code, retryable}`: timeout → `UPSTREAM_TIMEOUT`(true); 503/5xx/reset → `UPSTREAM_UNAVAILABLE`(true); 404 → `UPSTREAM_NOT_FOUND`(false); 429 → `UPSTREAM_RATE_LIMITED`(true); schema mismatch → `UPSTREAM_INVALID`(false); gate refusal → `UPSTREAM_OVERLOADED`(true); open breaker → `CIRCUIT_OPEN`(true); deadline → `BUDGET_EXCEEDED`(true). The same function feeds page `errors` and GraphQL `extensions.code`. 302 → `UPSTREAM_UNAVAILABLE` (redirects are not followed).
- **Identity attachment.** `Credentials = {kind: 'anonymous', anonymousId?} | {kind: 'bearer', token} | {kind: 'session', accessToken, sessionKey}`. The `UpstreamClient` adds `Authorization` only when the endpoint declares `identity` ≠ `none` *and* credentials exist; it adds `X-Anonymous-Id` only for endpoints with `anonymousId: true` and a valid ID; it never copies inbound headers (allowlist: `Accept`, `X-Request-Id`, `traceparent`, `tracestate`, and the two above).
- **Cache.** Key `bff:cache:{endpoint}:{sha256(url)}`; stored only for `sharedCache` endpoints whose response `Cache-Control` has `public`/`s-maxage` and no `private`/`no-store`, TTL `min(s-maxage, 30 s)`; the cache entry is the *validated body*, so a poisoned entry cannot bypass the schema. Single flight keys on the same string, in process, plus the Redis entry across instances. Flags and chat are `sharedCache: false`, so they never enter either.
- **Session record** (encrypted JSON): `{v, sessionId (S01), user:{id,email,role}, accessToken, accessExp, refreshToken, tokenVersion, createdAt, lastSeenAt, absoluteExp, idleExp}`. Redis TTL = `min(idleExp, absoluteExp) - now`. `lastSeenAt` is rewritten at most once per minute. `PENDING_MFA` is a separate short key (not a session), so there is no half-active record that a bug could treat as signed in; `ENDED` is "record absent".
- **Refresh single flight.** `ensureFreshAccessToken(sessionKey)`: if `accessExp - now > 30 s` return. Else `SET bff:refresh:{key} <owner> NX PX 5000`; winner re-reads the record (another instance may have finished), calls S01 once (no retry, 2 s timeout), writes the new record by version-guarded script up to 3 attempts, releases by compare-and-delete. Losers poll the record every 25–50 ms up to 3 s for a higher `tokenVersion`. Outcomes follow AS-53–AS-57: `401 invalid_refresh_token` → delete record, clear cookies, `401 session_expired`; S01 transient + token still valid → proceed; expired → `503 session_unavailable` + `Retry-After`; all 3 writes fail → delete record fail-closed, `503`.
- **MFA consume.** The pending record is `bff:mfa:{sha256(cookie)}` (encrypted `{mfaToken, createdAt, clientIp}`, TTL 300 s). Verify takes `bff:mfa-lock:{id}` with `SET NX PX 10000`; a loser answers `409 mfa_not_pending`; the winner calls S02, and on success writes the session then deletes the pending record and the lock; a wrong code keeps the record and releases the lock; "challenge spent/expired" deletes it and answers `401 invalid_token`.
- **GraphQL limits order.** HTTP guard (size → media type → array → trusted document / hash check / GET rules) → CSRF/origin for cookie `POST` → parse → validation rules (`depth`, `cost`, `rootFields`, introspection, mutation/subscription absent) → cost rate limit (charged computed cost, or 1 on rejection) → execute with a 2,000 ms deadline. Rejections before execution make zero upstream calls (asserted by the stub call log).

## Technical tasks by gap (input for `/speckit-tasks`)

Order follows `gaps.md` "Suggested order"; tests first inside each step. Task IDs here are plan handles; `/speckit-tasks` renumbers them.

1. **Contracts and config** — T-C1 (page/session/GraphQL schemas), T-C2 (upstream schemas; check `productPublicSchema`, `productBatchItemSchema`, `recommendationsResponseSchema`, `trendingResponseSchema` first, add only missing ones), T-K1 (`bff-config.ts` joi keys: `bff_upstream_url` required with no default, `bff_session_keys`, `bff_csrf_key`, `bff_allowed_origins`, `bff_local_dev`, all budgets and limits, `bff_trusted_documents` source; production rule; pure cross-check `U` spec for settings). Closes C1, C4, S5, A12 (config part).
2. **Static helpers (unit, table-driven)** — U1 (cost/depth/root-field estimator incl. variables, fragments, cycles, exact boundary 2,000, recommendations = 8), U2 (ID de-dup, order, chunk at 100, length invariant, `fast-check`), U3 (breaker), U4 (gate), U5 (Cache-Control), U6 (CSRF MAC), U7 (lifetime). Closes T6, G1 (logic), G2 (logic).
3. **Upstream layer** — T-U1 (`UpstreamClient`, endpoints per capability, classify, origin lock, header allowlist, validate), T-U2 (breaker and gate wiring, metrics), T-U3 (shaped cache + single flight), T-U4 (verify against `ResilientHttpClient`: redirects not followed, keep-alive pool reuse, abort propagates to the socket, `breaker: false`, trusted-proxy hop — fix in the shared client only if the test proves a gap, noting it as an S54 sibling follow-up). Closes C2, C3, A8, A10, A12, A13, S4. Delete `core-client.ts`.
4. **Test harness** (T1, T2, T5) — stub servers, fixtures parsed with contracts, production-app factory (`configureHttpApp`, `RateLimitModule`, Redis), two-instance helper, `Clock` freeze; replace the old `bff.e2e-spec.ts` (rename describe to `BFF product page composition`, T7).
5. **Product-page aggregate** — T-P1 registry, T-P2 waves/deadline/abort/required failures/retry, T-P3 credentials (cookie/bearer/ambiguous), T-P4 rate limit + `Cache-Control` + `Server-Timing` + metrics + log fields, T-P5 section `lat`/`lng`/`radiusKm` validation, `chatUnread` pass-through. Closes A1–A11. P file green (AS-01–AS-24).
6. **GraphQL** — T-G1 loaders (per request, chunking, order, isolation, credentials, deadline), T-G2 resolver rewrite (`priceMinor`/`currency`, recommendations through loader, no silent `catch`), T-G3 HTTP guard + trusted documents + GET by hash + startup validation, T-G4 limits rule wiring (cycle-safe), T-G5 cost rate limit plugin, T-G6 error formatter, T-G7 snapshot + `@deprecated` check, T-G8 CSRF/origin on cookie `POST`. Closes G1–G10. G file green (AS-25–AS-42); B file AS-39.
7. **Session** — T-S1 crypto + store + lifetime, T-S2 CSRF + origin guard, T-S3 identity client (`X-Forwarded-For` from `req.clientIp`), T-S4 login/MFA/logout/current, T-S5 refresh coordinator, T-S6 credential resolver shared with page and GraphQL, T-S7 rate limit `bff.session.login.ip`, `Cache-Control: no-store` on every session answer. Closes S1, S2. S file green (AS-43–AS-63).
8. **Boundary** — B file: boot assertions (AS-64, AS-39, AS-63 startup), `check:boundaries`, `check:table-ownership --strict`, `check:no-request-scope`; schema has no mutation/cart/order/payment/search surface (S10, S13, S32 follow-ups).
9. **Web consumers (in repo)** — T-W1 `lib/api/graphql.ts` (cookie + `X-CSRF-Token`, no token in memory) and `lib/api/session.ts`; T-W2 rewrite assertion; T-W3 payment type grep (S13); T-W4 Playwright journeys if the W01/W02 screens already exist (T8), otherwise recorded as sibling follow-ups. In-repo product-page consumers adapted to `priceMinor`/`currency` and the section envelopes so `tsc` stays green.
10. **Gates and records** — `pnpm exec tsc --noEmit` (backend, contracts, web), ESLint, `check:boundaries`, `check:table-ownership` and `--strict` (record the lines; expected none for `composition`), `check:no-request-scope`, grep gate for legacy `RateLimit-*`/`X-RateLimit-*` (T-X1), then the whole capability suite once; `UNVERIFIED.md` row for SC-008; `gaps.md` sibling follow-ups.

## Gap coverage index

| Gap | Task(s) | Gap | Task(s) |
|---|---|---|---|
| C1 | T-C1, T-C2 | G1 | U1, T-G4 |
| C2 | T-U1 | G2 | U1, T-G3, T-G4, T-K1 |
| C3 | T-U1 | G3 | T-G2 |
| C4 | T-K1 | G4 | T-G2, T-G1 |
| A1 | T-P1, T-P2 | G5 | T-G2, T-G7 |
| A2 | T-P1 | G6 | T-G1 |
| A3 | T-P2 | G7 | T-G3 |
| A4 | T-P2, T-U1 | G8 | T-G5, T-G6, T-G8 |
| A5 | T-U1 | G9 | T-G6 |
| A6 | T-P2 | G10 | T-G7 |
| A7 | T-P5 | S1 | T-S1…T-S7 |
| A8 | T-U1, T-P3 | S2 | T-S6 |
| A9 | T-P2 | S3 | T-W1 |
| A10 | T-U2, T-U3, T-P4 | S4 | T-U4 |
| A11 | T-P4, T-P5 | S5 | T-K1 |
| A12 | T-U4 | T1–T3, T5, T7 | step 4 |
| A13 | T-U4 | T4 | steps 5–7 |
| Debt table / ownership | step 8, step 10 | T6 | step 2 |
| | | T8 | T-W4 |
