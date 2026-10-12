---
id: problem-json-errors
title: Errors as problem+json
kind: concept
status: draft
defined_by: S54
---
# Errors as problem+json
## Definition
Every backend error reaches the client as one `application/problem+json` document with a stable `code`. The members are fixed, and the body never leaks internals. Clients choose their behaviour by `code`, never by message text. Every error carries a `requestId`, so a client report can be matched to the logs. Capability S54 defines the format and the filter that renders it.

## Rules
- **problem-json-errors.C-01** Every error response MUST be `application/problem+json` with exactly the members `type`, `title`, `status`, `detail`, `instance`, `code`, `requestId`, plus `traceId` when a trace is active.
- **problem-json-errors.C-02** For status 500 and above, `detail` MUST be the fixed catalogue text; thrown messages, wrapped causes, SQL and stack traces MUST NOT reach the body in any environment.
- **problem-json-errors.C-03** Validation failures MUST return `400 validation_failed`, list every failing field at once, and MUST NOT echo input values.
- **problem-json-errors.C-04** A raw database unique violation MUST render as `409 conflict` with generic text and no column, constraint or value.
- **problem-json-errors.C-05** Extension members MUST NOT override a reserved member; `retryAfterSeconds` MUST produce a `Retry-After` header.
- **problem-json-errors.C-06** Two registrations of one `code` with different definitions MUST fail startup and name both owners.
- **problem-json-errors.C-07** The filter MUST NOT write after headers are sent and MUST NOT throw; if rendering fails it MUST emit a minimal `500 internal_error`.
- **problem-json-errors.C-08** An inbound `X-Request-Id` MUST be kept only when it has 8 to 128 characters of letters, digits, `.`, `_`, `-` and appears once; otherwise a UUIDv7 replaces it.

## How the capabilities use it
- {{cap:S01}} returns its errors in this format, with stable codes.
- {{cap:S50}} returns rate-limit rejections in this format.
- {{cap:S53}} answers an invalid `minVersion` (`-1`, `1.5`, `abc`) with `400` problem+json, without waiting.
- {{cap:S54}} defines the format. Its global exception filter renders every error this way.
- {{cap:W01}} builds every error text from one copy catalogue made from the problem body (FR-040).
- {{cap:W03}} MUST choose the visible form of each checkout problem by its stable `code`.

## Known gaps
- S02, S03, S05, S10, S13, S32, S33, S34, S35, S48, S49, S51, W02 and W07 list this concept, but no line of their pages links it. Their use is not stated.
- The facts give no full list of codes beyond those named above.

## Used by
<!-- used-by:start -->
- {{cap:S01}} Registration, password login, sessions, refresh-token rotation, JWKS, service-to-service tokens
- {{cap:S02}} TOTP MFA with recovery codes, Google OIDC login (PKCE), account linking
- {{cap:S03}} Shops as tenants: memberships, roles and permissions, invites, per-shop SSO, cells, offboarding
- {{cap:S05}} Product CRUD, pricing, stock fields, product cache and invalidation, product views
- {{cap:S10}} Cart (guest + merge), idempotent checkout, stock reservation, multi-shop split, order state machine, payment webhook
- {{cap:S13}} Payment intents, idempotency, unknown outcomes, PSP circuit breaker, outbox, saga with orders
- {{cap:S32}} Product search: index sync with external versioning, zero-downtime reindex, relevance boosts, synonyms, facets, k-NN
- {{cap:S33}} Search autocomplete: query-log top-K trie, catalog completions, per-source budgets, typo fallback
- {{cap:S34}} "Bought together" recommendations: co-occurrence graph, normalisation, 2-hop cold start
- {{cap:S35}} Trending products: windowed approximate top-K per category
- {{cap:S48}} BFF composition: product-page aggregate with budgets and partial errors, GraphQL with DataLoaders and limits, session handling
- {{cap:S49}} Distributed job scheduler: SKIP LOCKED leases, retries, cron leader, fairness, tz-aware cron
- {{cap:S50}} Rate limiting: token bucket, sliding window, concurrency limits, fail modes, headers
- {{cap:S51}} Realtime push hub: topic SSE, Last-Event-ID replay, per-topic policies, ref-counted fan-out
- {{cap:S53}} Domain events, outbox/CDC → Kafka, idempotent versioned projections, replay, read-your-writes
- {{cap:S54}} Platform toolkit: problem+json errors, request context and transactions, health probes, graceful shutdown, load shedding, resilient HTTP
- {{cap:W01}} Sign up, log in, forgot password, MFA step-up, session cookie via BFF, CSRF, logout, account state in the navbar
- {{cap:W02}} Home, search (autocomplete, filters, facets, sort, URL state), trending and recommendation rails, product page (product, shop, pickup near me, discussions, ask this product, share link)
- {{cap:W03}} Cart (guest and merged on login), checkout with idempotent submit and async payment status, success page, order history, notification popover
- {{cap:W07}} App shell and cross-cutting UI: navbar, footer, legal pages, developer docs, error/not-found/loading states, responsive layout, accessibility, CSP and security headers
<!-- used-by:end -->
