# Contract — backend additions for W01 (`packages/backend`, schemas in `packages/contracts`)

Routes below are what the web plan needs and the built code lacks (research R-01). Where a route is owned by S01/S02, its authoritative contract is that spec's `contracts/*.md`; this file only lists the delta W01 implements and the e2e cases. All errors are problem+json with stable `code`. Every spec below is run with `scripts/sdd/test-spec.sh <pattern>`; wait for `GET /health/ready` after edits.

## B-1 BFF forwarder (C-FWD) — `libs/composition/bff/forward`

| Aspect | Contract |
|---|---|
| Inbound | `ANY /api/bff/f/*path` (reached only through the web rewrite of `/api/:path*`, and of the SSE prefixes) |
| Target | route table (allowlist): SSE prefixes `/api/streams`, `/api/live/:id/events`, `/api/payment/stream`, `/api/assistant/*` → `sseUrl`; everything else under `/api/` → `apiUrl`. `/api/bff/*`, `/api/graphql`, `/api/auth/login|refresh|logout` → `404 not_found` |
| Identity | session cookie present → attach `Authorization: Bearer <access>` from `SessionAccessService` (refresh single-flight); absent → anonymous. Inbound `Authorization`, `Cookie`, `X-CSRF-Token`, `Host`, hop-by-hop headers are dropped |
| Protection | non-`GET/HEAD/OPTIONS` with a session cookie: `OriginGuard` + `CsrfGuard` (`403 origin_not_allowed`/`csrf_invalid`); without a session cookie: no CSRF (anonymous flows) |
| Pass-through | status, `Content-Type`, `Retry-After`, `Cache-Control`, `Location`, problem+json body unchanged; upstream `Set-Cookie` dropped; body and response streamed (no buffering); `Cache-Control: no-store` forced when the request had a session |
| Errors | refresh failed → `401 session_expired`; session store down → `503 session_unavailable` (+`Retry-After`); upstream unreachable → `502 bad_gateway`; body larger than the S48 limit for JSON → `413 payload_too_large` (file uploads keep their own upstream limit: route table flag `streamBody`) |
| Schemas | none new (pass-through) |
| e2e `bff-forward.e2e-spec.ts` | happy (cart read with session reaches core with bearer, response unchanged); anonymous public GET; POST without CSRF → 403; POST with wrong Origin → 403; expired session → 401 `session_expired`; revoked upstream (core 401) passed through; `Retry-After` passed; `/api/bff/session` not reachable via the forwarder; header stripping (core never sees `Cookie`/forged `Authorization`); SSE first event arrives before the stream ends; two concurrent requests with an expiring token cause one refresh |

## B-2 Session refresh (C-REFRESH) — `session.controller.ts`

`POST /api/bff/session/refresh` (guards: `CsrfGuard`, `OriginGuard`) → `200 {user, expiresAt}` (`sessionResponseSchema`), forcing an identity refresh through `RefreshCoordinator` (single flight) so a changed role shows; `401 unauthenticated|session_expired`, `403 csrf_invalid`, `503 session_unavailable`. Added to `bff-session.e2e-spec.ts`: happy (role change visible), no cookie 401, bad CSRF 403, concurrent calls = one upstream refresh.

## B-3 MFA pending cookie path

`session-cookies.ts`: `MFA_PATH` becomes `/` (a `__Host-` cookie requires `Path=/`). Update the cookie assertions in `bff-session.e2e-spec.ts` (only the path value). `Max-Age`, `HttpOnly`, `Secure`, `SameSite` unchanged. Sibling follow-up for S48 recorded in `gaps.md`.

## B-4 Password reset (S01 FR-080..FR-084) — `libs/domains/identity`

`POST /api/auth/password-reset/request {email}` → `202 {"status":"accepted"}` (uniform); `POST /api/auth/password-reset/confirm {token, password}` → `204` (revokes all of the user's sessions) | `400 invalid_reset_token` | `400 validation_failed` | `422 weak_password` | `429`. Policies and codes per S01 `auth-http.md`. Link in the e-mail: `<SITE_URL>/reset-password#token=<token>`. Table: `identity.password_reset_tokens` (data-model.md). Confirm runs in `TransactionRunner.run`.
Schemas in `packages/contracts/src/auth`: `passwordResetRequestSchema` `{email}`, `passwordResetConfirmSchema` `{token, password}`, `registerRequestSchema` `{email, password}` (`.strict()`).
e2e `password-reset.e2e-spec.ts`: request known/unknown address byte-identical body+headers; mail sent only for the known address and contains the fragment link; confirm happy (old password fails, new works, other sessions revoked); reused/expired/unknown token → `400 invalid_reset_token`; weak password → `422` and token still valid; validation failure; 429 on both routes; second request invalidates the first link; raw token absent from DB and logs.

## B-5 Session revocation (S01 FR-037) — `DELETE /api/auth/sessions/:sessionId`

`204`; `404 session_not_found` for unknown or another user's id (IDOR); `401`. Revoking the caller's own current session is allowed by the API (the UI never offers it). Cases: happy (target device's next request 401), IDOR → 404, unknown 404, 401, revoking an already-revoked session → 404. Schema: `sessionListItemSchema` `{sessionId, device, ip, createdAt, lastUsedAt, current}` added to contracts (the GET already returns it).

## B-6 MFA lifecycle (S02 US3) — `libs/domains/identity/api/mfa.controller.ts`

`POST /api/auth/mfa/recovery-codes/regenerate {code}` (TOTP only) → `200 {recoveryCodes[10]}` (old codes stop working); `POST /api/auth/mfa/disable {code}` (TOTP or recovery code) → `204`. Errors: `422 invalid_code`, `409 mfa_not_enabled`, `429 rate_limited` (shared failed-code counter), `401`. Schemas: `mfaCodeRequestSchema` `{code: string(1..64)}` strict (reused by confirm). Specifics per S02 `contracts/http.md`. e2e `mfa-lifecycle.e2e-spec.ts`: regenerate happy + old code rejected at login, wrong code, recovery code not accepted for regenerate, disable with TOTP and with recovery code, `mfa_not_enabled`, 429 after N wrong codes, 401, no secret/digest in any response.

## B-7 Dev mailbox (tests only)

`GET /api/dev/mailbox?to=<address>` → `200 {messages:[{to, subject, text, links:string[]}]}` (newest first, ≤ 50 kept in memory). Exists only when `NODE_ENV !== 'production'` AND `DEV_MAILBOX_ENABLED=true`; otherwise `404`. Provider `MemoryEmailProvider` (`EMAIL_PROVIDER=memory`) in `notifications/infra`. e2e `dev-mailbox.e2e-spec.ts`: disabled → 404; enabled → returns the reset mail; production flag → 404; filter by address; bound of 50.

## B-8 Problem `errors[]`

No backend change (research R-04): `errors: {field, code}[]` stays. Add a contract test that `validation_failed` from register returns `field`/`code` pairs for `email` and `password`.

## B-9 Not built here

C-OIDC (Google session hand-off) — owners S48 + S02. `AUTH_OIDC_ENABLED` stays false.

## B-10 Transaction audit

Every touched backend file is grepped for `// S54 T037 audit`; each site found is migrated to `TransactionRunner.run`/`@Transactional` and the comment deleted. No new `sequelize.transaction`.
