# Feature Specification: S48 — BFF composition (product-page aggregate with budgets and partial errors, GraphQL with batching and limits, browser session handling) — domain `composition`

**Feature Branch**: `S48-bff` (spec directory only; no branch was created)

**Created**: 2026-10-06

**Status**: Draft

**Input**: User description: "BFF composition: product-page aggregate with budgets and partial errors, GraphQL with DataLoaders and limits, session handling", sources `SD-04-bff-graphql`, `04-API-Design/01-rest-design-and-chatty-apis` (§1.1, §2.1, §2.2, §2.6), `10-System-Design/04-web-platform-architectures` (§4), `05-Security/02-authentication-authorization` (§3, token storage).

## Summary

The BFF is the one place where a client screen is assembled from several domains. It owns no data and no business rules (constitution X.8, IX.7 **R2**). This capability covers three things:

1. **The product-page aggregate**: one request returns the product and ten optional sections. Calls run in parallel, each with its own time budget, and a slow or broken optional section never fails the page.
2. **GraphQL for mobile and other non-browser clients**: batched loading so a list of N products costs a constant number of upstream calls, hard limits on depth, cost and size, trusted (persisted) documents only, and partial errors that tell the client which field failed and why.
3. **Browser session handling (token handler)**: the browser holds only an opaque HttpOnly cookie; access and refresh tokens stay on the server, refresh is serialized per session, and every cookie-authenticated state-changing request is CSRF-protected.

## Scope

In scope:

- `GET /api/bff/product-page/:productId`, its section registry, budgets, error envelope, circuit breaking, concurrency bounds, shared-cache rules, request coalescing and keep-alive reuse.
- `POST|GET /api/graphql`: schema (read-only), per-request loaders, limits, persisted documents, introspection policy, rate limiting by cost, error format.
- `POST /api/bff/session` (login), `POST /api/bff/session/mfa`, `GET /api/bff/session`, `POST /api/bff/session/logout`: session store, cookies, CSRF, origin check, refresh single-flight, expiry, fail modes.
- Propagation of the auth context (session token or bearer token, anonymous visitor ID, request ID, trace context) to domain APIs, and what is never propagated.
- The contract schemas the BFF publishes in `packages/contracts` and the schemas it uses to validate every upstream answer.

Out of scope (owned elsewhere):

- Any domain's behaviour: the BFF re-tests none of it. Product visibility, recommendation ranking, flag evaluation, chat unread counts, prices, stock, discounts, and authorization decisions belong to their domains (S05, S34, S35, S38, S24, S25, S30, S19, S11, S21, S03).
- Credential checking, MFA code checking, token issuing and rotation, session revocation, brute-force limits: **S01**, **S02**. The BFF calls them over HTTP and relays their answers.
- OIDC browser redirect flows: the OIDC callback of S02 sets its own cookies on the shared origin and does not go through the BFF session (see Assumptions).
- Rendering and UI state: **W01** (login screens), **W02** (product page), other web capabilities.
- The widget orchestration (`libs/composition/widget`): **S44**.
- The rate-limiter implementation: **S50**. Platform error filter, config validation, request context, resilient HTTP client: **S54**.
- Mutations of any domain. This version of the GraphQL schema is read-only (see FR-050).

Cross-domain data used (constitution IX.7): **R2 only**: every domain datum shown here comes from that domain's HTTP API, called in parallel with per-call timeouts. No R1 import (X.8.2 forbids `@app/domains/*` imports) and no R3 read model: the BFF owns no table and no projector (X.8.1).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - One request renders the product page (Priority: P1)

A visitor (anonymous or signed in) opens a product page. The web server or a mobile client makes one request and receives the product plus every section the page can show: shop, recommendations, trending in the category, feature flags, unread chat (signed-in only), top discussions, videos, pickup near me (only when the client gives a location), the current flash sale and the current auction.

**Why this priority**: it removes the chatty client (04/01 §1) and is the capability's reason to exist.

**Independent Test**: start the BFF with every domain API stubbed at the network boundary using contract-valid fixtures; call the endpoint; assert the body, the upstream calls made and their order.

**Acceptance Scenarios**:

1. **AS-01** — **Given** a visible product `P` of shop `S` and every domain API answering normally, **When** an anonymous visitor calls `GET /api/bff/product-page/P` with `X-Anonymous-Id: anon_12345678`, **Then** `200` with `Cache-Control: private, no-store` and a body that parses with `productPageResponseSchema`: `product` (the S05 public view, money as `priceMinor` + `currency`), `shop` (`{id, name, slug}`), `recommendations`, `trending`, `flags`, `discussions`, `videos`, `flashSale` and `auction` each holding the owning domain's validated body unchanged, `chatUnread: null`, `pickup: null`, and `errors: []`.
2. **AS-02** — **Given** an anonymous visitor, **When** the page is requested, **Then** the chat API is not called, `chatUnread` is `null` and there is **no** entry for it in `errors` (a section that does not apply is not an error); **And** no upstream call carries an `Authorization` header; **And** the flags call carries the visitor's `X-Anonymous-Id`.
3. **AS-03** — **Given** a signed-in browser session (cookie), **When** the page is requested, **Then** the flags and chat calls carry `Authorization: Bearer <that session's access token>`, `chatUnread` is the chat API's unread page passed through unchanged (including its `nextCursor`; the BFF does not sum or filter it), and no upstream call carries the browser's `Cookie` header.
4. **AS-04** — **Given** the shop batch answers `null` for the product's shop (hidden, suspended, sandbox) or the product has no `shopId`, **When** the page is requested, **Then** `shop` is `null` with no entry in `errors`; **When** the product has no `shopId`, **Then** the shop API is not called.
5. **AS-05** — **Given** the pickup section needs a location, **When** the request has no `lat`/`lng`, **Then** `pickup` is `null`, no error entry, and the pickup API is not called; **When** it has `lat=50.45&lng=30.52&radiusKm=10`, **Then** the pickup API is called once with those values and `productId` and `limit`, and `pickup` holds its body; **When** `lat=91`, `lng` missing while `lat` present, `radiusKm=0` or `radiusKm=101`, **Then** `400` `validation_failed` and no upstream call.
6. **AS-06** — **Given** every upstream answer is delayed by 300 ms, **When** the page is requested, **Then** the sections that depend only on the product ID start at the same instant as the product call (not after it), the shop and trending calls start only after the product answered (they need its `shopId` and `category`), and the total time is less than the sum of the delays (at most the product delay plus the longest dependent section delay, plus 100 ms of tolerance), not ten times 300 ms.
7. **AS-07** — **Given** the product API answers `404` (unknown, archived or invisible), **When** the page is requested, **Then** `404` problem+json `not_found`, and every outstanding optional call is aborted (the stub sees the connections closed) so no work continues after the answer.
8. **AS-08** — **When** the path ID is not a UUID, **Then** `400` `validation_failed` and no upstream call is made.
9. **AS-09** — **Given** the product API answers `503` once and then `200`, **When** the page is requested, **Then** `200` after exactly two product calls (one retry with jittered backoff inside the product budget); **Given** it answers `503` twice, **Then** `503` problem+json `upstream_unavailable` with `Retry-After`, a generic `detail`, no upstream message, and exactly two product calls; **Given** it answers `400` or `404`, **Then** no retry.
10. **AS-10** — **Given** the product API answers a body that does not parse with `productPublicSchema`, **When** the page is requested, **Then** `502` problem+json `upstream_invalid` with a generic `detail` (no field names, no upstream body), and the validation failure is logged with the request ID.
11. **AS-11** — **Given** a request that carries a bearer token and an upstream (any credentialed call) answers `401`, **When** the page is requested, **Then** the whole response is `401` problem+json `invalid_token` (the client must refresh or sign in; a silently degraded page would hide an expired credential), and the other calls are aborted.

---

### User Story 2 - A slow or broken section never breaks the page (Priority: P1)

Every optional section has its own time budget; the whole page has a hard deadline. A section that times out, fails, answers garbage, or sits behind an open breaker becomes `null` plus a machine-readable entry in `errors`. The other sections are untouched.

**Why this priority**: tail latency equals the slowest component (04/01 §2.1); budgets and partial responses are the stated mitigation and the pattern P0402/P0620.

**Independent Test**: stub one upstream at a time as slow, failing or invalid; assert the page answers within its budget with exactly that section degraded.

**Acceptance Scenarios**:

1. **AS-12** — **Given** the recommendations API is stubbed to answer after 500 ms (budget 300 ms), **When** the page is requested, **Then** `200`, `recommendations: null`, `errors: [{section: "recommendations", code: "UPSTREAM_TIMEOUT", retryable: true}]`, every other section intact, the total time less than the sum of the per-call delays and at most 100 ms above the longest budget, and the recommendations request aborted on the upstream side.
2. **AS-13** — **Given** each optional section in turn answers `503`, `404`, `429`, a connection reset, or a body that does not parse with its contract schema, **When** the page is requested, **Then** the page is `200`, that section is `null` and `errors` holds one entry whose `code` is respectively `UPSTREAM_UNAVAILABLE`, `UPSTREAM_NOT_FOUND`, `UPSTREAM_RATE_LIMITED`, `UPSTREAM_UNAVAILABLE`, `UPSTREAM_INVALID` (`retryable` true for the first, third and fourth, false for the second and last); the `errors` entries contain only `section`, `code`, `retryable` (no message text, upstream URL or body).
3. **AS-14** — **Given** one optional section fails, **Then** the other nine are byte-identical to a run where nothing failed; **Given** all ten optional sections fail at once, **Then** the page is still `200` with `product`, ten `null` sections and ten error entries (only the product is required).
4. **AS-15** — **Given** the trending API (budget 200 ms) answers a valid `trendingResponseSchema` body, including one with empty `items`, **When** the page is requested, **Then** `trending` equals that body unchanged: no ranking, no filtering, no re-pricing in the BFF; **Given** it answers slower than 200 ms, `503`, `429` or an invalid body, **Then** `trending: null` and the matching error entry, other sections intact. The same holds for recommendations (`recommendationsResponseSchema`, budget 300 ms, `limit=8`).
5. **AS-16** — **Given** the product answers after 700 ms and the shop API (budget 300 ms) would answer after 600 ms, **When** the page is requested, **Then** the shop call gets only the time left until the overall deadline (1,000 ms), `shop: null` with `BUDGET_EXCEEDED`, and the total time is at most 1,100 ms; **Given** the product itself is slower than its 800 ms budget, **Then** `503` `upstream_unavailable`.
6. **AS-17** — **Given** an optional upstream that failed or timed out on 5 consecutive calls within 10 s, **When** the next requests arrive, **Then** its breaker is open: the call is **not** made, the section is `null` with `CIRCUIT_OPEN` (`retryable: true`), and the page is `200` without waiting; **When** 10 s have passed, **Then** exactly one probe call is allowed and its success closes the breaker (the next request calls normally), its failure re-opens it for another 10 s; breaker state is per upstream and per BFF instance, and one section's breaker never affects another's.
7. **AS-18** — **Given** an upstream already has 100 calls in flight from this instance, **When** another page request needs it as an optional section, **Then** the call is not made and the section is `null` with `UPSTREAM_OVERLOADED`; **When** the product call itself cannot get a slot, **Then** `503` `overloaded` with `Retry-After: 1`; and a single page request never has more than 12 upstream calls in flight.
8. **AS-19** — **Given** a public section's upstream answers with `Cache-Control: public, s-maxage=5`, **When** two page requests (different visitors) arrive 2 s apart, **Then** the upstream is called once for that section; **When** the second arrives 6 s later, **Then** it is called again; **Given** the upstream answers `private`, `no-store` or no caching header, **Then** every request calls it; **Given** any section marked as depending on the caller (flags, chat), **Then** it is never stored in the shared cache and user A's data is never served to user B or to an anonymous visitor; entries never live longer than 30 s regardless of the upstream header.
9. **AS-20** — **Given** 50 simultaneous page requests for the same product from 50 different visitors, **When** they arrive within the same 50 ms, **Then** each public upstream (product, shop, recommendations, trending, discussions, videos) is called once for them all (single flight), and each visitor's personal sections (flags, chat) are still called once per visitor.
10. **AS-21** — **Given** a request with `X-User-Id`, `X-User-Role`, `X-Tenant-Id`, `X-Shop-Id`, `Cookie`, `X-Forwarded-Host` and a syntactically invalid `X-Anonymous-Id` (`"a b"`), **When** the page is requested, **Then** none of these reach any upstream; a valid `X-Anonymous-Id` (8–64 characters of `[A-Za-z0-9_-]`) does reach the flags call only; `Authorization` reaches only the sections declared as needing identity (flags, chat; never product, shop, recommendations, trending, discussions, videos, pickup, flash sale or auction); the request ID and trace context are propagated to every call; **Given** an upstream answers `302` to another host, **Then** the redirect is not followed, the second host receives no request and no token, and the section is `UPSTREAM_UNAVAILABLE`.
11. **AS-22** — **Given** a principal (session user, or client address when anonymous) that already made 300 page requests in the current minute, **When** it sends the 301st, **Then** `429` problem+json `rate_limited` with `Retry-After` and no upstream call; another principal is not affected.
12. **AS-23** — **When** any page request completes, **Then** a per-section outcome metric (`ok`, `error code`, `skipped`) and a per-section duration are recorded, the response carries a `Server-Timing` header with one entry per section, and the structured log line carries the request ID, the section outcomes, and no token, cookie, email or upstream body.
13. **AS-24** — **Given** 30 sequential page requests (10 upstream calls each) against stubs that count TCP connections, **When** they complete, **Then** the stub saw at most 10 connections per upstream host (keep-alive pool reuse), not 300.

---

### User Story 3 - Mobile clients query a graph without N+1 or abuse (Priority: P1)

A mobile client sends a GraphQL query for several products with their shops and recommendations. The BFF resolves it with a constant number of upstream calls, refuses queries that are too deep, too costly or too large before touching any domain, accepts only trusted documents in production, and tells the client precisely which field degraded.

**Why this priority**: the second named deliverable (04/01 §2.6 and P0405/P0307).

**Independent Test**: send queries against stubbed domain APIs; count upstream calls and compare the response with the expected `data` and `errors`.

**Acceptance Scenarios**:

1. **AS-25** — **Given** 20 visible products of one shop, **When** a client sends `{ products(ids: $ids) { id title shop { name } } }` with the 20 IDs, **Then** `200`, `data.products` has 20 items in request order, and the domain stubs saw exactly one product batch call and one shop batch call (not 20 + 20).
2. **AS-26** — **Given** `products(ids: [A, B, A, C])` where `B` is invisible, **When** executed, **Then** the product batch call carries `A, B, C` once each, and the result is four items `[A, null, A, C]` (same length and order as the request, `null` for the invisible one, no error entry for it).
3. **AS-27** — **Given** three aliased `products` fields with 50 distinct IDs each in one query (150 IDs), **When** executed, **Then** the product batch calls are two (100 + 50 IDs, never more than 100 per call) and all 150 results are returned.
4. **AS-28** — **Given** two clients (different principals) run the same query at the same moment, **When** both execute, **Then** each makes its own batch calls carrying only its own credentials (if any), a result loaded for one is never served to the other, and a second identical request repeats the upstream calls (loaders live for one request only).
5. **AS-29** — **Given** the product batch answers `503`, **When** a query asks `products(ids: $ids) { id }` and `product(id: X) { shop { name } }`, **Then** `200` with `errors[]` entries whose `path` points to the failed fields and `extensions.code` is `UPSTREAM_UNAVAILABLE`, those fields `null`, and fields that did not depend on the failed batch intact; each failed batch is reported once per path, not once per ID, and no upstream message or URL appears in the error.
6. **AS-30** — **Given** the recommendations API answers after 500 ms (budget 300 ms), **When** a query selects `product(id: X) { id recommendations { id title } }`, **Then** `data.product.recommendations` is `null` and `errors` has one entry with `path: ["product","recommendations"]` and `extensions.code: "UPSTREAM_TIMEOUT"`; the rest of the product is returned; recommendation product bodies are loaded through the same batching loader (not one call per recommendation) and use the `items` of the recommendations envelope as given.
7. **AS-31** — **Given** a query nested deeper than 6 levels, **When** sent, **Then** `400` with a GraphQL error `extensions.code: "QUERY_TOO_DEEP"`, `Cache-Control: no-store`, and **zero** upstream calls were made.
8. **AS-32** — **Given** a query whose estimated cost exceeds 2,000 (cost = one unit per field times the sizes of the lists above it, where list sizes come from literals **and from variable values**, and recommendations count as 8), **When** sent with the IDs as a literal and again with the IDs as a variable, **Then** both are rejected with `QUERY_TOO_COSTLY` and zero upstream calls; a query whose cost is exactly 2,000 is accepted; fragments and inline fragments are priced like the fields they contain; a fragment cycle is reported as a validation error and never loops.
9. **AS-33** — **Given** a query with 21 root fields (aliases), **When** sent, **Then** `400` `TOO_MANY_ROOT_FIELDS`; **Given** a JSON array body (operation batching), **Then** `400` problem+json `batching_not_supported`; **Given** a document larger than 8 KB, **Then** `413` problem+json `payload_too_large` before parsing; **Given** a body that is not `application/json`, **Then** `415` `unsupported_media_type`.
10. **AS-34** — **Given** `products(ids: [51 IDs])`, **When** executed, **Then** `400` `BAD_USER_INPUT` naming the argument and the maximum (50), not a silent truncation; `ids: []` returns `[]` with no upstream call; a non-UUID ID is `BAD_USER_INPUT`; `first` above 50 is `BAD_USER_INPUT`.
11. **AS-35** — **Given** an operation deadline of 2,000 ms and an upstream that answers after 5 s, **When** a query is sent, **Then** the response arrives within 2,100 ms, the unfinished fields are `null` with `extensions.code: "BUDGET_EXCEEDED"`, and the upstream requests are aborted.
12. **AS-36** — **Given** a principal (session user, or client address when anonymous) with a cost budget of 20,000 units per minute, **When** its accepted queries have consumed the budget, **Then** the next query is `429` problem+json `rate_limited` with `Retry-After` and `RateLimit-*` headers and no upstream call; the amount charged for an accepted query is its computed cost; a query rejected by the limits (AS-31..AS-34) is charged 1 unit; another principal is unaffected.
13. **AS-37** — **Given** trusted-documents enforcement (every environment except an explicitly configured local development mode), **When** a client sends a known hash with variables, **Then** the stored document executes; **When** an unknown hash, **Then** `200` with `extensions.code: "PERSISTED_QUERY_NOT_FOUND"` and no data (the standard persisted-query protocol); **When** it sends only a query text and no hash, **Then** `400` problem+json `persisted_query_required`; **When** it sends a hash and a text that does not hash to it, **Then** `400` `persisted_query_mismatch` and nothing is registered (the allowlist cannot grow at runtime); **Given** local development mode, **Then** ad-hoc text is accepted.
14. **AS-38** — **Given** a known hash sent with `GET` and no credentials (no `Authorization`, no session cookie), **When** executed, **Then** `200` with `Cache-Control: public, s-maxage=5` and `Vary` listing `Authorization, Cookie, X-Anonymous-Id`; **Given** any credential, **Then** `Cache-Control: private, no-store`; **Given** `GET` with a raw query text, or any `GET` that is not a query, **Then** `400`.
15. **AS-39** — **Given** the allowlist at startup, **When** any entry's key is not the SHA-256 of its document, or its document does not validate against the schema and the limits above, **Then** the BFF refuses to start and names the entry.
16. **AS-40** — **Given** production configuration, **When** a client asks `{ __schema { types { name } } }` or `__type`, **Then** a validation error `INTROSPECTION_DISABLED` and zero upstream calls; in non-production configuration introspection works; **When** a client sends a `mutation` or `subscription`, **Then** a validation error (the schema has none) and zero upstream calls.
17. **AS-41** — **Given** the schema, **Then** money is `priceMinor` (a lossless integer scalar serialized as a decimal string) plus `currency`, no floating-point field exists for money, the printed schema equals the committed snapshot (a diff fails the build), and a field removed or retyped without first being `@deprecated` fails the same check.
18. **AS-42** — **Given** a bearer token on a GraphQL request, **When** a field needs identity, **Then** the token is sent only on that field's upstream call; public fields (product, shop, recommendations) are called without it; **Given** a cookie-authenticated `POST /api/graphql`, **When** the CSRF header is missing or the `Origin` is not allowed, **Then** `403` `csrf_invalid` / `origin_not_allowed` and zero upstream calls.

---

### User Story 4 - The browser never holds a token (Priority: P1)

A shopper signs in through the BFF. The browser receives only an opaque, HttpOnly session cookie and a CSRF cookie. The BFF keeps the access and refresh tokens, refreshes them once at a time, forwards the access token to domain APIs, and ends the session cleanly when the identity service says the refresh token is spent.

**Why this priority**: the BFF token-handler pattern is the recommended browser storage (05/02 §3, P0512) and constitution VI.2. S01 requires this capability to serialize refresh because reuse of a refresh token is fatal.

**Independent Test**: stub S01/S02 at the network boundary; log in, call the page and GraphQL with the cookie, advance the clock, and assert tokens, cookies and upstream calls.

**Acceptance Scenarios**:

1. **AS-43** — **Given** a registered user, **When** `POST /api/bff/session {email, password}` is sent with an allowed `Origin`, **Then** the BFF calls S01 `POST /api/auth/login` (body delivery) once and answers `200 {user: {id, email, role}, expiresAt}` with `Cache-Control: no-store`; the response sets `__Host-bff-session` (`HttpOnly; Secure; SameSite=Lax; Path=/`, no `Domain`) and `__Host-bff-csrf` (`Secure; SameSite=Lax; Path=/`, readable by scripts); no access token, refresh token or token digest appears in the body, headers or any cookie; the session store holds one record whose key is the SHA-256 of the cookie value and whose tokens are encrypted at rest (the stored bytes contain neither token).
2. **AS-44** — **Given** a login request whose `Origin` is not allowed (or, with no `Origin`, `Sec-Fetch-Site: cross-site`), **When** sent, **Then** `403` `origin_not_allowed`, no `Set-Cookie`, no session, and S01 was not called (login CSRF).
3. **AS-45** — **Given** wrong credentials, an unknown address, a rate-limited client, or an overloaded identity service, **When** login is sent, **Then** the BFF relays S01's answer: `401 invalid_credentials` (identical body for an unknown address), `429 rate_limited` with `Retry-After`, `503` with `Retry-After`; no `Set-Cookie`, no session; a request with a missing field, an extra field, a body above 16 KB (`413`), or a non-JSON body (`415`) is rejected by the BFF before any upstream call (`400 validation_failed`).
4. **AS-46** — **Given** the BFF sits behind the platform proxy, **When** login (or refresh, or logout) is relayed, **Then** the identity call carries the real client address in `X-Forwarded-For` (the BFF appends to the chain it trusts), so S01's per-IP limits apply to the shopper and not to the BFF's own address; a client-supplied `X-Forwarded-For` from an untrusted peer is ignored.
5. **AS-47** — **Given** a browser that already holds an active session cookie, **When** it logs in again, **Then** a new session ID is issued, the old record is deleted at once (the old cookie value is now unknown), and the old identity session is revoked best-effort (a failure of that call does not fail the login); session IDs are never reused or accepted from the client (session fixation).
6. **AS-48** — **Given** a user with a second factor, **When** login is sent, **Then** the BFF relays S01's challenge by answering `200 {mfaRequired: true}`, sets only `__Host-bff-mfa` (`HttpOnly; Secure; SameSite=Lax; Path=/api/bff/session; Max-Age=300`), stores the challenge token server-side, and returns no challenge token to the browser; `POST /api/bff/session/mfa {code}` with that cookie and a valid CSRF token calls S02 `POST /api/auth/mfa/verify {mfaToken, code}` and, on success, creates the active session exactly as AS-43 (new session ID) and deletes the pending record.
7. **AS-49** — **Given** the session states `PENDING_MFA → ACTIVE → ENDED`, **When** `POST /api/bff/session/mfa` is sent with no pending cookie, with a pending cookie older than 5 minutes, or while the browser already holds an active session and no pending cookie, **Then** `409` `mfa_not_pending` and S02 is not called; **When** the code is wrong, **Then** S02's `401` is relayed and the pending state stays until S02 says the challenge is spent; **When** S02 says the challenge is spent or expired, **Then** the pending record is deleted and the answer is `401 invalid_token`.
8. **AS-50** — **Given** one pending login, **When** two `POST /api/bff/session/mfa` requests with the right code arrive at the same moment (two BFF instances), **Then** exactly one answers `200` and creates a session, the other answers `409` `mfa_not_pending`, and exactly one active session record exists afterwards.
9. **AS-51** — **Given** an active session, **When** `GET /api/bff/session` is sent with the cookie, **Then** `200 {user: {id, email, role}, expiresAt}` with `Cache-Control: no-store`; **When** it is sent with no cookie, with a random cookie value, or with the stored key (the hash) as the cookie value, **Then** `401` `unauthenticated`, and an unknown cookie is cleared in the response.
10. **AS-52** — **Given** a session idle for 24 hours, or older than 30 days, or whose identity session has ended, **When** any request uses its cookie (clock frozen and advanced), **Then** the session is `ENDED`: the record is deleted, the cookies are cleared, `GET /api/bff/session` answers `401` `session_expired`, and a public read (page, GraphQL) is served as anonymous; use within 24 hours extends the idle deadline (the extension is written at most once a minute), never the 30-day limit.
11. **AS-53** — **Given** an active session whose access token expires in 20 seconds (refresh skew 30 s), **When** a request needs the token, **Then** the BFF first calls S01 `POST /api/auth/refresh {refreshToken}` once, stores the rotated tokens, and forwards the **new** access token; a token with more than 30 seconds left is used as is, with no refresh call.
12. **AS-54** — **Given** 20 simultaneous requests on one session whose access token has expired, spread over two BFF instances, **When** they arrive, **Then** exactly one `POST /api/auth/refresh` reaches the identity stub (single flight per session across instances), all 20 requests succeed and use the rotated access token, and the identity stub saw the refresh token exactly once.
13. **AS-55** — **Given** S01 answers the refresh with `401 invalid_refresh_token` (spent, reused or revoked), **When** a request triggers it, **Then** the session is `ENDED`: record deleted, cookies cleared, `401` `session_expired`; a later request with the same cookie is anonymous or `401`; the BFF never retries a refresh and never presents the same refresh token twice.
14. **AS-56** — **Given** the identity service times out or answers `503` on refresh, **When** the access token is still valid for more than 0 seconds, **Then** the request proceeds with it and the session is kept; **When** it has already expired, **Then** `503` `session_unavailable` with `Retry-After`, the session is kept (a transient failure never destroys it), and the refresh call was made exactly once (not retried).
15. **AS-57** — **Given** S01 rotated the tokens but the first session-store write fails, **When** the BFF retries the write (at most 3 attempts), **Then** a retry that succeeds leaves a usable session; **When** all attempts fail, **Then** the session is ended fail-closed (the user signs in again), the request answers `503` `session_unavailable`, and no spent refresh token is ever presented again.
16. **AS-58** — **Given** an active session, **When** `POST /api/bff/session/logout` is sent without `X-CSRF-Token`, **Then** `403` `csrf_invalid` and the session is still active; **When** it is sent with a valid CSRF token, **Then** `204`, the record is deleted, all BFF cookies are cleared (`Max-Age=0`, same attributes), and S01 `POST /api/auth/logout` was called with the session's access token; **When** S01 is down, **Then** the answer is still `204` and the local session is gone; **When** logout is replayed with the old cookie, or with no cookie, **Then** `204` again with no upstream call (idempotent).
17. **AS-59** — **Given** a cookie-authenticated `POST` (login excluded, which is covered by the origin check), **When** `X-CSRF-Token` is missing, is not equal to the `__Host-bff-csrf` cookie, or was issued for another session, **Then** `403` `csrf_invalid`; **When** it is valid, **Then** the request proceeds; `GET` requests and requests authenticated only by `Authorization: Bearer` are exempt; the token is a keyed MAC over the session ID and a random part, compared in constant time.
18. **AS-60** — **Given** a request carrying both the session cookie and an `Authorization` header, **When** sent to any BFF endpoint, **Then** `400` `ambiguous_credentials` and no upstream call.
19. **AS-61** — **Given** the session store is unreachable, **When** an anonymous request (no cookie, no bearer) arrives, **Then** it is served normally; **When** a request carries a session cookie, **Then** `503` `session_unavailable` with `Retry-After` (never silently served as anonymous), and readiness of the BFF does not fail because of it (it reflects startup and shutdown only).
20. **AS-62** — **Given** sessions of user A and user B used in an interleaved way on the page and GraphQL endpoints, **When** each calls flags and chat, **Then** each upstream call carries exactly its own session's token, no response of A is ever returned to B, and an unknown, forged or logged-out cookie never yields a signed-in view.
21. **AS-63** — **Given** the access token is meant only for the platform API, **When** the BFF builds an upstream call, **Then** a token is attached only to calls whose base URL is the configured domain-API origin; any other target (a redirect, a URL from a response body, a misconfigured section) is refused at startup or at call time, and the configuration is validated at startup (a missing or malformed upstream URL stops the process; no `localhost` default).

---

### User Story 5 - The BFF stays composition only (Priority: P2)

The BFF has no data, no domain imports and no business rules, so it cannot become a "god BFF" (10/04 #4, constitution X.8).

**Independent Test**: static checks plus a module-graph assertion.

**Acceptance Scenarios**:

1. **AS-64** — **Given** the BFF sources and the booted BFF application, **Then** `pnpm check:boundaries` and `pnpm check:table-ownership --strict` report nothing for `composition`, the ownership registry has no entry for it, no provider uses request scope (loaders are created per request in the request context instead), it imports only the X.8.4 infrastructure allowlist (`http-client`, `net`, `cache`, `redis`, `rate-limit`), the booted application has no database, queue or event-bus provider, and a GraphQL or REST handler contains no price, discount, total, tax or stock computation and no branching on a domain status value other than present/absent.

### Edge Cases

- A product page request while the session store is down: AS-61. While identity is down: AS-56. While one upstream is down: AS-13, AS-17.
- Two refreshes of one session at once: AS-54 (single flight). A refresh whose result cannot be stored: AS-57.
- The BFF's own replay behaviours: logout is idempotent (AS-58); login is not idempotent by design (each success is a new session, AS-47); there are no `Idempotency-Key` endpoints because the BFF creates no order, payment, booking, bid or ledger movement (V.6).
- Illegal state transitions of the session: AS-49 (MFA without a pending login, expired pending, already active); a refresh on an ended session: AS-55.
- Cross-tenant or cross-user access: AS-03, AS-21, AS-62 (identity of each call comes only from the session; client identity headers never forwarded); the BFF makes no record-level decision (domains decide), so it has no `404`-vs-`403` choice to make.
- Limits and timeouts: AS-12, AS-16, AS-18, AS-22, AS-31–AS-36.
- Duplicate or out-of-order events: not applicable. The BFF consumes and publishes no events (X.8.4 forbids it), so VII.4 does not apply.
- Hostile inputs: product ID not a UUID (AS-08), invalid coordinates (AS-05), invalid anonymous ID (AS-21), oversized or non-JSON bodies (AS-33, AS-45), alias floods (AS-33), IDs above caps (AS-34).

## Requirements *(mandatory)*

### Functional Requirements

**Product-page aggregate (P0402, P0101, P0620)**

- **FR-001**: `GET /api/bff/product-page/:productId` returns the product (required) and these optional sections: `shop` (S03 batch, public fields), `recommendations` (S34, `limit=8`), `trending` (S35, product's category), `flags` (S38), `chatUnread` (S24, signed-in only), `discussions` (S25 hot posts, `limit=3`), `videos` (S30), `pickup` (S19, only with `lat`/`lng`), `flashSale` (S11, `productIds=`, first element or `null`) and `auction` (S21, `productIds=`, first element or `null`). Every section is one declared entry (name, upstream call, budget, whether it needs identity, whether it can be shared-cached, contract schema), so adding a section changes one entry. (AS-01..AS-05)
- **FR-002**: Section budgets (per call): product 800 ms; shop 300; recommendations 300; trending 200; flags 150; chatUnread 200; discussions 300; videos 300; pickup 300; flashSale 200; auction 200. The whole page has a deadline of 1,000 ms; a dependent section's budget is the smaller of its own and the time left. (AS-12, AS-16)
- **FR-003**: Calls that need only the product ID start at the same instant as the product call; calls that need product fields (`shop` needs `shopId`, `trending` needs `category`) start when the product answers. Total time is the product time plus the slowest dependent section, never the sum. (AS-06)
- **FR-004**: A section that is not applicable (anonymous for chat, no coordinates for pickup, no `shopId`) is `null` with no error entry and no upstream call; an upstream that answers "nothing" (a `null` batch item, an empty list for flash sale or auction) is `null` with no error entry. (AS-02, AS-04, AS-05)
- **FR-005**: A failed optional section is `null` plus one `errors` entry `{section, code, retryable}`. Codes: `UPSTREAM_TIMEOUT`, `UPSTREAM_UNAVAILABLE`, `UPSTREAM_NOT_FOUND`, `UPSTREAM_RATE_LIMITED`, `UPSTREAM_INVALID`, `UPSTREAM_OVERLOADED`, `CIRCUIT_OPEN`, `BUDGET_EXCEEDED`. The entry never carries a message, URL or upstream body (V.3). The response is `200` whenever the product is available. (AS-12, AS-13, AS-14)
- **FR-006**: Required-part failures: unknown or invisible product `404 not_found`; invalid path or query `400 validation_failed`; product slower than its budget or `5xx` after the allowed retry `503 upstream_unavailable` with `Retry-After`; invalid product body `502 upstream_invalid`; an upstream `401` on a credentialed call `401 invalid_token`; no slot for the product `503 overloaded`. Errors are RFC 9457 problem+json with `requestId` and generic `detail` for 5xx. (AS-07..AS-11)
- **FR-007**: Only the product call is retried (once, on connection reset, timeout or `502/503/504`, with full-jitter backoff, only if the remaining product budget is at least 300 ms); optional sections are never retried; retries happen in exactly one layer. (AS-09)
- **FR-008**: Every upstream answer is validated with the owning capability's contract schema before use; a mismatch is `UPSTREAM_INVALID` (or `502` for the product). The BFF forwards each section's body unchanged: no ranking, filtering, renaming of business fields, summing, re-pricing or status branching (X.8.3). The only shaping allowed is field selection, nesting under the section name, unwrapping the one-element `flash-sales` / `auctions` arrays, and merging the shop by `shopId`. (AS-01, AS-15)
- **FR-009**: Per-upstream circuit breaker for optional sections: open after 5 consecutive failures within 10 s, stay open 10 s, then one probe call; a breaker is per upstream and instance. (AS-17)
- **FR-010**: Bounded concurrency: at most 12 upstream calls in flight per page request and at most 100 in flight per upstream per instance; beyond the per-upstream cap an optional section is skipped with `UPSTREAM_OVERLOADED` and the product call answers `503 overloaded`. (AS-18)
- **FR-011**: Shared cache of shaped upstream bodies: only sections that do not depend on the caller, only when the upstream answers a shared-cacheable `Cache-Control` (`public` / `s-maxage`), never longer than 30 s, never for `private` / `no-store` or absent headers, never for flags, chat or any call carrying identity. Identical concurrent calls for a public section are coalesced into one. (AS-19, AS-20)
- **FR-012**: The page response is `Cache-Control: private, no-store` and carries `Server-Timing`, because it holds per-visitor flags. (AS-01, AS-23)
- **FR-013**: The page endpoint is rate limited per principal (session user, else client address): 300 requests per minute, `429 rate_limited` with `Retry-After`. (AS-22)
- **FR-014**: Upstream connections are pooled and kept alive and reused across requests. (AS-24)
- **FR-015**: Pass-through of pagination: `chatUnread`, `discussions` and any other paged section return the owning domain's `nextCursor` untouched. (AS-03)

**Auth context propagation (P0512, IV.7)**

- **FR-020**: Identity for upstream calls comes only from the session (resolved from the cookie) or from an `Authorization: Bearer` header (native clients; forwarded unchanged). A request with both is `400 ambiguous_credentials`. (AS-03, AS-60)
- **FR-021**: The identity token is attached only to sections that declare they need it, and only to the configured domain-API origin. Redirects are never followed. `X-User-Id`, `X-User-Role`, `X-Tenant-Id`, `X-Shop-Id`, `Cookie` and forwarding headers from the client are never forwarded; `X-Anonymous-Id` is forwarded only when valid (8–64 of `[A-Za-z0-9_-]`) and only to sections that use it. The request ID and trace context are propagated. (AS-02, AS-21, AS-63)
- **FR-022**: An upstream `401` on a credentialed call ends the page request with `401 invalid_token`; the BFF makes no authorization decision other than "is there a valid session or bearer" (domains decide record access). (AS-11)

**GraphQL (P0405, P0307, P0215)**

- **FR-030**: Each GraphQL request gets its own set of batching loaders (product, shop). Loaders are created per request in the request context, never in request-scoped providers and never shared between requests or principals. A loader batches all loads of one tick into at most one upstream call per 100 distinct IDs, de-duplicates IDs, returns results in request order with the same length (`null` for invisible items), and isolates a failed batch from other batches. (AS-25..AS-29)
- **FR-031**: Loaders use the owning domain's batch endpoints (`GET /batch/products?ids=`, `GET /batch/shops?ids=`, ≤ 100 IDs) with their own timeouts (product 800 ms, shop 500 ms); recommendations are loaded from the S34 envelope and then through the product loader. (AS-25, AS-30)
- **FR-032**: Field-level degradation is reported in the standard GraphQL `errors` array with `path` and `extensions.code` (`UPSTREAM_TIMEOUT`, `UPSTREAM_UNAVAILABLE`, `UPSTREAM_NOT_FOUND`, `UPSTREAM_RATE_LIMITED`, `UPSTREAM_INVALID`, `UPSTREAM_OVERLOADED`, `CIRCUIT_OPEN`, `BUDGET_EXCEEDED`); no silent `null`; no stack trace, upstream message, SQL or URL reaches the client. (AS-29, AS-30)
- **FR-033**: Query limits are evaluated before execution and cost zero upstream calls: depth ≤ 6; cost ≤ 2,000 (per-field unit cost multiplied by list sizes taken from literals and variable values, with recommendations counted as 8; fragments priced as their content; cycle-safe); ≤ 20 root fields; one operation per request (no array batching); document ≤ 8 KB; `ids` ≤ 50 and `first` ≤ 50 (rejected, never truncated). The numbers are configuration with these defaults. (AS-31..AS-34)
- **FR-034**: Each operation has a deadline of 2,000 ms; upstream calls inherit the time left; unfinished fields are `null` with `BUDGET_EXCEEDED`. (AS-35)
- **FR-035**: GraphQL is rate limited per principal by computed cost (20,000 units per minute); a rejected query is charged 1 unit. (AS-36)
- **FR-036**: Trusted documents: outside local development only documents on the allowlist run; allowlist entries are keyed by SHA-256 of their text, validated at startup against the schema and limits, and cannot be added at runtime; `GET` with a hash is allowed for queries and is shared-cacheable (5 s) only without credentials. (AS-37..AS-39)
- **FR-037**: Introspection is disabled in production. The schema has no mutation and no subscription in this version; the BFF therefore forwards no client mutation. A future mutation must forward unchanged to exactly one owning endpoint, including its `Idempotency-Key`, and fan out to nothing (X.8.3). (AS-40)
- **FR-038**: Money is exposed as `priceMinor` (lossless integer scalar, decimal string on the wire) and `currency`; no floating-point money field exists. The schema is additive within a version, removed fields are `@deprecated` first, and the printed schema is compared with a committed snapshot. (AS-41)
- **FR-039**: GraphQL accepts credentials as FR-020 describes; a cookie-authenticated `POST` is CSRF-protected like every other cookie-authenticated state-changing request. (AS-42)

**Session handling (P0512, P0504)**

- **FR-040**: The BFF session is a server-side record with states `PENDING_MFA`, `ACTIVE`, `ENDED`. The browser holds only `__Host-bff-session` (opaque 256-bit random value, `HttpOnly; Secure; SameSite=Lax; Path=/`, no `Domain`), `__Host-bff-csrf` and, during a challenge, `__Host-bff-mfa`. No access token, refresh token, challenge token or token digest reaches browser JavaScript, a response body, a URL or a log line. (AS-43, AS-48)
- **FR-041**: The store key is the SHA-256 of the cookie value; the record (S01 session ID, user summary, encrypted access and refresh tokens, access-token expiry, token version, created and last-seen times) is encrypted at rest with a key from configuration and has a TTL equal to the remaining lifetime. A leak of the store does not yield usable cookies or tokens. (AS-43, AS-51)
- **FR-042**: Login relays S01 (body delivery) and S02 `POST /api/auth/mfa/verify`, creating a new session ID on every success and deleting any session the browser already held; the answers of S01/S02 for invalid credentials, rate limits and overload are relayed unchanged in meaning (problem codes preserved). The identity calls carry the real client address in `X-Forwarded-For`. (AS-43..AS-47)
- **FR-043**: Login is protected by an origin check (allowed `Origin`, or no `Origin` and `Sec-Fetch-Site` not `cross-site`). Every other cookie-authenticated `POST` requires `X-CSRF-Token` equal to the `__Host-bff-csrf` cookie, a keyed MAC bound to the session ID, compared in constant time. Bearer-only and `GET` requests are exempt. (AS-44, AS-58, AS-59)
- **FR-044**: Pending MFA lives 5 minutes and is consumed atomically: of concurrent verifies exactly one succeeds. A verify without a pending state is `409 mfa_not_pending`. (AS-48..AS-50)
- **FR-045**: Session lifetime: 24 hours idle (extended at most once a minute), 30 days absolute, never longer than the identity session. An `ENDED` session is deleted and its cookies cleared. (AS-52)
- **FR-046**: Refresh is single flight per session across instances: access tokens with 30 seconds or less left are refreshed before use by exactly one caller while the others wait for the result (at most 3 s); the refresh call is never retried; the rotated tokens are stored (up to 3 write attempts) before any caller uses them; a `401 invalid_refresh_token` ends the session; a transient identity failure keeps it. (AS-53..AS-57)
- **FR-047**: Logout is idempotent: it deletes the local record first, clears the cookies, then calls S01 logout best-effort; the answer is `204` regardless of the identity service. (AS-58)
- **FR-048**: Session-store failure is fail-closed for cookie-bearing requests (`503 session_unavailable`) and has no effect on anonymous requests or on readiness. (AS-61)
- **FR-049**: `GET /api/bff/session` answers `{user: {id, email, role}, expiresAt}` or `401`, `Cache-Control: no-store`; session endpoints are rate limited per client address (login 20 per minute) with `429 rate_limited` and `Retry-After`. (AS-45, AS-51)

**Composition rules (X.8, VI.9)**

- **FR-050**: The BFF owns no table, model, migration or database credential; talks to domains only over HTTP with clients built on `packages/contracts` schemas; imports nothing from `@app/domains/*`; uses only the X.8.4 infrastructure allowlist; computes no price, discount, total, tax or stock; makes no authorization decision beyond the presence of a valid session; and forwards no mutation to more than one domain endpoint. (AS-64)
- **FR-051**: Configuration is schema-validated at startup: upstream origin, session encryption key(s), allowed origins, budgets, limits and the allowlist; missing or invalid values stop the process. There is no default upstream address. (AS-39, AS-63)
- **FR-052**: Observability: per-section and per-upstream outcome and duration metrics, breaker state gauge, refresh outcome counter, GraphQL rejection counter by reason, and structured logs carrying the request ID and no secret or PII; trace context flows to every upstream call. (AS-23)

### Key Entities

- **Section**: one optional or required part of the product page: name, upstream call, budget, dependency (product ID only, or product fields), identity need, shared-cache eligibility, contract schema. Not stored.
- **Section outcome**: `ok`, `skipped`, or an error code from FR-005 with `retryable`.
- **Loader batch**: the set of IDs loaded in one tick of one GraphQL request; lives for the request.
- **Trusted document**: `(sha256, text)` pair on the allowlist. Static configuration.
- **BFF session**: server-side record (FR-041) with state `PENDING_MFA | ACTIVE | ENDED`. The only data this capability writes, in the session store allowed by X.8.1.
- **Shaped-response cache entry**: a validated public upstream body with its expiry (≤ 30 s). Never the source of truth.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A shopper gets the whole product page from one request; with one optional dependency answering only after 2 seconds, the page still arrives within 1.1 seconds, complete except for that one section, in 100% of the test runs.
- **SC-002**: A list query for 20 products with their shops costs exactly 2 upstream calls, and for any list up to 150 items never more than 3.
- **SC-003**: 100% of queries that exceed a limit (depth, cost, size, root fields, list sizes) are refused before any domain is contacted.
- **SC-004**: In production, 0 requests run a document that is not on the allowlist.
- **SC-005**: Across all session scenarios no access or refresh token appears in any browser-visible response, cookie, log line or stored plaintext (0 occurrences).
- **SC-006**: Twenty simultaneous requests on one expiring session cause exactly one refresh at the identity service, and no shopper is logged out by the BFF's own parallelism (0 forced sign-outs in the concurrency scenarios).
- **SC-007**: A cookie-authenticated state-changing request without a valid CSRF token or allowed origin never takes effect (0 successes in the scenarios).
- **SC-008**: Under the load profile "50k page requests per second, one optional dependency slowed to 2 s", every request still completes within the 1-second page deadline and the slowed dependency's breaker opens within 10 s (an operations load test, not an e2e scenario).
- **SC-009**: Every other capability's composition requirement that names S48 (S34 AS-49, S35 AS-42, S11, S19, S21, S25, S30, S36, S38) is met by a section or by a documented rule here, with no domain code changed.

## Assumptions

- **Domain = `composition`, lib = `libs/composition/bff`, deployed by `apps/bff`** (X.8). The BFF has no Postgres, Kafka or SQS connection. It does use Redis for its session store and shaped-response cache (allowed by X.8.1/X.8.4); it owns the key prefixes it uses.
- **Optional-section set** is the ten in FR-001: those named by the SD-04 note (shop, recommendations, chat unread, flags, discussions, pickup near me) plus the sections that S25, S30, S11, S21, S34, S35 each declared as "the BFF composes this". The sponsored slot (S36) is not part of the aggregate: it is per-viewer, not cacheable and rendered by the web capability that owns the card; the web layer calls it through the BFF only when S36 adds a section later (one registry entry, FR-001).
- **Budgets are those in the existing code and in S34/S35** (shop 300, recommendations 300, trending 200, flags 150, chat 200); new sections follow the same order of magnitude. SD-04's "p99 under 150 ms with one dependency slowed to 2 s" is reachable only for sections whose budget is at most about 100 ms; with budgets of 200–300 ms the bound is the longest budget plus the product time. The load-test target in SC-008 is therefore the page deadline, not 150 ms.
- **Product-page overall deadline** 1,000 ms; **GraphQL operation deadline** 2,000 ms; breaker 5 failures / 10 s / 10 s open; 100 calls in flight per upstream per instance; 12 per request; shared-cache ceiling 30 s; GraphQL limits depth 6, cost 2,000, 20 root fields, 8 KB, 50 IDs; cost budget 20,000 units per minute; page rate limit 300 per minute; login limit 20 per minute per address; session idle 24 h, absolute 30 d, MFA pending 5 min, refresh skew 30 s, refresh wait 3 s.
- **Client credentials**: browsers use the BFF session cookie; native and mobile clients use S01 bearer tokens obtained directly from S01 in the response body and forwarded as-is. Both are accepted on the page and GraphQL endpoints; both together are an error.
- **OIDC and BFF session**: the OIDC redirect flow of S02 sets `__Host-access` / `__Host-refresh` cookies on the shared origin and is not wrapped by the BFF session in this version. Web screens that use social login rely on S02's cookies; password and MFA login use the BFF session. Unifying the two is a later change (recorded as a `[CONTRACT]` question).
- **No service-to-service token for public reads**: domains' public endpoints are anonymous; the user's token is the only identity the BFF forwards (S01: only to the `marketplace-api` audience). No token exchange is needed in this version.
- **Chat unread** is passed through as the S24 page (`{items, nextCursor}`); the BFF does not sum it.
- **GraphQL consumers** are native and mobile clients and the web's server side; the existing persisted document (`ProductScreen`) stays, with `price` replaced by `priceMinor`/`currency`.
- **Readiness** of the BFF reflects startup and shutdown only (VIII.3); liveness is in-process.

## Cross-capability contracts

### Provides

- **`GET /api/bff/product-page/:productId`** (anonymous or session or bearer; optional query `lat`, `lng`, `radiusKm` (1–100, default 10); header `X-Anonymous-Id`) → `productPageResponseSchema` in `packages/contracts`: `{product, shop|null, recommendations|null, trending|null, flags|null, chatUnread|null, discussions|null, videos|null, pickup|null, flashSale|null, auction|null, errors: [{section, code, retryable}]}`; each section field holds the owning capability's response schema unchanged (`productPublicSchema` S05; `{id,name,slug}` S03; `recommendationsResponseSchema` S34; `trendingResponseSchema` S35; flags body S38; `chatUnreadPageSchema` S24; board posts page S25; `productVideosSchema` S30; pickup page S19; `flashSalePublicSchema` S11; `auctionPublicSchema` S21). `Cache-Control: private, no-store`, `Server-Timing`. Error codes: FR-005; problems: FR-006. **Consumers: W02 (product page), S34/S35 composition scenarios, web server components.**
- **`POST /api/graphql`, `GET /api/graphql`** (trusted documents; `Authorization: Bearer` or session cookie + CSRF) → standard GraphQL response; schema snapshot committed; error `extensions.code` values from FR-032/FR-033; HTTP problems `persisted_query_required`, `persisted_query_mismatch`, `batching_not_supported`, `payload_too_large`, `unsupported_media_type`, `rate_limited`. **Consumers: mobile and native clients, W02.**
- **Session endpoints** (`sessionLoginRequestSchema`, `sessionMfaRequestSchema`, `sessionResponseSchema`, `mfaRequiredResponseSchema` in `packages/contracts`): `POST /api/bff/session`, `POST /api/bff/session/mfa`, `GET /api/bff/session`, `POST /api/bff/session/logout`. Cookies `__Host-bff-session` (HttpOnly), `__Host-bff-csrf` (script-readable, send back as `X-CSRF-Token`), `__Host-bff-mfa`. Problem codes `invalid_credentials`, `origin_not_allowed`, `csrf_invalid`, `mfa_not_pending`, `session_expired`, `unauthenticated`, `ambiguous_credentials`, `session_unavailable`, `rate_limited`. **Consumers: W01 (auth screens, navbar, logout), all web capabilities that need the signed-in user.**
- **Obligations on consumers of the page**: treat every section except `product` as possibly `null`; read `errors` for the reason, never show its codes to end users; render money from `priceMinor` + `currency`; never cache the response in a shared cache.

### Requires

- **S05** `GET /api/products/:productId` → `productPublicSchema` (anonymous, `404` for invisible); `GET /api/batch/products?ids=` (≤ 100, request order, `null` for invisible; `productBatchItemSchema`).
- **S03** `GET /api/batch/shops?ids=` (anonymous, ≤ 100, `[{id, name, slug} | null]`, hidden shops `null`).
- **S34** `GET /api/products/:id/recommendations?limit=8` → `recommendationsResponseSchema` (`{type, items: [{productId, title, priceMinor, currency, score, hops}]}`); **S35** `GET /api/trending?category=` → `trendingResponseSchema` (`{category, windowMinutes, generatedAt, items: [...]}`).
- **S38** `GET /api/flags` (public; `Vary: Authorization, X-Anonymous-Id`; accepts the forwarded principal and `X-Anonymous-Id`; never cached in a shared cache).
- **S24** `GET /api/chat/unread?limit&cursor` → `chatUnreadPageSchema` (`{items: [{channelId, unread, lastSeq}], nextCursor}`; requires a valid access token).
- **S25** `GET /api/boards/:productId/posts?sort=hot&limit=3`; **S30** `GET /api/products/:productId/videos` → `productVideosSchema`; **S19** `GET /api/pickup-points/near?lat&lng&radiusKm&productId&limit` (anonymous); **S11** `GET /api/flash-sales?productIds=` (≤ 100, ≤ 1 view per product); **S21** `GET /api/auctions?productIds=` (≤ 100, anonymous).
- **S01** `POST /api/auth/login` (body delivery, no `delivery` field) → `{accessToken: {token, expiresIn: 300}, refreshToken, sessionId, user: {id, email, role}}` or `{mfaRequired: true, mfaToken}`; `POST /api/auth/refresh {refreshToken}` → same shape with a rotated refresh token (strict reuse detection, `401 invalid_refresh_token`); `POST /api/auth/logout` (Bearer, `204`, idempotent); access token claims `iss: marketplace`, `aud: marketplace-api`, ES256; problem codes `invalid_credentials`, `rate_limited` (+ `Retry-After`), `overloaded`. S01 must treat the BFF as a trusted proxy for client-address purposes (`X-Forwarded-For`), and accept refresh from the BFF only with the body token (the BFF never uses cookie delivery).
- **S02** `POST /api/auth/mfa/verify {mfaToken, code}` → the S01 login body; `401` for a wrong code, an expired or spent challenge.
- **S50** (rate limiter): named policies `bff.product-page.principal` (300/min), `bff.graphql.cost` (consume N units from 20,000/min), `bff.session.login.ip` (20/min), each returning the decision with `Retry-After` and `RateLimit-*` data; a call that consumes a variable cost.
- **S54** (platform toolkit): global problem+json filter with a `code` extension and `requestId`; request-ID and trace propagation; trusted-proxy configuration for client address; schema-validated configuration at startup; resilient HTTP client (pooled keep-alive connections, per-call timeout, abort signal, no redirect following, per-call retry control); load shedding; graceful shutdown.
- **W01 / W02** (web): same-origin path routing so that `__Host-` cookies are valid (`/api/bff/*` and `/api/graphql` rewritten to the BFF); the web client stops keeping the access token in memory and stops calling the GraphQL endpoint with a bearer for browser sessions.
- **Shared cache / session store**: Redis with no `allkeys-*` eviction policy for the session keys (sessions are not cache data); the BFF's key prefixes are owned by this capability.

## Pattern coverage (pattern-map rows whose Specs column names S48)

| Pattern | Requirements | Scenarios |
|---|---|---|
| P0101 bounded concurrency, partial results | FR-005, FR-010 | AS-13, AS-14, AS-18 |
| P0215 no request-scoped providers, per-request loaders | FR-030, FR-050 | AS-28, AS-64 |
| P0307 N+1 and unbounded includes | FR-030, FR-031, FR-033 | AS-25, AS-26, AS-27, AS-34 |
| P0401 keep-alive between BFF and services | FR-014 | AS-24 |
| P0402 aggregate endpoint, per-call budgets, partial responses | FR-001..FR-013 | AS-01..AS-23 |
| P0405 GraphQL, loaders, complexity limits, persisted queries | FR-030..FR-039 | AS-25..AS-42 |
| P0504 CSRF for cookie-authenticated mutations | FR-043 | AS-44, AS-58, AS-59, AS-42 |
| P0512 tokens stay server-side, HttpOnly cookie | FR-040..FR-049 | AS-43..AS-63 |
| P0620 tested fallbacks and graceful degradation | FR-005, FR-009, FR-010 | AS-13, AS-17, AS-18 |
