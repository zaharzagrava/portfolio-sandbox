# Questions and chosen defaults: S48 BFF composition

Decision policy: most production-grade option the notes and the constitution support. Lines are sorted BREAKING, then CONTRACT, then LOCAL.

- [BREAKING] Session handling does not exist in code (the BFF forwards the raw `Authorization` header only) → full token-handler: opaque HttpOnly `__Host-bff-session`, server-side encrypted tokens, `POST/GET /api/bff/session`, `/session/mfa`, `/session/logout`, CSRF and origin checks → notes 05/02 §3 and 10/04 §4; constitution VI.2; S01 requires it from S48.
- [BREAKING] Page and GraphQL money: `price: number` (Float) → `priceMinor` (lossless integer scalar as decimal string in GraphQL, integer in REST) + `currency` → III.8, S05/S34/S35 already moved to minor units; the persisted `ProductScreen` document and its hash change.
- [BREAKING] Product-page error entries `{section, reason}` with raw error messages → `{section, code, retryable}` with a closed code set → V.3 (no upstream messages to clients), machine-readable.
- [BREAKING] Product page loads the product first, then everything else → sections that need only the product ID start with it; only `shop` and `trending` wait → 04/01 §1.1: dependency chains cannot be hidden by parallelism, so shorten them.
- [BREAKING] Sections returned as bare arrays or `unknown` (`recommendations`, `trending`) → the owning capability's validated envelope, unchanged → S34 FR-030, S35 FR-027, X.8.2 (validate every response with contracts).
- [BREAKING] `chatUnread: number` (sum of unread) → `chatUnread` = S24's `{items, nextCursor}` page, unchanged → summing a paged answer yields a wrong total when `nextCursor` is set, and summing is domain logic (X.8.3).
- [BREAKING] Silent degradation of GraphQL `recommendations` (`catch → null`) → `null` plus a GraphQL error with `path` and `extensions.code` → the client must know why a field is empty (04/01 §2.1 partial errors apply to GraphQL too).
- [BREAKING] `products(ids)` silently truncates to 50 IDs → `BAD_USER_INPUT` above 50 → silent truncation returns a wrong, shorter answer.
- [BREAKING] Cost limit ignores variable values (`ids: $ids` priced as 1) → cost uses literals and variable values; adds ≤ 20 root fields, one operation per request, 8 KB document, cycle-safe fragments → 04/01 §2.6 "depth and complexity limits"; the existing guard is bypassable by the most common client style.
- [BREAKING] Persisted queries enforced only when `NODE_ENV=production`, POST only, hash trusted without comparing the text → enforced everywhere except explicit local development; hash must equal SHA-256 of the document; `GET` by hash for queries; allowlist validated at startup → trusted documents are the abuse control, not an option.
- [BREAKING] `GraphQL` bearer forwarded on every upstream call, including public ones; product endpoint called with the user's token → token only on sections that declare identity need → least privilege (S01: forward only where needed), keeps public responses cacheable.
- [BREAKING] Upstream `401` on a credentialed call degraded the section silently → whole response `401 invalid_token` → a stale credential must reach the client so it refreshes.
- [BREAKING] Page endpoint is unlimited, no `Cache-Control`, no problem schema, mounted in tests without the production pipeline → rate limit 300/min per principal, `private, no-store`, problem+json from the global filter, e2e boots the production app → V.3, VII.2.
- [BREAKING] `CoreClient` defaults the upstream to `http://localhost:8000` and reads untyped config → no default; startup validation fails fast → VIII.5. The single `CoreClient` is replaced by one typed client per upstream capability (X.8.2).
- [BREAKING] Cookie plus bearer together are accepted today (bearer wins by accident) → `400 ambiguous_credentials` → removes a confused-deputy path.
- [BREAKING] The web GraphQL client keeps the access token in memory and sends it as bearer (`packages/web/lib/api/graphql.ts:20-23`) → browsers use the session cookie and CSRF header; bearer stays for native clients → VI.2, S01 contract (W01 follow-up).
- [CONTRACT] S01 → the BFF must be a trusted proxy for client addresses, and identity must accept refresh from the BFF by body token only → without it all shoppers share the BFF's IP limits (S01 AS-14/AS-15).
- [CONTRACT] S01 → refresh is serialized by the BFF per session across instances; the BFF never retries a refresh; S01's strict reuse detection stays → S01 FR-031 / its Requires of S48.
- [CONTRACT] S50 → needs named policies `bff.product-page.principal`, `bff.graphql.cost` (variable-cost consume), `bff.session.login.ip`, returning `Retry-After` and `RateLimit-*` → rate limiting by query cost is in the notes (04/01 §2.6).
- [CONTRACT] S54 → resilient client must not follow redirects, must expose per-call abort and retry control, trusted-proxy config must include the BFF's upstream hop → AS-21, AS-46.
- [CONTRACT] S02 → OIDC redirect flows keep setting S02's own `__Host-access`/`__Host-refresh` cookies and are not wrapped by the BFF session in this version; web needs one origin for both → unifying (S02 callback hands a one-time code to the BFF) is a later change needing both specs; flagged for W01.
- [CONTRACT] S24 → product page uses `GET /api/chat/unread` pass-through; a per-product `by-product` channel lookup is not composed here → S24 offered it but the shape is a W02 decision.
- [CONTRACT] S36 → sponsored slot is not a page section; W02 calls it per viewer (not cacheable) → keeps the aggregate cacheable per rules and lets S36 own "Sponsored" labelling; a registry entry can add it.
- [CONTRACT] S05, S03, S11, S21, S19, S25, S30, S34, S35, S38 → BFF consumes exactly the endpoints in the spec's Requires list; domains keep them anonymous (except chat) and validate IDs ≤ 100 → their specs already name these endpoints as R2 targets.
- [CONTRACT] `packages/contracts` → new schemas `productPageResponseSchema`, `sessionLoginRequestSchema`, `sessionMfaRequestSchema`, `sessionResponseSchema`, `mfaRequiredResponseSchema`, plus upstream schemas for any section lacking one (flags body, board posts page, pickup page) → X.8.2 requires typed, validated calls.
- [CONTRACT] W01/W02 → same-origin path routing of `/api/bff/*` and `/api/graphql` is required for `__Host-` cookies → already configured in `packages/web/next.config.ts:33-35`.
- [LOCAL] Budgets and limits are the numbers in the spec Assumptions → taken from code and S34/S35, tunable by configuration.
- [LOCAL] SD-04's "p99 < 150 ms with one dependency slowed to 2 s" → restated as "within the 1 s page deadline" (SC-008) → 300 ms budgets cannot meet 150 ms.
- [LOCAL] Retry only the product call, once → optional sections are cheaper to drop than to retry; one retry layer (IV.6).
- [LOCAL] Circuit breaker and bulkhead are per instance, in memory → no shared state needed; fallback proven by tests (VII.9).
- [LOCAL] Shared cache honours the upstream `Cache-Control` (≤ 30 s) instead of fixed BFF TTLs → domains know their own freshness.
- [LOCAL] Session record encrypted with an application key (two keys accepted for rotation), key hashed for lookup → a store leak is not a token leak.
- [LOCAL] Refresh skew 30 s, refresh wait 3 s, session write retries 3 → keeps the 300 s S01 token usable without mid-request expiry.
- [LOCAL] GraphQL read-only, no subscriptions → no mutation fan-out risk (X.8.3); a later mutation forwards to one endpoint with its `Idempotency-Key`.
- [LOCAL] No service-to-service token for public reads → domains' public routes are anonymous; user token is the only forwarded identity.
- [LOCAL] Readiness not tied to Redis or upstreams → VIII.3 (no fleet-wide readiness failure on a shared dependency).
