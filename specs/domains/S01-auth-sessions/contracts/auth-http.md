# Contract: S01 HTTP surface

All under `/api` unless noted; errors are `application/problem+json` (`type,title,status,detail,instance,requestId` + stable `code`). Request/response schemas live in `packages/contracts/src/auth/`. Credential-bearing responses carry `Cache-Control: no-store` and `Pragma: no-cache`. State-changing routes accept only `application/json` (`415 unsupported_media_type` otherwise), body ≤ 16 KB (`413`).

| Route | Auth | Policies (`@RateLimit`) | Success | Errors |
|---|---|---|---|---|
| `POST /auth/register` `{email, password, role?}` | public | `auth.register.ip` | `202 {"status":"accepted"}`, no cookies | 400 `validation_failed`, 422 `weak_password`, 429, 503 `overloaded` |
| `POST /auth/login` `{email, password, delivery?}` | public | `auth.login.ip`, `auth.login.account` (failures-only, resetOnSuccess) | 200 body tokens, or cookie delivery (3 cookies, no token in body), or `{mfaRequired:true, mfaToken}` | 400, 401 `invalid_credentials`, 403 `origin_not_allowed` (cookie delivery), 429, 503 |
| `POST /auth/refresh` `{refreshToken?}` | refresh token (body or `__Host-refresh` + CSRF) | `auth.refresh.ip` | 200 as login | 400 (>256 chars), 401 `invalid_refresh_token`, 403 `csrf_invalid`, 429 |
| `POST /auth/logout` | access token | — | 204; cookies cleared in cookie mode | 401 `invalid_token`, 403 `csrf_invalid`/`origin_not_allowed` |
| `POST /auth/logout-all` (sensitive) | access token | — | 200 `{revokedSessions}` | 401 |
| `GET /auth/sessions` | access token | — | 200 `[{sessionId, device, ip, createdAt, lastUsedAt, current}]` | 401 |
| `DELETE /auth/sessions/:sessionId` (sensitive) | access token | — | 204 | 401, 404 `session_not_found` (also for another user's id) |
| `GET /auth/me` | access token | — | 200 `{id, email, role}` (email read via `UserDirectoryService`) | 401 |
| `POST /auth/password-reset/request` `{email}` | public | `auth.reset.ip` + code check of `auth.reset.account` | 202 `{"status":"accepted"}` | 400, 429 |
| `POST /auth/password-reset/confirm` `{token, password}` | public | `auth.reset.confirm.ip` | 204 (revokes all sessions) | 400 `invalid_reset_token` / `validation_failed`, 422 `weak_password`, 429 |
| `GET /.well-known/jwks.json` (no prefix) | public | default | 200 JWKS, `Cache-Control: public, max-age=300, stale-while-revalidate=3600`, `ETag`; 304 on match | — |
| `POST /auth/mfa/*`, `/auth/oidc/*` | S02 | S02 | unchanged, re-wired onto `SessionIssuer` | — |
| `GET /auth/logout`, `/logout-all`, `/refresh` | — | — | 404/405, no state change | — |

Cookies (cookie delivery): `__Host-access`, `__Host-refresh` (`HttpOnly; Secure; SameSite=Lax; Path=/`, no `Domain`, `Max-Age` = lifetime), `__Host-csrf` (same but not HttpOnly). Cookie-authenticated state changes need `X-CSRF-Token` = cookie, valid for the session, and an allowed `Origin` (or `Sec-Fetch-Site` ≠ `cross-site` when `Origin` is absent). Bearer-authenticated requests are exempt from CSRF.

Access token: ES256, header `typ: at+jwt`, `kid`; claims `iss: marketplace`, `aud: marketplace-api`, `sub`, `sid`, `role`, `amr`, `iat`, `nbf`, `exp = iat+300`, `jti`; no e-mail.

## Operator routes (S49 follow-up; ADMIN only; `IdentityOpsModule`, hosted by `core`)

| Route | Calls | Success | Notes |
|---|---|---|---|
| `GET /admin/jobs?status&type&shopId&limit&cursor` | `listJobs` | 200 `{items: JobDto[], nextCursor?}` | limit 1–100 (default 50, clamped); tampered cursor → 400 `validation_failed` |
| `GET /admin/jobs/stats` | `getStats` | 200 per-type counts, oldest due `runAt`, lag seconds | |
| `POST /admin/jobs/:id/retry` | `retryDead(id, user.id)` | 200 `{outcome:'RETRIED'}`; 409 `{outcome:'CONFLICT', status}`; 404 | sensitive; audit line written by the service |
| `POST /admin/jobs/:id/cancel` | `cancel(id)` | result of `JobsService.cancel` mapped like retry | sensitive |
| `GET /admin/job-schedules` | `listSchedules` | 200 `ScheduleDto[]` | |
| `POST /admin/job-schedules/:name/enable` · `/disable` | `setScheduleEnabled` | 200 `{name, enabled}`; 404 when the name is unknown | sensitive |

Responses use `JobDto {id,type,status,runAt,attempts,maxAttempts,shopId,lastError,createdAt,finishedAt}` — never the payload. `401` without token, `403` for any non-ADMIN role.

## Error codes (FR-100)

`validation_failed` 400 · `invalid_credentials` 401 · `invalid_token` 401 · `invalid_refresh_token` 401 · `csrf_invalid` 403 · `origin_not_allowed` 403 · `service_caller_not_allowed` 403 · `session_not_found` 404 · `invalid_reset_token` 400 · `unsupported_media_type` 415 · `weak_password` 422 · `rate_limited` 429 · `overloaded` 503. Any 5xx has a generic `detail`. Registered through `ProblemCatalogModule.forFeature`.
