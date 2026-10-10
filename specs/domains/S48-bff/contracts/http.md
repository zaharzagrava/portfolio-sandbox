# Contract: S48 BFF HTTP surface

Schemas live in `packages/contracts/src/bff/` (names below). Every error is RFC 9457 `application/problem+json` from the global filter with `type`, `title`, `status`, `detail`, `instance`, `requestId`, `code`; 5xx `detail` is generic. Every route is under the global `/api` prefix. Routes not listed here do not exist (no cart, order, payment, search or mutation surface; FR-037, FR-050).

## Credentials accepted (page, GraphQL, session `GET`)

| Presented | Meaning |
|---|---|
| nothing | anonymous (optional `X-Anonymous-Id`, 8–64 of `[A-Za-z0-9_-]`, otherwise ignored) |
| `__Host-bff-session` cookie | browser session; the BFF resolves the access token server-side |
| `Authorization: Bearer <S01 token>` | native/mobile; forwarded unchanged, only to sections that need identity |
| cookie **and** `Authorization` | `400 ambiguous_credentials`, no upstream call |

Cookie unknown/expired → the session is ended, cookies cleared, public reads served as anonymous, `GET /session` answers `401`. Session store unreachable with a cookie → `503 session_unavailable` + `Retry-After`.

## `GET /api/bff/product-page/:productId`

Query (`pageQuerySchema`, strict): `lat`, `lng` (both or neither), `radiusKm` 1–100 (default 10). Header: `X-Anonymous-Id` (optional).

| Status | Body | Headers |
|---|---|---|
| `200` | `productPageResponseSchema` | `Cache-Control: private, no-store`, `Server-Timing: product;dur=…, shop;dur=…, …` (one entry per section) |
| `400` | `validation_failed` (non-UUID, bad coordinates, unknown parameter) / `ambiguous_credentials` | `no-store` |
| `401` | `invalid_token` (an upstream rejected the forwarded credential) | `no-store` |
| `404` | `not_found` | `no-store` |
| `429` | `rate_limited` (`bff.product-page.principal`, 300/min) | `Retry-After`, `RateLimit`, `RateLimit-Policy` |
| `502` | `upstream_invalid` (product body failed its schema) | |
| `503` | `upstream_unavailable` (product timeout/5xx after one retry, `Retry-After`), `overloaded` (`Retry-After: 1`), `session_unavailable`, `rate_limiter_unavailable` (only if a closed policy is configured) | |

Body fields: `product` (required, S05 public view: money as `priceMinor` + `currency`), and nullable `shop`, `recommendations`, `trending`, `flags`, `chatUnread`, `discussions`, `videos`, `pickup`, `flashSale`, `auction`, then `errors: [{section, code, retryable}]`. A `null` section with no `errors` entry means "does not apply or nothing to show". Codes: `UPSTREAM_TIMEOUT UPSTREAM_UNAVAILABLE UPSTREAM_NOT_FOUND UPSTREAM_RATE_LIMITED UPSTREAM_INVALID UPSTREAM_OVERLOADED CIRCUIT_OPEN BUDGET_EXCEEDED`. Entries hold no message, URL or upstream body.

Section table (budget = per call; the page deadline is 1,000 ms; a dependent section gets `min(budget, time left)`):

| Section | Upstream | Budget | Starts | Identity | Shared cache |
|---|---|---|---|---|---|
| `product` (required) | S05 `GET /api/products/:id` | 800 ms, one retry | t0 | none | yes |
| `shop` | S03 `GET /api/batch/shops?ids=` | 300 | after product | none | yes |
| `recommendations` | S34 `GET /api/products/:id/recommendations?limit=8` | 300 | t0 | none | yes |
| `trending` | S35 `GET /api/trending?category=` | 200 | after product | none | yes |
| `flags` | S38 `GET /api/flags` | 150 | t0 | bearer if present; `X-Anonymous-Id` | never |
| `chatUnread` | S24 `GET /api/chat/unread` (signed-in only) | 200 | t0 | bearer required | never |
| `discussions` | S25 `GET /api/boards/:id/posts?sort=hot&limit=3` | 300 | t0 | none | yes |
| `videos` | S30 `GET /api/products/:id/videos` | 300 | t0 | none | yes |
| `pickup` | S19 `GET /api/pickup-points/near?…` (only with `lat`/`lng`) | 300 | t0 | none | yes |
| `flashSale` | S11 `GET /api/flash-sales?productIds=` → first or `null` | 200 | t0 | none | yes |
| `auction` | S21 `GET /api/auctions?productIds=` → first or `null` | 200 | t0 | none | yes |

## `POST /api/graphql`, `GET /api/graphql`

| Rule | Answer |
|---|---|
| body not `application/json` | `415 unsupported_media_type` |
| document > 8 KB | `413 payload_too_large` (before parsing) |
| JSON array body | `400 batching_not_supported` |
| query text without hash (non-local) | `400 persisted_query_required` |
| hash ≠ SHA-256(text) | `400 persisted_query_mismatch` (nothing registered) |
| unknown hash | `200`, `errors[0].extensions.code = PERSISTED_QUERY_NOT_FOUND`, no data |
| depth > 6 / cost > 2,000 / > 20 root fields | `400`, `extensions.code` `QUERY_TOO_DEEP` / `QUERY_TOO_COSTLY` / `TOO_MANY_ROOT_FIELDS`, `Cache-Control: no-store`, zero upstream calls |
| `ids` > 50, `first` > 50, non-UUID | `BAD_USER_INPUT` naming argument and maximum (never truncated) |
| introspection in production | `INTROSPECTION_DISABLED` |
| mutation / subscription | validation error (schema has none) |
| cookie `POST` without valid CSRF / disallowed origin | `403 csrf_invalid` / `origin_not_allowed` |
| cost budget (20,000 units/min per principal) spent | `429 rate_limited`, `Retry-After`, `RateLimit`, `RateLimit-Policy`; rejected queries are charged 1 unit |
| `GET` with a known hash, no credentials | `200`, `Cache-Control: public, s-maxage=5`, `Vary: Authorization, Cookie, X-Anonymous-Id`; with any credential `private, no-store`; `GET` with raw text or a non-query → `400` |

Field errors: standard `errors[]` with `path` and `extensions.code` (the section codes above); each failed batch is reported once per path; no stack trace, upstream message, URL or SQL. Operation deadline 2,000 ms (`BUDGET_EXCEEDED`). Money: `priceMinor` (scalar `MinorUnits`, decimal string) + `currency`; no `Float` money field. The printed schema equals `graphql/schema.snapshot.graphql`; removals require `@deprecated` first.

## Session endpoints

All answers carry `Cache-Control: no-store`. Rate limit: `bff.session.login.ip` (20/min per address, fail closed) on `POST /session` and `POST /session/mfa`.

| Route | Request | Success | Failures |
|---|---|---|---|
| `POST /api/bff/session` | `sessionLoginRequestSchema` `{email, password}` (strict, ≤ 16 KB, JSON); `Origin` check | `200 sessionResponseSchema` + `Set-Cookie` `__Host-bff-session` (`HttpOnly; Secure; SameSite=Lax; Path=/`) and `__Host-bff-csrf` (`Secure; SameSite=Lax; Path=/`); or `200 mfaRequiredResponseSchema` + `__Host-bff-mfa` (`HttpOnly; Secure; SameSite=Lax; Path=/api/bff/session; Max-Age=300`) | `400 validation_failed`, `403 origin_not_allowed`, `413`, `415`, `401 invalid_credentials` (identical for unknown address), `429 rate_limited`, `503` with `Retry-After`; S01 problem `code`s relayed in meaning |
| `POST /api/bff/session/mfa` | `sessionMfaRequestSchema` `{code}`; `__Host-bff-mfa` cookie; `X-CSRF-Token`/origin per rules | `200 sessionResponseSchema` + session cookies, pending cookie cleared | `409 mfa_not_pending`, S02 `401` for a wrong code (pending kept), `401 invalid_token` for a spent/expired challenge, `403 csrf_invalid`/`origin_not_allowed`, `429` |
| `GET /api/bff/session` | cookie | `200 sessionResponseSchema` | `401 unauthenticated` (no/unknown cookie; unknown cleared), `401 session_expired`, `503 session_unavailable` |
| `POST /api/bff/session/logout` | cookie, `X-CSRF-Token` | `204`, cookies cleared (`Max-Age=0`, same attributes), S01 logout best effort | `403 csrf_invalid`; no cookie or replay → `204`, no upstream call |

Cookie-authenticated requests that need a refresh: one S01 `POST /api/auth/refresh` per session at a time across instances; `session_expired` after a rejected refresh; `503 session_unavailable` + `Retry-After` when identity is down and the token has expired.

Problem codes owned here: `validation_failed`, `ambiguous_credentials`, `origin_not_allowed`, `csrf_invalid`, `mfa_not_pending`, `unauthenticated`, `session_expired`, `session_unavailable`, `invalid_token`, `not_found`, `rate_limited`, `rate_limiter_unavailable`, `rate_limit_cost_exceeded`, `upstream_unavailable`, `upstream_invalid`, `overloaded`, `persisted_query_required`, `persisted_query_mismatch`, `batching_not_supported`, `payload_too_large`, `unsupported_media_type`.

## Headers the BFF sends upstream

Only: `Accept`, `X-Request-Id`, `traceparent`/`tracestate`, `Authorization` (sections with identity, configured origin only), `X-Anonymous-Id` (flags only, valid value), and for identity calls `X-Forwarded-For` (real client address, last hop). Never forwarded: `Cookie`, `X-User-Id`, `X-User-Role`, `X-Tenant-Id`, `X-Shop-Id`, inbound `X-Forwarded-*`. Redirects are not followed.

## Consumer obligations

- W02/web server: treat every section except `product` as nullable; read `errors` for reasons, never show codes; money from `priceMinor` + `currency`; never put the response in a shared cache.
- W01/web client: never read or store a token; send `X-CSRF-Token` (copied from `__Host-bff-csrf`) on cookie-authenticated `POST`s; switch on the problem `code`, never on message text; same origin for `/api/bff/*` and `/api/graphql`.
- Native clients: bearer only, no cookie; handle `429` with `Retry-After` and the structured `RateLimit` / `RateLimit-Policy` headers (the legacy `RateLimit-Limit|Remaining|Reset` and `X-RateLimit-*` do not exist).
