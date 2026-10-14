# Gaps: current code vs S48 spec

Files in scope: `packages/backend/libs/composition/bff/` (`bff.controller.ts`, `bff.module.ts`, `core-client.ts`, `product-page.service.ts`, `bff.e2e-spec.ts`, `graphql/*`), `packages/backend/apps/bff/src/`, and the web consumers `packages/web/lib/api/graphql.ts`, `packages/web/next.config.ts`. Line numbers refer to the files as read on 2026-10-06. This is the implementation agent's to-do list; ordering is by dependency (contracts → aggregate → GraphQL → session → tests).

## Debt register and ownership check

| Source | State | What S48 does |
|---|---|---|
| D-2 (X.3: mixed types in `libs/common/src/types.ts`; named `composition/bff` as a user) | resolved (Phase 3) | nothing; `bff.module.ts:7` imports `Environment` from `@app/common/types` (allowed by X.8.4 / X.5) |
| D-4 (X.3/IX.4: `libs/common/src/bff/batch-read.controller.ts` raw SQL over `Shop`/`Product`) | resolved (Phase 3); `libs/common/**/bff/**` no longer exists; the batch routes live in tenancy (`ShopBatchReadModule`) and catalog (`ProductBatchReadModule`) | the BFF consumes them over HTTP, **R2**; their remaining SQL-in-controller issue (`D-4` follow-up A15) belongs to S05/S03 |
| D-6, D-7, D-12 (cross-domain models and SQL) | open for other domains | none for `composition`: grep of `libs/composition` for `Model`, `sequelize`, `.query(`, `@app/domains`, `@app/infrastructure/{database,context,outbox,kafka}` finds nothing |
| D-8, D-11, D-15, D-16, D-17 | open, no row names `composition` or `S48` | none |
| `pnpm check:table-ownership` and `--strict` (run 2026-10-10, T001) | **run**: 62 cross-domain accesses in 20 domains (strict exits 1 because of them); no line of the output names `composition`; grep of `libs/composition` for `sequelize\|Model\|.query(\|@app/domains` = 0 matches | nothing to replace; re-run at T045 |

No open debt row names `composition` or `S48`, so there is no IX.7 replacement to plan beyond keeping it that way (AS-64).

## Gaps by area

### Contracts (V.2, X.8.2)

| # | Gap | Where | Spec |
|---|---|---|---|
| C1 | No `packages/contracts` schema for the page, session, MFA, or GraphQL error codes; `ProductPage` is a hand-written interface with `unknown[]` sections | `product-page.service.ts:11-19`; no match for `bff` in `packages/contracts` | FR-001, FR-008, Provides |
| C2 | No upstream response is validated: `CoreClient.get<T>` casts the body | `core-client.ts:31-36` | FR-008, AS-10, AS-13 |
| C3 | One `CoreClient` for everything with a hand-written `CoreProduct` (`price: number`, `quantity`) instead of S05's `productPublicSchema`, `priceMinor`, `currency`, `inStock` | `core-client.ts:5-14,38-48` | FR-008, FR-038 |
| C4 | Upstream URL defaults to `http://localhost:8000`; config read untyped | `core-client.ts:28` | FR-051, AS-63 |

### Product-page aggregate

| # | Gap | Where | Spec |
|---|---|---|---|
| A1 | Product is fetched alone before any other call, so every section waits for it; only `shop` and `trending` need it | `product-page.service.ts:33-47` | FR-003, AS-06 |
| A2 | Only five sections; no discussions, videos, pickup, flash sale, auction; section list is inline, not a registry | `product-page.service.ts:38-44` | FR-001 |
| A3 | Overall deadline missing; each section only has its own timer; the product call has an 800 ms client timeout but no page deadline | `product-page.service.ts:49-62`, `core-client.ts:39` | FR-002, AS-16 |
| A4 | `shop` loader ignores the abort signal (`load: async () =>`), so a timed-out call keeps running; the other loaders pass `signal` but also race a manual listener | `product-page.service.ts:39,52-55` | FR-005, AS-12 |
| A5 | Error entries leak raw messages: `reason: error.message` (`timeout after 300 ms`, `core /x → 503`) | `product-page.service.ts:57`, `core-client.ts:34` | FR-005, AS-13 |
| A6 | `404` of any upstream becomes `HttpRequestError`; a non-404 product failure rethrows the raw error (generic filter output depends on error type); no `Retry-After`, no retry, no `502` for invalid body | `product-page.service.ts:33-36`, `core-client.ts:31-36` | FR-006, FR-007, AS-07, AS-09, AS-10 |
| A7 | `chatUnread` sums a paged answer (wrong when `nextCursor` is set; summing is domain logic) | `product-page.service.ts:43` | FR-015, AS-03 |
| A8 | Raw `authorization` header forwarded to every call, including the public product call; flags gets no `X-Anonymous-Id`; client identity headers are not stripped explicitly | `bff.controller.ts:12`, `core-client.ts:32,39`, `product-page.service.ts:42-43` | FR-021, AS-02, AS-21 |
| A9 | `401` from a credentialed upstream is swallowed into a section error | `product-page.service.ts:56-58` | FR-022, AS-11 |
| A10 | No circuit breaker, bulkhead, per-request concurrency bound, shared cache, request coalescing, `Server-Timing`, per-section metrics | whole service | FR-009..FR-012, FR-052, AS-17..AS-20, AS-23 |
| A11 | No rate limit on the endpoint, no `Cache-Control: private, no-store`, no `lat/lng` handling | `bff.controller.ts:11-14` | FR-012, FR-013, AS-05, AS-22 |
| A12 | Redirect behaviour of the HTTP client is not asserted anywhere; no test that tokens only reach the configured origin | `core-client.ts:32` | FR-021, AS-21, AS-63 |
| A13 | Keep-alive reuse is configured in the shared client (`resilient-http-client.ts:50-52`) but never tested | — | FR-014, AS-24 |

### GraphQL

| # | Gap | Where | Spec |
|---|---|---|---|
| G1 | Cost rule ignores variable values: `listSize` only reads literal `ids` lists and `first`, so `products(ids: $ids)` is priced as 1 and the most common client style bypasses the 2,000 limit | `graphql/limits.ts:45-51` | FR-033, AS-32 |
| G2 | Cost rule walks fragments recursively without a cycle guard (a custom rule may run before `NoFragmentCycles`); no root-field cap; no one-operation-per-request rule; no document size cap; limits hard-coded in the module | `graphql/limits.ts:13-33`, `bff.module.ts:34` | FR-033, AS-32, AS-33 |
| G3 | `products(ids)` truncates silently to 50 | `graphql/product.resolver.ts:26` | FR-033, AS-34 |
| G4 | `recommendations` field bypasses the loader architecture: direct `core.get`, swallows every error (`catch → null`), reports nothing in `errors`, uses `limit=6`, the old bare-array shape and the S34 shape is not validated | `graphql/product.resolver.ts:35-44` | FR-031, FR-032, AS-30 |
| G5 | Money is `Float` named `price` ("Minor units" in the description) | `graphql/types.ts:14`, `graphql/product.resolver.ts:11` | FR-038, AS-41 |
| G6 | Loaders do not carry the request's credentials or deadline, have no per-batch error mapping to GraphQL codes, and do not validate batch length/order against the request | `graphql/loaders.ts:16-21`, `bff.module.ts:35` | FR-030..FR-032, AS-26, AS-29 |
| G7 | Persisted queries: enforcement only when `node_env=production`; only `POST`; a supplied hash is trusted without checking it against the query text; no `GET`; no startup validation of the allowlist | `graphql/persisted-queries.ts:10-22`, `bff.module.ts:46` | FR-036, AS-37..AS-39 |
| G8 | No rate limit by cost, no operation deadline, no `Cache-Control` rules, no CSRF/origin check for cookie requests, no request ID in the context | `bff.module.ts:25-37` | FR-034, FR-035, FR-039, AS-35, AS-36, AS-42 |
| G9 | Error format is Apollo's default (stack traces in non-production, upstream messages) instead of stable codes and a generic message | `bff.module.ts:25-37` | FR-032 |
| G10 | No schema snapshot or `@deprecated` check; schema generated in memory (`autoSchemaFile: true`) | `bff.module.ts:30` | FR-038, AS-41 |

### Session handling

| # | Gap | Where | Spec |
|---|---|---|---|
| S1 | **Not implemented at all**: no login, MFA, session, logout endpoints; no session store; no cookies; no CSRF; no origin check; no refresh single flight | `bff.controller.ts` (one route), `bff.module.ts` (no Redis, no rate-limit import), `apps/bff/src/bff-app.module.ts:16` | FR-040..FR-049, AS-43..AS-63 |
| S2 | The BFF forwards whatever `Authorization` header the client sent; cookie + bearer ambiguity unhandled | `bff.controller.ts:12`, `bff.module.ts:35` | FR-020, AS-60 |
| S3 | Web client keeps the access token in memory and calls GraphQL with it as bearer | `packages/web/lib/api/graphql.ts:1-23` (W01 follow-up) | FR-040, VI.2 |
| S4 | The shared HTTP client must forward the client address and must not follow redirects (verify; S54) | `libs/infrastructure/http-client/resilient-http-client.ts` | AS-21, AS-46 |
| S5 | No configuration schema for session keys, allowed origins, budgets, limits | `bff.module.ts:33` reads `node_env` only | FR-051, AS-39, AS-63 |

### Tests

| # | Gap | Where | Spec |
|---|---|---|---|
| T1 | The e2e module is `BffModule` alone with an overridden config; it does not boot the production module, global pipe, filter, prefix or interceptors (routes are `/bff/...`, not `/api/bff/...`) | `bff.e2e-spec.ts:39-44,60` | VII.2 |
| T2 | Timing assertions use wall-clock (`< 1_500`) against a stub that cannot record timestamps or aborts | `bff.e2e-spec.ts:59-61` | AS-06, AS-12 |
| T3 | The cost test uses a literal-list, deep query that is rejected by depth; the variable bypass is not covered | `bff.e2e-spec.ts:81-87` | AS-32 |
| T4 | Missing: `401`, validation (`400`), `404`, `429`, cross-user cases, all failure classes, session scenarios, CSRF, breaker, bulkhead, cache, single flight, startup validation, snapshot | `bff.e2e-spec.ts` | test-plan.md |
| T5 | One stub "core" server for every upstream (it cannot distinguish services, so the per-capability routes and contract fixtures are not exercised); no contract-schema parsing of responses | `bff.e2e-spec.ts:15-37` | VII.6, X.8.5 |
| T6 | No unit specs for the cost estimator, loader batching, breaker, CSRF token, session lifetime | — | VII.5 |
| T7 | Describe name is `BFF (e2e)`; S34/S35 test plans reference `BFF product page composition` in this file | `bff.e2e-spec.ts:15` | VII.8 |
| T8 | No Playwright journey for BFF sign-in or the product page | `packages/web/tests/` | VII.7 |

## Suggested order

1. `packages/contracts`: page, session, MFA schemas; upstream schemas missing for flags, board posts, pickup. Typed per-capability clients with validation, no default URL (C1–C4, S5).
2. Aggregate: registry, waves, budgets, deadline, error codes, retry, breaker, bulkhead, cache, coalescing, headers, metrics (A1–A13). Replace `CoreClient`.
3. GraphQL: cost estimator with variables, caps, loaders with credentials and deadlines, error mapping, trusted documents, schema snapshot (G1–G10).
4. Session: store, cookies, CSRF, origin, login/MFA/logout, refresh single flight, expiry (S1–S4). Then the web follow-ups in W01/W02 (S3, T8).
5. Tests: rebuild `bff.e2e-spec.ts` on the production app and split into the four files in `test-plan.md` (T1–T7); run the suites and `check:boundaries`, `check:table-ownership --strict` and record them.

## Sibling-spec follow-ups

Written by the S48 plan (2026-10-10). Nothing in another capability's spec was edited.

- **S01**: treat the BFF's peer address as a trusted proxy (`trusted_proxies`) so `X-Forwarded-For` carries the shopper's address for its per-IP limits (AS-46); accept `POST /api/auth/refresh {refreshToken}` from the BFF by body token only (the BFF never sets `delivery:"cookie"`); keep strict reuse detection with no grace (the BFF serializes refresh per session, AS-54/AS-55).
- **S02**: `POST /api/auth/mfa/verify` must answer `401` with a problem `code` that tells a wrong code from a spent or expired challenge (the BFF keeps the pending state on the first and deletes it on the second, AS-49); the OIDC callback keeps setting its own `__Host-access`/`__Host-refresh` cookies (not wrapped by the BFF session in this version).
- **S24, S25, S19, S11, S21, S30, S38**: the BFF validates their answers with schemas it had to add to `packages/contracts/src/bff/upstream.ts` because none was published (flags body, chat unread page, board posts page, pickup page, flash-sale public view, auction public view, product videos). Replace them with your own `packages/contracts` schemas and keep the exported names; a shape drift shows as `UPSTREAM_INVALID` in the page `errors`.
- **S38**: `GET /api/flags` stays anonymous-capable and answers `Vary: Authorization, X-Anonymous-Id` (the BFF never shared-caches it).
- **S50**: export the structured-header helpers (`headersFor`, `formatRetryAfter`) from `@app/infrastructure/rate-limit` if they are not yet public; the GraphQL cost limiter needs them to write `RateLimit` / `RateLimit-Policy` outside an `@RateLimit` route.
- **S54**: if the redirect, keep-alive or abort tests (A12, A13, AS-21, AS-24) show `ResilientHttpClient` follows a redirect, ignores an abort on the socket or does not reuse connections, the fix belongs in the shared client; the BFF adds the proving test only.
- **W01**: `lib/api/session.ts` (added by S48) returns typed problem `code`s; the screens switch on `code`, never on message text, handle `/login?error=<code>`, `/login/mfa` and `?linked=google`, show `recoveryCodesRemaining: 0` as a prompt to regenerate (legacy recovery codes are not migrated), call `POST …/start` then navigate to `authorizationUrl`, and send `X-CSRF-Token` (value of `__Host-bff-csrf`) on cookie-authenticated `POST`s. API and web share one origin for the `__Host-` cookies (`packages/web/next.config.ts:33-35`). The Playwright journey `packages/web/tests/bff-session.spec.ts` is theirs.
- **W02**: the product page reads `priceMinor` + `currency`, treats every section but `product` as nullable, reads `errors` without showing codes and never caches the response publicly; the search page sends `limit` and `cursor` (no `from`) and the `searchId` with each click and reads `items`, `total.exact`, `degraded` and the facet keys (the BFF does not compose search); `packages/web/tests/product-page.spec.ts` is theirs.
- **W03**: checkout answers `202` + `Location`, `Idempotency-Key` is mandatory, the cart holds ids, quantities and `addedAt` only (titles and prices through the batch product endpoint), orders use `…Minor` and keyset pages; the pay step uses `POST /payments/intents` and the `packages/contracts` payment schemas in place of `packages/web/lib/types.ts:98-104`. The BFF exposes none of these routes (a future mutation forwards unchanged to exactly one endpoint with its `Idempotency-Key`, FR-037).
- **S34 / S35**: the in-repo composition adopts their envelopes (`recommendationsResponseSchema`, `trendingResponseSchema`); their AS-49 (A25) and AS-42 composition cases are owned and run by `bff.e2e-spec.ts` here.

Added by the first implementation pass (2026-10-10):

- **S54**: `HttpClientError` now carries `problemCode`, the machine `code` of a non-2xx JSON problem answer (snake_case, ≤ 64 characters, nothing else of the body). The BFF needs it to tell S02's `invalid_mfa_code` from `invalid_mfa_challenge` (both `401`). Proven in `resilient-http-client.e2e-spec.ts` (`S48 AS-45`). The redirect, abort and keep-alive behaviours (A12, A13, AS-21, AS-24) already held in the shared client; no other change was needed.
- **S50**: `@app/infrastructure/rate-limit` now exports `headersFor`, `formatRetryAfter` and `HeaderItem` (additive), because the GraphQL cost limiter charges the limiter from a middleware, outside an `@RateLimit` route. A per-request variable `cost` on a route-less call would be a cleaner seam than re-using the header helpers.
- **Boundaries (X.8.4 / X.1)**: `.dependency-cruiser.cjs` exempts `libs/composition/<lib>/testing/` from `x8-composition-infrastructure-allowlist` and `x1-nothing-imports-apps`, because the BFF e2e kit boots the deployable `BffAppModule` with `configureHttpApp` as `test-plan.md` requires. Production composition code stays under both rules (`check:boundaries` is green).
- **S01**: the BFF sends `X-Forwarded-For: <req.clientIp>` (one hop, the address `configureHttpApp` resolved from `trusted_proxies`) on login, refresh, logout and MFA verify. S01 must treat the BFF peer as a trusted proxy for that header to take effect.
- **S02 / W01**: the MFA pending cookie is specified as `__Host-bff-mfa; Path=/api/bff/session`. Browsers reject a `__Host-` cookie whose `Path` is not `/` (see `questions.md`, "Spec defect found while implementing"). The implementation follows the spec literally so the contract tests can assert it; the one-line change is in `session/session-cookies.ts`.
- **S13 / W03 (T049)**: `packages/web/lib/types.ts:98-104` (`PaymentStatus`) is used by `Order.paymentStatus` (`lib/types.ts:111`); replacing it is not a pure type swap (the web package does not depend on `packages/contracts` yet), so it is left to W03. `packages/web/next.config.ts:39` still rewrites `/api/payment/stream`, a route S13 removed.
- **W01 / W02 (T051)**: no sign-in or product-page screen exists yet, so the Playwright journeys `packages/web/tests/bff-session.spec.ts` and `product-page.spec.ts` are not added; they belong to W01 and W02.
- **S38, S24, S25, S30, S19, S11, S21**: none of these capabilities is built yet (no `.implemented` marker). Their sections degrade exactly as the spec requires (`UPSTREAM_NOT_FOUND` or `UPSTREAM_UNAVAILABLE` in `errors`, page still `200`). Their response schemas in `packages/contracts/src/bff/upstream.ts` are written from the shapes in their specs (`looseObject` where the shape is not fixed yet); the owners replace them.
- **S05**: `productPublicSchema` requires a `shopId`, so the case "the product has no `shopId`" of AS-04 cannot arise from a contract-valid answer; the section registry still skips the shop call when `shopId` is missing, and AS-04 is proven for the hidden-shop case.

## Final pass (US5 and Phase 9)

- **US5 / AS-64 built**: `bff-boundary.e2e-spec.ts` now proves the booted app has no database, queue or event provider, no request-scoped application provider (Nest's own `REQUEST` token excluded), and that the schema snapshot and registered routes carry no mutation, payment, search or checkout surface. AS-39 and AS-63 were already green.
- **Gates (run in this pass)**: `pnpm check:boundaries` no violations (3003 modules); `pnpm check:no-request-scope` OK; `pnpm check:table-ownership --strict` exits 1 because of other domains' accesses (27 in 10 domains), none naming `composition/bff`; `tsc --noEmit` clean in `packages/backend` (it covers `packages/contracts`, which has no tsconfig of its own) and in `packages/web`; no `sequelize.transaction` or `S54 T037 audit` in `libs/composition`.
- **Whole capability**: `test-spec.sh libs/composition/bff`: 6 suites, 231 tests passed.
- **Not run**: SC-008 (load profile) stays `not run` in `specs/UNVERIFIED.md`; ESLint was not run in this pass.

## Deferred until a later pass (superseded: US5 and Phase 9 are done, see above)

This pass built Setup, Foundational, US1 (P1), US2 (P1), US3 (P1), US4 (P1) and the in-repo web consumers (Phase 8). Not started:

- **US5 composition boundary (P2)**: AS-64 (the booted application has no database, queue or event-bus provider and no request-scoped provider; schema and routes expose no cart, order, payment or search surface; `check:table-ownership --strict` and `check:boundaries` recorded) waits for the final pass. Tasks T044 and T045 are open; their other scenarios (AS-39 allow-list integrity, AS-63 startup validation) already have tests in `bff-boundary.e2e-spec.ts`. Waits for: nothing outside this capability.
- **Polish (Phase 9, T052–T055)**: the whole-capability run, the full gate sweep and the sibling-follow-up sweep wait for the final pass.
- **Capabilities S38, S24, S25, S30, S19, S11, S21 are now built** (each has `.implemented`): `testing/fixtures.ts` parses every stub with the owner's real schema, and no "not built" degradation wording remains in the code. (Superseded note: the BFF side was first tested against contract-valid stubs; the real answers appear when they are built.) No stub of theirs was written into their domains.

## Decisions (final pass 2)

- **W02 H9, `sendBeacon` to `POST /api/events`**: the loss is accepted. A signed-in visitor's beacon carries no `X-CSRF-Token`, so the forwarder answers `403 csrf_invalid`; exempting a route from the CSRF check would add a hole to the one rule that protects every cookie-authenticated write. Proven by `forward/bff-forward.e2e-spec.ts` ("S48 W02-H9"). W02 can send queued events with `fetch` + `keepalive: true` and the header instead.

## Spec changes

Human-signed text that no longer matches the code (a human must update it; the signed `spec.md` was not edited):

- **FR-040 / AS-48**: say `__Host-bff-mfa` has `Path=/api/bff/session`; the shipped cookie is `Path=/` (browsers reject a `__Host-` cookie with another path; W01 change).
- **Guest cart token alphabet** (new): `guest:<uuid>.<signature>`, matching `^[A-Za-z0-9._~:-]{1,1024}$` (`upstream/upstream-client.ts`).
