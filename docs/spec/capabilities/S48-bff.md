---
id: S48
title: BFF composition: product-page aggregate with budgets and partial errors, GraphQL with DataLoaders and limits, session handling
kind: capability
status: draft
generated_at: e95ce81
depends_on: [S01, S05, S34, S35, S50, S52, S54]
concepts: [bff-aggregate, access-token-session, problem-json-errors, rate-limit-policy, cache-layers, request-context]
models: []
scope:
  - packages/backend/libs/composition/bff/**
  - packages/backend/libs/infrastructure/http-client/**
  - packages/contracts/src/bff/**
  - packages/web/lib/api/**
---
# S48 - BFF composition: product-page aggregate, GraphQL, session handling
## Purpose
Web and native clients need one entry point that assembles a product page, answers GraphQL queries and manages browser sessions. The {{concept:bff-aggregate}} calls domain APIs over HTTP within fixed time budgets and degrades per section. It owns no database table. Browsers never hold a token: the BFF keeps tokens server-side behind an HttpOnly cookie ({{concept:access-token-session}}).

## Entry points
- `GET /api/bff/product-page/:productId`: product page with one required part (product) and ten optional sections. [code: packages/backend/libs/composition/bff/page/product-page.controller.ts#ProductPageController]
- `POST|GET /api/graphql`: read-only GraphQL with per-request loaders, query limits, trusted documents and cost-based rate limits.
- `POST /api/bff/session`: login. Relays {{cap:S01}}; answers a session or an MFA challenge. [code: packages/backend/libs/composition/bff/session/session.controller.ts#SessionController]
- `POST /api/bff/session/mfa`: completes a pending second-factor login.
- `GET /api/bff/session`: returns the current user and expiry, or 401.
- `POST /api/bff/session/logout`: ends the session; idempotent.
- `POST /api/bff/session/refresh`: route exists in the controller. The work-order specification does not list it, and no test carries its id (see Known gaps).
- Web rewrites send `/api/graphql` and `/api/bff/*` to the BFF, so the `__Host-` cookies stay on one origin.

## Rules
- **S48.R-01** The page response MUST carry `Cache-Control: private, no-store` and a `Server-Timing` header with one entry per section. [proof: S48 AS-01, S48 AS-23] [code: packages/backend/libs/composition/bff/page/product-page.controller.ts#ProductPageController]
- **S48.R-02** A path ID that is not a UUID MUST give `400 validation_failed` with no upstream call. [proof: S48 AS-08]
- **S48.R-03** Only the product is required: an unknown or invisible product gives `404 not_found`, and a failed optional section gives `null` plus one `errors` entry `{section, code, retryable}`. [proof: S48 AS-07, S48 AS-13, S48 AS-14]
- **S48.R-04** A section that does not apply (anonymous chat, no coordinates, no `shopId`) MUST be `null` with no error entry and no upstream call. [proof: S48 AS-02, S48 AS-04, S48 AS-05]
- **S48.R-05** Only the product call is retried, once, with jittered backoff. A second 503 gives `503 upstream_unavailable` with `Retry-After`. [proof: S48 AS-09]
- **S48.R-06** A product body that fails `productPublicSchema` MUST give `502 upstream_invalid` with a generic `detail`. [proof: S48 AS-10]
- **S48.R-07** The page deadline is 1,000 ms. A dependent section gets only the time left, and a section past it is `null` with `BUDGET_EXCEEDED`. [proof: S48 AS-12, S48 AS-16]
- **S48.R-08** After 5 consecutive failures within 10 s, an optional upstream's breaker opens for 10 s and its section is `null` with `CIRCUIT_OPEN`. [proof: S48 AS-17]
- **S48.R-09** An upstream with 100 calls in flight leaves its optional section `null` with `UPSTREAM_OVERLOADED`; the product call then gives `503 overloaded`. [proof: S48 AS-18]
- **S48.R-10** The BFF MUST NOT forward `X-User-Id`, `X-User-Role`, `X-Tenant-Id`, `X-Shop-Id`, `Cookie` or an invalid `X-Anonymous-Id` to any upstream. [proof: S48 AS-21]
- **S48.R-11** A request carrying both a session cookie and an `Authorization` header MUST give `400 ambiguous_credentials`. [proof: S48 AS-60]
- **S48.R-12** A credentialed upstream 401 MUST give `401 invalid_token` for the whole page. [proof: S48 AS-11]
- **S48.R-13** A token MUST go only to the configured domain-API origin. [proof: S48 AS-63]
- **S48.R-14** The page endpoint allows 300 requests per minute per principal; the 301st gives `429 rate_limited`. See {{concept:rate-limit-policy}}. [proof: S48 AS-22]
- **S48.R-15** The shared cache MAY hold a public section only as long as the upstream's `s-maxage` allows. Public upstream calls are single-flighted. See {{concept:cache-layers}}. [proof: S48 AS-19, S48 AS-20]
- **S48.R-16** A GraphQL query deeper than 6 levels or costing more than 2,000 MUST be rejected before any upstream call. [proof: S48 AS-31, S48 AS-32]
- **S48.R-17** GraphQL loaders live for one request and one principal; each batch call carries at most 100 IDs. [proof: S48 AS-25, S48 AS-27, S48 AS-28]
- **S48.R-18** A cookie-authenticated POST MUST carry an `X-CSRF-Token` equal to the `__Host-bff-csrf` cookie, or the BFF answers `403 csrf_invalid`. Login uses an origin check instead. [proof: S48 AS-44, S48 AS-59]
- **S48.R-19** Refresh is single-flight per session: tokens with 30 s or less left are refreshed once, and the call is never retried. [proof: S48 AS-53, S48 AS-54]
- **S48.R-20** A cookie-bearing request MUST give `503 session_unavailable` when the session store is down; an anonymous request is served normally. [proof: S48 AS-61]

## Behaviors
- **S48.B-01** Given a visible product and healthy upstreams, when an anonymous visitor requests the page, then it returns 200 with every section and no `Authorization` header upstream. [proof: S48 AS-01, S48 AS-02]
- **S48.B-02** Given a signed-in session, when the page loads, then flags and chat carry that session's bearer token and `chatUnread` is passed through with its `nextCursor`. [proof: S48 AS-03]
- **S48.B-03** Given recommendations answer after 500 ms (budget 300 ms), when the page loads, then `recommendations` is `null` with `UPSTREAM_TIMEOUT` and other sections stay intact. [proof: S48 AS-12]
- **S48.B-04** Given all ten optional sections fail, when the page loads, then it is still 200 with ten `null` sections and ten error entries. [proof: S48 AS-14]
- **S48.B-05** Given 50 visitors request one product within 50 ms, when the page loads, then each public upstream is called once. [proof: S48 AS-20]
- **S48.B-06** Given `products(ids: [A, B, A, C])` where B is invisible, when executed, then the result is `[A, null, A, C]` and the batch call carries A, B, C once. [proof: S48 AS-26]
- **S48.B-07** Given the product batch answers 503, when a query runs, then 200 with `errors[]` carrying `path` and `UPSTREAM_UNAVAILABLE`, and independent fields stay. [proof: S48 AS-29]
- **S48.B-08** Given a document with 21 root fields, a batched array body, or a body over 8 KB, then the BFF answers `400 TOO_MANY_ROOT_FIELDS`, `400 batching_not_supported` or `413 payload_too_large`. [proof: S48 AS-33]
- **S48.B-09** Given `products(ids:)` with 51 IDs, then `400 BAD_USER_INPUT`; with `[]`, then `[]` and no upstream call. [proof: S48 AS-34]
- **S48.B-10** Given a 2,000 ms operation deadline and an upstream answering after 5 s, then the response arrives within 2,100 ms with `BUDGET_EXCEEDED` fields. [proof: S48 AS-35]
- **S48.B-11** Given a principal that used its 20,000 cost units this minute, when it sends a query, then `429 rate_limited` with `Retry-After` and no upstream call. [proof: S48 AS-36]
- **S48.B-12** Given a known hash sent with GET and no credentials, then the response is `public, s-maxage=5`; with any credential it is `private, no-store`. [proof: S48 AS-38]
- **S48.B-13** Given production configuration, when a client asks `__schema`, then `INTROSPECTION_DISABLED` and zero upstream calls. [proof: S48 AS-40]
- **S48.B-14** Given a registered user and an allowed `Origin`, when login is sent, then 200 with the user and `expiresAt`, and a new session cookie. [proof: S48 AS-43]
- **S48.B-15** Given a user with a second factor, when login is sent, then 200 `{mfaRequired: true}` and only `__Host-bff-mfa` is set. [proof: S48 AS-48]
- **S48.B-16** Given two concurrent correct MFA verifies, then one gets 200 and the other `409 mfa_not_pending`. [proof: S48 AS-50]
- **S48.B-17** Given the identity service refuses a refresh with `401 invalid_refresh_token`, then the session ends and the answer is `401 session_expired`. [proof: S48 AS-55]
- **S48.B-18** Given a refresh times out while the access token is still valid, then the request proceeds and the session is kept. [proof: S48 AS-56]
- **S48.B-19** Given logout without a CSRF token, then `403 csrf_invalid`; with one, `204`, record deleted and cookies cleared. [proof: S48 AS-58]
- **S48.B-20** Given sessions of users A and B used in interleaved calls, then each upstream call carries only its own token. [proof: S48 AS-62]

## Lifecycles
The session record has three statuses: `PENDING_MFA`, `ACTIVE`, `ENDED`. Login success or a MFA success creates `ACTIVE`. Login with a second factor creates `PENDING_MFA` (5 minutes). The BFF moves a session to `ENDED` on logout, 24 h idle, 30 days absolute, ended identity session, or refused refresh. See {{cap:S01}}. No model file exists.

## Owns
- No table, queue, topic or event. The BFF talks to domains over HTTP only.
- Redis data: session records (key = SHA-256 of cookie value, encrypted), pending-MFA state, refresh locks, shaped-response cache, rate limits.
- Cookies: `__Host-bff-session`, `__Host-bff-csrf`, `__Host-bff-mfa`.
- Configuration: upstream origin, session encryption keys, allowed origins, budgets, limits, trusted-document allowlist. Missing or invalid values stop the process. [code: packages/backend/libs/common/config/bff-config.ts#parseBffSettings]

## Decisions
- The BFF has no database connection, so business rules cannot bypass domain services.
- Failed optional sections degrade to `null` plus an error entry; only the product is required.
- An upstream 401 fails the whole page, because a silent degrade would hide an expired credential.
- Session store failure is fail-closed for cookie requests, because serving them as anonymous would hide a signed-in state.
- Only the product call is retried, and only in one layer, to avoid retry storms.
- Loaders are created per request, never shared between principals.
- Only allowlisted GraphQL documents run outside local development.
- Money is `priceMinor` (a lossless integer) plus `currency`; no floating-point money field exists.

## Known gaps
- AS-64 (P2, boundary checks) has no test with a scenario id in this list.
- Rule 15 cache TTL limit (30 s) and the `private`/`no-store` upstream cases are only partly tied to AS-19.
- AS-37 (trusted documents), AS-39 (allowlist startup check), AS-41 (schema snapshot), AS-42 (GraphQL credentials and CSRF), AS-45 (login relay), AS-46 (X-Forwarded-For), AS-47 (re-login), AS-49, AS-51, AS-52, AS-57 and AS-24 (keep-alive reuse) are covered by tests but are not in a rule or behavior above.
- `POST /api/bff/session/refresh` has no specification entry or test.
- The `/api/bff/f/*` forwarder (web rewrite) is not described in the work-order specification here.
- Mutations and subscriptions are rejected; the future mutation forwarding contract is untested.