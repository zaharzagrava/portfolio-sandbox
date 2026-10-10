---

description: "Task list for S48 BFF composition"
---

# Tasks: S48 — BFF composition (product page, GraphQL, browser session)

**Input**: `specs/domains/S48-bff/` (plan.md, spec.md, test-plan.md, gaps.md, questions.md, research.md, data-model.md, contracts/http.md, quickstart.md)

**Tests**: Requested (test-plan.md, constitution VII). Every test task comes before the code task it proves. Run backend e2e only through `/opt/sdd/repo/scripts/sdd/test-spec.sh <path>`; run commands from `packages/backend`; run the narrowest test first and the whole `libs/composition/bff` suite once at the end. After 5 failed fixes of the same test, stop and write the blocker into `questions.md`.

**Rules that apply to every task**: no `git checkout/restore/reset/stash/clean` (undo by hand-editing only the lines concerned); no new `sequelize.transaction` (the BFF has no database); do not edit other capabilities' specs (record in `gaps.md` "Sibling-spec follow-ups"); no success criterion is called verified unless a test proves it.

## Format: `[ID] [P?] [Story] Description`

- Paths: `B` = `packages/backend/libs/composition/bff`, `C` = `packages/contracts/src/bff`, `W` = `packages/web`, `SD` = `specs/domains/S48-bff`.
- Stories: US1 product page (P1), US2 resilient sections (P1), US3 GraphQL (P1), US4 browser session (P1), US5 composition boundary (P2).

---

## Phase 1: Setup

- [X] T001 Run `pnpm check:table-ownership` and `pnpm check:table-ownership --strict` from `packages/backend`, grep `libs/composition` for `sequelize|Model|\.query\(|@app/domains`, and record the output lines (expected: no `composition` row) in `SD/gaps.md` "Debt register" (replaces the "not run" row). If a row appears, replace it with an R2 HTTP call.
- [X] T002 Create folders `B/{credentials,upstream/endpoints,page,session,testing}` and `C/` with empty `index.ts` re-exported from the contracts barrel (`packages/contracts/src/index.ts`).

---

## Phase 2: Foundational (blocks every story)

**Contracts and config (gaps C1, C2, C3, C4, S5)**

- [X] T003 [P] Write failing contract tests in `C/product-page.spec.ts`, `C/session.spec.ts`, `C/graphql.spec.ts`: parse the fixtures from contracts/http.md; reject extra/missing fields; the section code enum is exactly `UPSTREAM_TIMEOUT UPSTREAM_UNAVAILABLE UPSTREAM_NOT_FOUND UPSTREAM_RATE_LIMITED UPSTREAM_INVALID UPSTREAM_OVERLOADED CIRCUIT_OPEN BUDGET_EXCEEDED`.
- [X] T004 [P] Implement `C/product-page.ts` (`productPageResponseSchema` with 11 sections, all but `product` nullable; `sectionErrorSchema {section, code, retryable}`; `pageQuerySchema` for `lat`/`lng`/`radiusKm`), `C/session.ts` (`sessionLoginRequestSchema`, `sessionMfaRequestSchema`, `sessionResponseSchema`, `mfaRequiredResponseSchema`, session problem codes), `C/graphql.ts` (error code enum incl. `QUERY_TOO_DEEP`, `BAD_USER_INPUT`, `BUDGET_EXCEEDED`, persisted-query request shape). Closes C1.
- [X] T005 [P] Check that `productPublicSchema`, `productBatchItemSchema`, `recommendationsResponseSchema`, `trendingResponseSchema`, shop/flash/auction schemas already exist in `packages/contracts`; add only missing upstream schemas to `C/upstream.ts` (`flagsResponse`, `chatUnreadPage`, `boardPostsPage`, `pickupPage`, `flashSalePublic`, `auctionPublic`, `productVideos`), each with the owning spec id in a comment. Closes C2/C3 (schemas part).
- [X] T006 Write failing unit spec `B/bff-config.spec.ts`: missing `bff_upstream_url` throws; non-https upstream outside local dev throws; `bff_session_keys` needs 1–2 base64 32-byte keys; `bff_csrf_key` required; `bff_allowed_origins` parse; `bff_trusted_documents` must be on in production unless `bff_local_dev`; every budget/limit default equals the spec Assumptions numbers (shop 300, recommendations 300, trending 200, flags 150, chat 200, page 1000, GraphQL 2000, depth 6, cost 2000, 20 root fields, 8 KB, 100 in flight per upstream, 12 per request).
- [X] T007 Implement `packages/backend/libs/common/config/bff-config.ts` (joi keys, defaults, pure cross-checks; register in `api-config.service.ts`) and `B/bff-config.ts` (`BffSettings` built from `ApiConfigService`, origin parsing, fail-fast). Remove the `http://localhost:8000` default. Closes C4, S5.
- [X] T008 [P] Write failing unit specs for the pure helpers, table-driven with `it.each`: `B/upstream/circuit-breaker.spec.ts` (U3: 5 consecutive failures in window open it, single half-open probe after 10 s, re-open, close; clock injected), `B/upstream/concurrency-gate.spec.ts` (U4: 100 per upstream, 12 per request), `B/upstream/shared-cache-policy.spec.ts` (U5: `s-maxage`, `private`, `no-store`, 30 s ceiling, eligibility), `B/session/csrf-token.spec.ts` (U6: bind/verify, tamper, other session, constant-time compare), `B/session/session-lifetime.spec.ts` (U7: idle 24 h, absolute 30 d, identity cap, write at most once a minute). Closes T6 (part).
- [X] T009 [P] Implement `B/upstream/circuit-breaker.ts`, `B/upstream/concurrency-gate.ts`, `B/upstream/shared-cache-policy.ts`, `B/session/csrf-token.ts`, `B/session/session-lifetime.ts` (pure, `Clock`/`now` injected, no Nest/Redis imports) until T008 passes.
- [X] T010 Write failing U1 `B/graphql/limits.spec.ts` (depth; cost with literal lists, `first`, **variable values**, aliases, fragments, fragment cycles; exactly 2,000 passes, 2,001 rejected; `recommendations` = 8; root-field cap 20; one operation per request) and U2 `B/graphql/loader-batching.spec.ts` (de-duplicate, keep order, `[A, null, A, C]`, chunk at 100, output length = input length, `fast-check` property). Closes G1/G2 (tests), T6.
- [X] T011 Rewrite `B/graphql/limits.ts` (variable-aware, cycle-safe, configurable limits) and the pure part of `B/graphql/loaders.ts` (de-dup, order, chunk) until T010 passes. Closes G1, G2 (logic).
- [X] T012 Build the test harness `B/testing/`: `stub-upstream.ts` (loopback HTTP server per capability: records calls, headers, order, timestamps, connection count, aborts; delay/fail/garbage/redirect/hold modes), `fixtures.ts` (fixtures parsed with the contract schemas), `app-factory.ts` (boots the production `BffAppModule` with `configureHttpApp`, global prefix, real Redis from `docker-compose.test.yaml`, frozen `Clock`), `two-instances.ts`. Closes T1, T2, T5.
- [X] T013 Write `B/upstream/upstream-client.spec.ts`-level e2e inside the harness (file `B/upstream/upstream-client.e2e-spec.ts`, describe `BFF upstream client`) failing first: origin locked to `bff_upstream_url`, `302` not followed (`UPSTREAM_UNAVAILABLE`), header allowlist (`Accept`, `X-Request-Id`, `traceparent`, `tracestate`, `Authorization` only on declared endpoints, `X-Anonymous-Id` only where declared), schema validation → `UPSTREAM_INVALID`, closed `classify()` mapping, abort reaches the socket, keep-alive reuse. Covers A12, A13, S4 (proving tests).
- [X] T014 Implement `B/upstream/upstream-error.ts` (`UpstreamFailure`, `classify`), `B/upstream/upstream-client.ts` (sole `ResilientHttpClient` user, `breaker: false`, `maxAttempts: 1`), `B/upstream/endpoints/{catalog,tenancy,discovery,flags,chat,boards,video,pickup,flash-sales,auctions,identity}.ts` (one declared endpoint per call: method, path, schema, budget, identity need, sharedCache, retry), `B/upstream/shaped-cache.ts` (Redis `bff:cache:{endpoint}:{sha256(url)}`, TTL `min(s-maxage, 30 s)`, validated body only, in-process single flight), breaker/gate wiring and `B/problem.ts` (`BffProblem` → global filter). Delete `B/core-client.ts` and all its imports. Closes C2, C3, A5, A8 (client), A10 (parts), A12, S4. If T013 shows `ResilientHttpClient` follows redirects, ignores abort or does not reuse connections, fix it in the shared client only with the proving test and add an S54 note in `SD/gaps.md`.
- [X] T015 [P] Implement `B/rate-limit-policies.ts` (`definePolicies('bff', …)` + `RateLimitModule.forFeature`): `bff.product-page.principal` 300/min sliding window key `userOrIp` fail open; `bff.graphql.cost` 20,000 units/min token bucket key `userOrIp` fail open; `bff.session.login.ip` 20/min key `ip` fail **closed**. Rewire `B/bff.module.ts` (wiring only) and `packages/backend/apps/bff/src/bff-app.module.ts` (+ `RedisModule`, `RateLimitModule.forRoot`, request context, config; no DB module). S50 follow-up.
- [X] T016 Rename the old `B/bff.e2e-spec.ts` describe to `BFF product page composition` and port it onto the harness (T012) so it boots the production pipeline (routes `/api/bff/...`); keep it red where the behaviour is not built yet. Closes T1, T7.

**Checkpoint**: U1–U7 green, config spec green, upstream client e2e green, `tsc --noEmit` green in backend and contracts.

---

## Phase 3: US1 — One request renders the product page (P1)

**Goal**: `GET /api/bff/product-page/:productId` returns the 11-section aggregate with correct identity handling and validation.
**Independent test**: `test-spec.sh libs/composition/bff/bff.e2e-spec.ts -t "AS-0|AS-1[01]|AS-2[124]"`.

- [X] T017 [US1] Failing P tests in `B/bff.e2e-spec.ts`: AS-01 full page anonymous (all sections, schema parse, `Cache-Control: private, no-store`, bodies unchanged); AS-02 anonymous skips chat, no `Authorization`, anon ID to flags, no error entry; AS-03 session cookie forwards token to flags and chat only, no `Cookie` upstream, chat `nextCursor` untouched; AS-04 hidden shop / no `shopId` → `shop: null`, no error, no call; AS-05 pickup skip/params and `400` for each invalid `lat`/`lng`/`radiusKm`, no upstream call; AS-06 stub timestamps (independent sections start with product, `shop`/`trending` after, total < sum); AS-08 non-UUID `400`, no calls.
- [X] T018 [US1] Failing P tests: AS-07 unknown product `404` and outstanding calls aborted; AS-09 retry once (503→200 two calls; 503×2 → `503` + `Retry-After` two calls; `404`/`400` no retry); AS-10 invalid product body → `502 upstream_invalid`, generic `detail`, log check; AS-11 bearer + chat `401` → `401 invalid_token`, others aborted.
- [X] T019 [US1] Failing P tests: AS-21 forged identity headers dropped, anon ID rules, `Authorization` only where declared, `302` not followed; AS-22 301st request → `429` + `Retry-After` + structured `RateLimit`/`RateLimit-Policy`, Redis counter, other principal unaffected (no legacy `RateLimit-Limit`/`X-RateLimit-*`); AS-24 ≤ 10 connections per stub host over 30 requests.
- [X] T020 [US1] Implement `B/page/section-registry.ts` (`SectionDefinition` per plan: 11 entries incl. `product`; `dependsOn`, `identity`, `sharedCache`, `anonymousId`, `applies`, `shape`). Closes A2.
- [X] T021 [US1] Implement `B/credentials/request-credentials.ts` and `credentials.guard.ts` (cookie | bearer | anonymous, anonymous-ID validation, forged-header stripping; `ambiguous_credentials` shape; session lookup delegates to the session slice once built, T049). Closes A8, S2 (page part).
- [X] T022 [US1] Implement `B/page/product-page.service.ts` (two waves, one `AbortController`, required-failure abort, product retry once with full jitter, upstream `401` on credentialed call → page `401`, `chatUnread` passed through unchanged, `lat`/`lng`/`radiusKm` validation) and `B/page/product-page.controller.ts` (`@RateLimit` on `bff.product-page.principal`, `Cache-Control: private, no-store`, `ZodValidationPipe`, DTO only). Closes A1, A2, A6, A7, A8, A9, A11. Run T017–T019 until green.

---

## Phase 4: US2 — A slow or broken section never breaks the page (P1)

**Goal**: deadline, budgets, closed error codes, breaker, bulkhead, cache, coalescing, observability.
**Independent test**: `test-spec.sh libs/composition/bff/bff.e2e-spec.ts -t "AS-1[2-9]|AS-20|AS-23"`.

- [X] T023 [US2] Failing P tests: AS-12 500 ms recommendations → `errors` entry, bounded by stub timestamps, abort seen; AS-13 `it.each` over 10 sections × 5 failure classes (timeout, 503, 404, 429, invalid body) → closed code set, no message leakage (includes the `S34 A25` rows: timeout, 503, 404, invalid body, valid body unchanged); AS-14 one failure isolated (byte-compare the others), all-optional-fail `200`; AS-15 trending/recommendations pass-through incl. empty `items`, slow/503/429/invalid → `null` + code (titled `S35 AS-42`); AS-16 deadline (product 700 + shop 600 → `BUDGET_EXCEEDED`, total ≤ 1,100 ms; product > 800 → `503`).
- [X] T024 [US2] Failing P tests: AS-17 breaker (5 failures open, call skipped, probe at 10 s with frozen clock, re-open, close); AS-18 bulkhead (100 held in flight → `UPSTREAM_OVERLOADED`, product `503 overloaded`, ≤ 12 per request); AS-19 shared cache (`s-maxage=5` hit/expire, `private`/`no-store` not cached, personal never cached, A vs B vs anonymous, 30 s ceiling); AS-20 coalescing (50 parallel → one call per public upstream, flags/chat per visitor); AS-23 `Server-Timing`, metrics per outcome, log fields, no secrets.
- [X] T025 [US2] Implement budgets/deadline in `B/page/product-page.service.ts` (`min(budgetMs, deadlineAt − now)`, non-positive → `BUDGET_EXCEEDED` without a call, 1,000 ms page deadline, 800 ms product), error entries `{section, code, retryable}` only, `Server-Timing` header. Closes A3, A4, A5.
- [X] T026 [US2] Implement `B/page/page-metrics.ts` (`bff_section_*` series, `bff_breaker_state` gauge), wire breaker + gate + shaped cache into every section call, structured log line (requestId, section outcomes; no token/cookie/email/upstream body). Closes A10, A11 (headers part). P file green (AS-01–AS-24).

---

## Phase 5: US3 — Mobile clients query a graph without N+1 or abuse (P1)

**Goal**: read-only GraphQL with batching, limits, trusted documents, stable errors.
**Independent test**: `test-spec.sh libs/composition/bff/bff-graphql.e2e-spec.ts`.

- [X] T027 [US3] Failing G tests (new `B/bff-graphql.e2e-spec.ts`, describe `BFF GraphQL`): AS-25 20 products → 2 calls; AS-26 duplicates and hidden `[A, null, A, C]`; AS-27 150 IDs → 100 + 50; AS-28 two principals in parallel with own credentials, repeat request repeats calls; AS-29 `503` product batch → `path`, `extensions.code`, sibling fields intact, once per path; AS-30 recommendations timeout `path: ["product","recommendations"]` + one hydration batch.
- [X] T028 [US3] Failing G tests: AS-31 `400 QUERY_TOO_DEEP`; AS-32 cost (literal, variable, fragments, boundary) rejected before any call; AS-33 root fields / array batch `400`, size `413`, media type `415`; AS-34 input bounds (51 IDs, `[]`, non-UUID, `first` 51 → `BAD_USER_INPUT`); AS-35 operation deadline ≤ 2,100 ms with aborts; AS-36 cost rate limit (`429` + structured headers, rejected query charged 1, other principal free).
- [X] T029 [US3] Failing G tests: AS-37 trusted documents (known, unknown → `PERSISTED_QUERY_NOT_FOUND`, text-only, hash mismatch, dev mode); AS-38 persisted `GET` (anonymous cacheable headers, credentialed `private, no-store`, raw `GET` `400`); AS-40 introspection off in production, mutation/subscription rejected; AS-41 `priceMinor` string + `currency`, no float, schema snapshot compare fails on drift; AS-42 token only on identity fields, cookie `POST` without CSRF / bad origin → `403` with zero upstream calls.
- [X] T030 [US3] Rewrite `B/graphql/loaders.ts` (created in the Apollo context, not request-scoped providers; carry credentials + deadline; chunking; batch length/order validation; error mapping to codes) and `B/graphql/types.ts` / `product.resolver.ts` (`priceMinor` string scalar + `currency`, S05 `productBatchItemSchema` shape, recommendations through a loader validated with `recommendationsResponseSchema`, no silent `catch`, `products(ids)` > 50 → `BAD_USER_INPUT`). Closes G3, G4, G5, G6.
- [X] T031 [US3] Implement `B/graphql/http-guard.middleware.ts` (8 KB size, media type, array batching, GET rules), `trusted-documents.ts` + `persisted-queries.allowlist.ts` (SHA-256 verification, `GET` by hash, startup validation naming the bad entry, enforced everywhere except `bff_local_dev`), delete/replace `persisted-queries.ts`. Closes G7, G2.
- [X] T032 [US3] Wire the limits rule (T011) into the Apollo config from settings; implement `B/graphql/cost-rate-limit.plugin.ts` (charge computed cost, 1 on rejection, structured `RateLimit`/`RateLimit-Policy` via S50 helpers, `503 rate_limiter_unavailable` / `422 rate_limit_cost_exceeded` mapped), operation deadline 2,000 ms, `B/graphql/error-format.ts` (stable `extensions.code`, generic message, no stack). Closes G8, G9.
- [X] T033 [US3] Implement CSRF/origin check for cookie `POST` on GraphQL (reuse T009/T043 guard), `Cache-Control` rules, request ID in context; generate `B/graphql/schema.snapshot.graphql` (`autoSchemaFile` to the file) and the `@deprecated` check in the G spec. Closes G8, G10. G file green (AS-25–AS-42 except AS-39).

---

## Phase 6: US4 — The browser never holds a token (P1)

**Goal**: token-handler session: login, MFA, current, logout, refresh single flight, CSRF, isolation.
**Independent test**: `test-spec.sh libs/composition/bff/bff-session.e2e-spec.ts`.

- [X] T034 [US4] Failing S tests (new `B/bff-session.e2e-spec.ts`, describe `BFF session handling`): AS-43 login (cookie attributes `__Host-bff-session` HttpOnly Secure SameSite, `__Host-bff-csrf`, no token in body/cookies/logs, record key = hash, encrypted at rest, S01 called once, `Cache-Control: no-store`); AS-44 bad origin `403`, no cookie, no S01 call; AS-45 failures relayed (`401` identical for unknown address, `429`, `503`, `400/413/415` before upstream, structured rate-limit headers, `bff.session.login.ip` fail closed); AS-46 `X-Forwarded-For` from `req.clientIp`, untrusted header ignored; AS-47 fixation (old cookie unknown after relogin, new ID, old identity session revoked, revoke failure tolerated).
- [X] T035 [US4] Failing S tests: AS-48 MFA flow (`mfaRequired`, pending cookie, token not leaked, verify → active session); AS-49 illegal states (`409 mfa_not_pending` ×3, wrong code keeps pending, spent challenge deletes it); AS-50 concurrent verify (`Promise.all` → one `200`, one `409`, one record); AS-51 `GET /session` (`200`, `401` without cookie, random value, stored hash as cookie); AS-52 idle/absolute expiry with frozen clock (record deleted, cookie cleared, public read anonymous, write ≤ once a minute).
- [X] T036 [US4] Failing S tests: AS-53 proactive refresh once (none with > 30 s left); AS-54 two app instances, 20 parallel requests → exactly one S01 refresh; AS-55 S01 `401` → session ended, cookies cleared, no retry, token never presented twice; AS-56 identity down (valid token proceeds, expired → `503 session_unavailable` + `Retry-After`, session kept, one attempt); AS-57 Redis write failure after rotation (retry success, 3 failures → session ended + `503`).
- [X] T037 [US4] Failing S tests: AS-58 logout (no CSRF `403`, valid `204`, identity down `204`, replay `204` without call); AS-59 CSRF rules (missing / mismatched / other-session `403`, `GET` and bearer exempt); AS-60 cookie + bearer → `400 ambiguous_credentials` on page, GraphQL, session; AS-61 session store down (anonymous served, cookie request `503`, readiness unaffected); AS-62 user isolation (A/B interleaved, forged/logged-out cookies); AS-63 token only to configured origin (redirect and misconfigured section refused).
- [X] T038 [US4] Implement `B/session/session-crypto.ts` (AES-256-GCM, two-key ring, SHA-256 key derivation) and `B/session/session-store.ts` (Redis `bff:sess:{sha256}`, TTL `min(idleExp, absoluteExp) − now`, version-guarded CAS write by script, `bff:mfa:*` 300 s, `bff:mfa-lock:*` 10 s atomic consume; every key has a TTL, no `KEYS`). SessionRecord fields per data-model.md: `v: 1`, `tokenVersion` int ≥ 1, `role` ∈ `USER SELLER MODERATOR ADMIN`.
- [X] T039 [US4] Implement `B/session/session-cookies.ts` (names, attributes, clearing in one place), `B/session/csrf-origin.guard.ts` (origin check for login, CSRF header for cookie POSTs; bearer and `GET` exempt).
- [X] T040 [US4] Implement `B/session/identity-client.ts` (S01/S02 relay with `X-Forwarded-For` from `req.clientIp`, body delivery only — never `delivery:"cookie"`, problem `code`s relayed unchanged).
- [X] T041 [US4] Implement `B/session/refresh-coordinator.ts` (`SET bff:refresh:{key} NX PX 5000`, winner re-reads then refreshes once with 2 s timeout and no retry, ≤ 3 version-guarded writes, losers poll 25–50 ms up to 3 s; outcomes per plan; reuse is fatal, no grace). S01 follow-up.
- [X] T042 [US4] Implement `B/session/session.service.ts` (login, mfa, current, logout, relogin/fixation) and `B/session/session.controller.ts` (`POST /bff/session`, `POST /bff/session/mfa`, `GET /bff/session`, `POST /bff/session/logout`; Zod pipe; `Cache-Control: no-store`; `@RateLimit` `bff.session.login.ip`). S02 follow-up: `recoveryCodesRemaining` passed through.
- [X] T043 [US4] Finish the credential resolver (T021) against the session store so cookie → session → access token (refresh via T041), `401 session_expired`, `503 session_unavailable`, `400 ambiguous_credentials`; share it with the page and GraphQL. Closes S1, S2. S file green (AS-43–AS-63).

---

## Phase 7: US5 — The BFF stays composition only (P2)

**Goal**: boundary and startup guarantees.
**Independent test**: `test-spec.sh libs/composition/bff/bff-boundary.e2e-spec.ts`.

- [ ] T044 [US5] Failing B tests (new `B/bff-boundary.e2e-spec.ts`, describe `BFF composition boundary`): AS-39 boot with a bad hash / invalid document → startup rejects naming the entry; AS-63 startup fails without upstream URL or with bad session keys; AS-64 booted app has no DB/queue/event provider and no request-scoped provider; GraphQL schema and REST routes expose no mutation, cart, order, payment (S10, S13) or search (S32) surface.
- [ ] T045 [US5] Make T044 green (adjust `B/bff.module.ts`, `B/index.ts` exporting `BffModule` only, `apps/bff` bootstrap); run `pnpm check:boundaries`, `pnpm check:no-request-scope`, `pnpm check:table-ownership --strict` and record the lines in `SD/gaps.md`. Closes the debt-table check.

---

## Phase 8: Web consumers and follow-ups from built specs

- [X] T046 [P] Write failing vitest/jest spec in `W/lib/api/session.spec.ts` for the typed session client (returns the problem `code`, never matches message text; sends `X-CSRF-Token` from `__Host-bff-csrf` on cookie POSTs; `recoveryCodesRemaining`, `mfaRequired` shapes from `packages/contracts`), then implement `W/lib/api/session.ts` (new). Closes S3 (part); S02/W01 follow-up (typed codes).
- [X] T047 Change `W/lib/api/graphql.ts` to cookie + `X-CSRF-Token` with no in-memory token and `credentials: 'include'`; adapt in-repo product-page and GraphQL consumers to `priceMinor` + `currency`, nullable sections and `{section, code, retryable}` errors so `tsc --noEmit` stays green (S05, S34, S35 follow-ups). Closes S3.
- [X] T048 [P] Add an assertion (spec or script) that `W/next.config.ts:33-35` rewrites `/api/bff/*` and `/api/graphql` on one origin (S02 follow-up, same origin for `__Host-` cookies).
- [X] T049 [P] Grep `packages/web` for `lib/types.ts:98-104` payment types and the removed routes `/payment/by-key`, `/payment/stream`, `/payment/:id`; change only if it is a pure type swap to the `packages/contracts` payment schemas, otherwise record the users in `SD/gaps.md` (S13 follow-up, W03).
- [X] T050 [P] Add a grep gate (script under `packages/backend/scripts/` or a unit spec) failing on `RateLimit-Limit|RateLimit-Remaining|RateLimit-Reset|X-RateLimit-` in `libs/composition` and `packages/web/lib` (S50 follow-up for clients).
- [X] T051 If the W01/W02 screens already exist, add Playwright happy paths `W/tests/bff-session.spec.ts` (sign in, navbar user, sign out) and `W/tests/product-page.spec.ts` (sections render); otherwise record them as sibling follow-ups in `SD/gaps.md` (T8).

---

## Phase 9: Polish, gates and records

- [ ] T052 Add the "Sibling-spec follow-ups" entries still missing in `SD/gaps.md` as `- **<id>**: <what they must adopt>` bullets (S01, S02, S24/S25/S19/S11/S21/S30/S38, S50 helper export, S54, W01, W02, W03 already listed; add any new finding from T014, T049, T051).
- [ ] T053 Confirm `SD/quickstart.md` "Ops artifacts" lists SC-008 (present) and `specs/UNVERIFIED.md` row for S48 SC-008 reads status `not run` (present at line 82). Do not describe SC-008 as verified.
- [ ] T054 Gates from `packages/backend`: `pnpm exec tsc --noEmit` (also in `packages/contracts` and `packages/web`), ESLint, `pnpm check:boundaries`, `pnpm check:no-request-scope`, `pnpm check:table-ownership --strict`; confirm no `sequelize.transaction` in `libs/composition` and no `// S54 T037 audit` comment left in touched files.
- [ ] T055 Run the whole capability once: `/opt/sdd/repo/scripts/sdd/test-spec.sh libs/composition/bff` (unit + P + G + S + B). Fix failures (max 5 attempts per test, then write the blocker into `SD/questions.md`). Report which follow-ups from S01, S02, S05, S10, S13, S32, S34, S35, S50 were implemented and where.

---

## Dependencies and order

- Phase 1 → Phase 2 (blocks all) → US1 → US2 (extends the same service) ; US3 needs Phase 2 and T021/T043 credentials for identity fields; US4 needs Phase 2 and feeds T021/T043; US5 after US1–US4; Phase 8 after the contracts (T004) and, for T047, after US3; Phase 9 last.
- Within a story, test tasks precede their code tasks; tasks touching the same file are sequential (no `[P]`).
- Gap coverage: C1 T004; C2/C3 T005,T013,T014; C4 T007; A1–A11 T017–T026; A12/A13 T013,T014; G1–G10 T010–T011, T027–T033; S1 T034–T043; S2 T021,T043; S3 T046–T047; S4 T013,T014; S5 T007; T1–T3,T5,T7 T012,T016; T4 T017–T044; T6 T008,T010; T8 T051; debt table T001,T045.

## Parallel examples

- Phase 2: T003/T005/T008/T015 in parallel (different files); then T004/T009.
- US3 and US4 can proceed in parallel after Phase 2 (T027–T033 vs T034–T043), joining at T043.
- Phase 8: T046, T048, T049, T050 in parallel.

## Implementation strategy

MVP = Phase 1 + 2 + US1 (a correct, validated product-page aggregate on the new upstream layer). Then US2 (resilience), US4 (session, security-critical), US3 (GraphQL), US5 and web/gates.
