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
- `GET /api/bff/product-page/:productId`: product page with one required part (product) and eleven optional sections. [code: packages/backend/libs/composition/bff/page/product-page.controller.ts#ProductPageController]
- `POST|GET /api/graphql`: read-only GraphQL with per-request loaders, query limits, trusted documents and cost-based rate limits.
- `POST /api/bff/session`: login. Relays {{cap:S01}}; answers a session or an MFA challenge. [code: packages/backend/libs/composition/bff/session/session.controller.ts#SessionController]
- `POST /api/bff/session/mfa`: completes a pending second-factor login.
- `GET /api/bff/session`: returns the current user and expiry, or 401.
- `POST /api/bff/session/logout`: ends the session; idempotent.
- `POST /api/bff/session/refresh`: route exists in the controller. The work-order specification does not list it, and no test carries its id (see Known gaps).
- Web rewrites send `/api/graphql` and `/api/bff/*` to the BFF, so the `__Host-` cookies stay on one origin.

## Rules
- **S48.R-01** The page response MUST carry [`Cache-Control: private, no-store` ↗](../sw-external-terms.md#cache-control) and a [`Server-Timing` ↗](../sw-external-terms.md#server-timing) header with one entry per [section](../terms/section.md). [proof: S48 AS-01, S48 AS-23] [code: packages/backend/libs/composition/bff/page/product-page.controller.ts#ProductPageController]
- **S48.R-02** A path ID that is not a UUID MUST give [`400 validation_failed`](../terms/validation-failed-error.md) with no [upstream call](../terms/upstream.md). [proof: S48 AS-08]
- **S48.R-03** Only the product is [required](../terms/required-section.md): an unknown or invisible product gives [`404 not_found`](../terms/not-found-error.md), and a failed [optional section](../terms/required-section.md) gives `null` plus one [`errors` entry](../terms/errors-entry.md) `{section, code, [retryable](../terms/retryable.md)}`. [proof: S48 AS-07, S48 AS-13, S48 AS-14]
- **S48.R-04** A section that does not apply ([anonymous chat](../terms/anonymous-chat-section.md), no coordinates, no [`shopId`](../terms/shop-id-param.md)) MUST be `null` with no [error entry](../terms/errors-entry.md) and no upstream call. [proof: S48 AS-02, S48 AS-04, S48 AS-05]
- **S48.R-05** Only the product call is retried, once, with [jittered backoff ↗](../sw-external-terms.md#exponential-backoff). A second 503 gives [`503 upstream_unavailable`](../terms/upstream-unavailable.md) with [`Retry-After` ↗](../sw-external-terms.md#retry-after). [proof: S48 AS-09]
- **S48.R-06** A product body that fails [`productPublicSchema`](../terms/product-public-schema.md) MUST give [`502 upstream_invalid`](../terms/upstream-invalid.md) with a [generic `detail`](../terms/problem-detail.md). [proof: S48 AS-10]
- **S48.R-07** The [page deadline](../terms/page-deadline.md) is 1,000 ms. A [dependent section](../terms/dependent-section.md) gets only the time left, and a section past it is `null` with [`BUDGET_EXCEEDED`](../terms/budget-exceeded.md). [proof: S48 AS-12, S48 AS-16]
- **S48.R-08** After 5 consecutive failures within 10 s, an [optional upstream](../terms/upstream.md)'s [breaker ↗](../sw-external-terms.md#circuit-breaker) opens for 10 s and its section is `null` with [`CIRCUIT_OPEN` ↗](../sw-external-terms.md#circuit-breaker). [proof: S48 AS-17]
- **S48.R-09** An upstream with [100 calls in flight](../terms/upstream-in-flight-limit.md) leaves its optional section `null` with [`UPSTREAM_OVERLOADED`](../terms/upstream-in-flight-limit.md); the product call then gives [`503 overloaded`](../terms/upstream-in-flight-limit.md). [proof: S48 AS-18]
- **S48.R-10** The [BFF ↗](../sw-external-terms.md#bff) MUST NOT forward [`X-User-Id`](../terms/x-user-id-header.md), [`X-User-Role`](../terms/identity-headers.md), [`X-Tenant-Id`](../terms/identity-headers.md), [`X-Shop-Id`](../terms/x-shop-id-header.md), `Cookie` or an [invalid `X-Anonymous-Id`](../terms/x-anonymous-id.md) to any upstream. [proof: S48 AS-21]
- **S48.R-11** A request carrying both a [session cookie](../terms/session-cookie.md) and an [`Authorization` header ↗](../sw-external-terms.md#authorization-bearer) MUST give [`400 ambiguous_credentials`](../terms/ambiguous-credentials.md). [proof: S48 AS-60]
- **S48.R-12** A [credentialed upstream](../terms/upstream.md) 401 MUST give [`401 invalid_token`](../terms/invalid-token-error.md) for the whole [page](../terms/page-aggregate.md). [proof: S48 AS-11]
- **S48.R-13** A [token](../terms/access-token.md) MUST go only to the [configured domain-API origin](../terms/domain-api-origin.md). [proof: S48 AS-63]
- **S48.R-14** The page endpoint allows 300 requests per minute per [principal](../terms/principal.md); the 301st gives [`429 rate_limited`](../terms/rate-limited.md). See {{concept:rate-limit-policy}}. [proof: S48 AS-22]
- **S48.R-15** The [shared cache ↗](../sw-external-terms.md#shared-cache) MAY hold a [public section](../terms/section.md) only as long as the upstream's [`s-maxage` ↗](../sw-external-terms.md#cache-control) allows. Public upstream calls are [single-flighted ↗](../sw-external-terms.md#single-flight). See {{concept:cache-layers}}. [proof: S48 AS-19, S48 AS-20]
- **S48.R-16** A GraphQL query [deeper than 6 levels or costing more than 2,000](../terms/graphql-query-limits.md) MUST be rejected before any [upstream call](../terms/upstream.md). [proof: S48 AS-31, S48 AS-32]
- **S48.R-17** [GraphQL loaders](../terms/loader.md) live for one request and [one principal](../terms/principal.md); each [batch call](../terms/batch-shops-lookup.md) carries at most 100 IDs. [proof: S48 AS-25, S48 AS-27, S48 AS-28]
- **S48.R-18** A cookie-authenticated POST MUST carry an [`X-CSRF-Token` ↗](../sw-external-terms.md#csrf-token) equal to the [`__Host-bff-csrf` cookie ↗](../sw-external-terms.md#csrf-token), or the [BFF ↗](../sw-external-terms.md#bff) answers [`403 csrf_invalid` ↗](../sw-external-terms.md#csrf-token). Login uses an [origin check](../terms/origin-allow-list.md) instead. [proof: S48 AS-44, S48 AS-59]
- **S48.R-19** [Refresh](../terms/token-refresh.md) is [single-flight ↗](../sw-external-terms.md#single-flight) per session: tokens with 30 s or less left are refreshed once, and the call is never retried. [proof: S48 AS-53, S48 AS-54]
- **S48.R-20** A cookie-bearing request MUST give [`503 session_unavailable`](../terms/session-store.md) when the [session store](../terms/session-store.md) is down; an [anonymous request](../terms/x-anonymous-id.md) is served normally. [proof: S48 AS-61]

## Behaviors
- **S48.B-01** Given a visible product and healthy [upstream](../terms/upstream.md)s, when an anonymous visitor requests the page, then it returns 200 with every [section](../terms/section.md) and no [`Authorization` header ↗](../sw-external-terms.md#authorization-bearer) upstream. [proof: S48 AS-01, S48 AS-02]
- **S48.B-02** Given a signed-in session, when the page loads, then [flags and chat](../terms/page-upstream-sections.md) carry that session's [bearer token ↗](../sw-external-terms.md#authorization-bearer) and [`chatUnread`](../terms/chat-unread.md) is passed through with its [`nextCursor`](../terms/pagination-cursor.md). [proof: S48 AS-03]
- **S48.B-03** Given recommendations answer after 500 ms ([budget 300 ms](../terms/section-budget.md)), when the page loads, then [`recommendations`](../terms/get-product-recommendations.md) is [`null`](../terms/null-section.md) with [`UPSTREAM_TIMEOUT`](../terms/upstream-timeout.md) and other sections stay intact. [proof: S48 AS-12]
- **S48.B-04** Given all eleven [optional sections](../terms/required-section.md) fail, when the page loads, then it is still 200 with eleven `null` sections and eleven [error entries](../terms/errors-entry.md). [proof: S48 AS-14]
- **S48.B-05** Given 50 visitors request one product within 50 ms, when the page loads, then each [public upstream](../terms/public-upstream.md) [is called once ↗](../sw-external-terms.md#single-flight). [proof: S48 AS-20]
- **S48.B-06** Given [`products(ids: [A, B, A, C])`](../terms/products-ids-query.md) where B is [invisible](../terms/search-visibility.md), when executed, then the result is `[A, null, A, C]` and the [batch call](../terms/batch-shops-lookup.md) carries A, B, C once. [proof: S48 AS-26]
- **S48.B-07** Given the product batch answers 503, when a query runs, then 200 with [`errors[]`](../terms/graphql-errors-array.md) carrying [`path`](../terms/graphql-error-path.md) and [`UPSTREAM_UNAVAILABLE`](../terms/upstream-unavailable.md), and [independent fields](../terms/partial-response.md) stay. [proof: S48 AS-29]
- **S48.B-08** Given a document with 21 [root fields](../terms/too-many-root-fields.md), a [batched array body](../terms/batching-not-supported.md), or a body over 8 KB, then the [BFF ↗](../sw-external-terms.md#bff) answers `400 TOO_MANY_ROOT_FIELDS`, `400 batching_not_supported` or [`413 payload_too_large`](../terms/payload-too-large.md). [proof: S48 AS-33]
- **S48.B-09** Given `products(ids:)` with [51 IDs](../terms/products-ids-limit.md), then `400 BAD_USER_INPUT`; with `[]`, then `[]` and no upstream call. [proof: S48 AS-34]
- **S48.B-10** Given a 2,000 ms [operation deadline](../terms/page-deadline.md) and an upstream answering after 5 s, then the response arrives within 2,100 ms with [`BUDGET_EXCEEDED`](../terms/budget-exceeded.md) fields. [proof: S48 AS-35]
- **S48.B-11** Given a [principal](../terms/principal.md) that used its 20,000 [cost units](../terms/rate-limit-cost.md) this minute, when it sends a query, then [`429 rate_limited`](../terms/rate-limited.md) with [`Retry-After` ↗](../sw-external-terms.md#retry-after) and [no upstream call](../terms/upstream.md). [proof: S48 AS-36]
- **S48.B-12** Given a [known hash](../terms/persisted-query-hash.md) sent with GET and no [credential](../terms/credential.md)s, then the response is [`public, s-maxage=5` ↗](../sw-external-terms.md#cache-control); with any credential it is [`private, no-store` ↗](../sw-external-terms.md#cache-control). [proof: S48 AS-38]
- **S48.B-13** Given production configuration, when a client asks [`__schema`](../terms/graphql-introspection.md), then [`INTROSPECTION_DISABLED`](../terms/graphql-introspection.md) and [zero upstream calls](../terms/upstream.md). [proof: S48 AS-40]
- **S48.B-14** Given a registered user and an allowed [`Origin`](../terms/origin-allow-list.md), when login is sent, then 200 with the user and [`expiresAt`](../terms/session-lifetime.md), and a new [session cookie](../terms/session-cookie.md). [proof: S48 AS-43]
- **S48.B-15** Given a user with a [second factor](../terms/mfa-state.md), when login is sent, then 200 [`{mfaRequired: true}`](../terms/mfa-challenge.md) and only [`__Host-bff-mfa`](../terms/host-bff-mfa-cookie.md) is set. [proof: S48 AS-48]
- **S48.B-16** Given two concurrent correct [MFA verifies](../terms/mfa-verify-endpoint.md), then one gets 200 and the other [`409 mfa_not_pending`](../terms/mfa-not-pending.md). [proof: S48 AS-50]
- **S48.B-17** Given the [identity service](../terms/identity-domain.md) refuses a [refresh](../terms/token-refresh.md) with [`401 invalid_refresh_token`](../terms/invalid-refresh-token-error.md), then the session ends and the answer is [`401 session_expired`](../terms/session-expired.md). [proof: S48 AS-55]
- **S48.B-18** Given a refresh times out while the [access token](../terms/access-token.md) is still valid, then the request proceeds and [the session is kept](../terms/session-lifetime.md). [proof: S48 AS-56]
- **S48.B-19** Given logout without a [CSRF token ↗](../sw-external-terms.md#csrf-token), then [`403 csrf_invalid` ↗](../sw-external-terms.md#csrf-token); with one, `204`, [record deleted](../terms/session-store.md) and [cookies cleared](../terms/session-cookie.md). [proof: S48 AS-58]
- **S48.B-20** Given sessions of users A and B used in [interleaved calls ↗](../sw-external-terms.md#race-condition), then each [upstream call](../terms/upstream.md) carries only its own token. [proof: S48 AS-62]

## Lifecycles
The session record has three statuses: `PENDING_MFA`, `ACTIVE`, `ENDED`. Login success or a MFA success creates `ACTIVE`. Login with a second factor creates `PENDING_MFA` (5 minutes). The BFF moves a session to `ENDED` on logout, 24 h idle, 30 days absolute, ended identity session, or refused refresh. See {{cap:S01}}. No model file exists.

## Owns
- No table, queue, topic or event. The BFF talks to domains over HTTP only.
- Redis data: session records (key = SHA-256 of cookie value, encrypted), pending-MFA state, refresh locks, shaped-response cache, rate limits.
- Cookies: `__Host-bff-session`, `__Host-bff-csrf`, `__Host-bff-mfa` (all `Path=/`; browsers reject a `__Host-` cookie with another path).
- Guest cart token: the BFF forwards the orders domain's `guest:<uuid>.<signature>` token only if it matches `^[A-Za-z0-9._~:-]{1,1024}$`. [code: packages/backend/libs/composition/bff/upstream/upstream-client.ts]
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
- `navigator.sendBeacon` to `POST /api/events` from a signed-in visitor carries no `X-CSRF-Token` and is refused `403 csrf_invalid` by the forwarder; the loss is accepted (no CSRF exemption). [proof: S48 W02-H9]
- AS-64 (P2, boundary checks) has no test with a scenario id in this list.
- Rule 15 cache TTL limit (30 s) and the `private`/`no-store` upstream cases are only partly tied to AS-19.
- AS-37 (trusted documents), AS-39 (allowlist startup check), AS-41 (schema snapshot), AS-42 (GraphQL credentials and CSRF), AS-45 (login relay), AS-46 (X-Forwarded-For), AS-47 (re-login), AS-49, AS-51, AS-52, AS-57 and AS-24 (keep-alive reuse) are covered by tests but are not in a rule or behavior above.
- `POST /api/bff/session/refresh` has no specification entry or test.
- The `/api/bff/f/*` forwarder (web rewrite) is not described in the work-order specification here.
- Mutations and subscriptions are rejected; the future mutation forwarding contract is untested.