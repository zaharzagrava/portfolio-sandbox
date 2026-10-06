# Gaps: current code vs S48 spec

Files in scope: `packages/backend/libs/composition/bff/` (`bff.controller.ts`, `bff.module.ts`, `core-client.ts`, `product-page.service.ts`, `bff.e2e-spec.ts`, `graphql/*`), `packages/backend/apps/bff/src/`, and the web consumers `packages/web/lib/api/graphql.ts`, `packages/web/next.config.ts`. Line numbers refer to the files as read on 2026-10-06. This is the implementation agent's to-do list; ordering is by dependency (contracts → aggregate → GraphQL → session → tests).

## Debt register and ownership check

| Source | State | What S48 does |
|---|---|---|
| D-2 (X.3: mixed types in `libs/common/src/types.ts`; named `composition/bff` as a user) | resolved (Phase 3) | nothing; `bff.module.ts:7` imports `Environment` from `@app/common/types` (allowed by X.8.4 / X.5) |
| D-4 (X.3/IX.4: `libs/common/src/bff/batch-read.controller.ts` raw SQL over `Shop`/`Product`) | resolved (Phase 3); `libs/common/**/bff/**` no longer exists; the batch routes live in tenancy (`ShopBatchReadModule`) and catalog (`ProductBatchReadModule`) | the BFF consumes them over HTTP, **R2**; their remaining SQL-in-controller issue (`D-4` follow-up A15) belongs to S05/S03 |
| D-6, D-7, D-12 (cross-domain models and SQL) | open for other domains | none for `composition`: grep of `libs/composition` for `Model`, `sequelize`, `.query(`, `@app/domains`, `@app/infrastructure/{database,context,outbox,kafka}` finds nothing |
| D-8, D-11, D-15, D-16, D-17 | open, no row names `composition` or `S48` | none |
| `pnpm --dir packages/backend check:table-ownership` | **not run**: the command needed approval in this unattended session. By the grep above, `composition` has no `MODEL` or `SQL` rows | the implementation agent must run it and `--strict`, and record the lines (expected: none for `composition`). If a row appears, replace it with **R2** (HTTP to the owning domain's API) |

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
