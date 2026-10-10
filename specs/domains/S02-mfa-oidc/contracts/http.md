# Contract: S02 HTTP surface

All under `/api`; errors are `application/problem+json` (`type,title,status,detail,instance,requestId` + stable `code`, codes of FR-100). Schemas live in `packages/contracts/src/auth/` and are the single source for server DTO checks in tests and for the web client: `mfaStatusSchema`, `mfaEnrollSchema`, `mfaRecoveryCodesSchema`, `oidcProviderSchema`, `oidcStartSchema`, `federatedIdentitySchema` (plus the existing `authSessionSchema`). Credential-bearing and code-bearing responses carry `Cache-Control: no-store` and `Pragma: no-cache`. State-changing routes accept only `application/json` (`415 unsupported_media_type`), body ≤ 16 KB, unknown fields rejected (`400 validation_failed`). Authentication and throttling run before body validation.

## Second factor

| Route | Auth | `@RateLimit` + code budget | Success | Errors |
|---|---|---|---|---|
| `GET /auth/mfa` | access token | — | `200 {state:'none'\|'pending'\|'enabled', enabledAt?, recoveryCodesRemaining?}` (`mfaStatusSchema`; no secret, no digests) | 401 |
| `POST /auth/mfa/enroll` (sensitive, no body) | access token | — | `200 {otpauthUri, manualEntryKey}` (`mfaEnrollSchema`); state `pending`, expiry 15 min | 401, 409 `mfa_already_enabled` |
| `POST /auth/mfa/confirm {code}` (sensitive) | access token | `auth.mfa.ip` + `auth.mfa.account` | `200 {recoveryCodes: string[10]}` (`XXXXX-XXXXX`) | 400 (code not `^\d{6}$`), 401, 409 `mfa_not_pending`, 422 `invalid_code`, 429 |
| `POST /auth/mfa/verify {mfaToken?, code, delivery?}` | challenge (body `mfaToken`, or `__Host-mfa-challenge` cookie when `delivery:'cookie'` and no `mfaToken`) | `auth.mfa.ip` + `auth.mfa.account` | `200` S01 login result; `amr` `["pwd"\|"fed","otp"\|"rcv","mfa"]`; cookie delivery sets the three S01 cookies and no token in body | 400 (`code` ≤ 32 chars, strict form), 401 `invalid_mfa_challenge` / `invalid_mfa_code`, 403 `origin_not_allowed` (cookie delivery; challenge not consumed), 415, 429 |
| `POST /auth/mfa/recovery-codes/regenerate {code}` (sensitive) | access token | `auth.mfa.ip` + `auth.mfa.account` | `200 {recoveryCodes: string[10]}`; TOTP code only (a recovery code is `422`) | 401, 409 `mfa_not_enabled`, 422 `invalid_code`, 429 |
| `POST /auth/mfa/disable {code}` (sensitive) | access token | `auth.mfa.ip` + `auth.mfa.account` | `204`; TOTP or unspent recovery code | 401, 409 `mfa_not_enabled`, 422 `invalid_code`, 429 |

A challenge defect of any kind (expired, tampered, wrong `typ`/`aud`, spent, burned after 3 wrong codes, user deleted, factor no longer enabled, an access token presented as challenge) is the same `401 invalid_mfa_challenge`. A wrong code of any kind is the same `401 invalid_mfa_code` (login) or `422 invalid_code` (management). `429` carries `Retry-After`.

## Google OIDC and identities

| Route | Auth | `@RateLimit` | Success | Errors |
|---|---|---|---|---|
| `GET /auth/oidc/providers` | public | default | `200 [{id, displayName}]` (`oidcProviderSchema`; enabled static providers only, `[]` when Google is not configured) | — |
| `POST /auth/oidc/:provider/start {returnTo?}` | public; S01 origin check | `auth.oidc.ip` | `200 {authorizationUrl}` (`oidcStartSchema`) + `Set-Cookie: __Host-oidc-flow` | 400 `validation_failed` (bad `returnTo`), 403 `origin_not_allowed`, 404 `oidc_provider_not_found` (unknown/disabled/bad shape, identical), 415, 429, 503 `oidc_provider_unavailable` |
| `POST /auth/oidc/:provider/link/start {returnTo?, code?}` (sensitive) | access token; current TOTP `code` when the factor is `enabled` | `auth.oidc.ip` + `auth.mfa.ip` + code budget | `200 {authorizationUrl}` + flow cookie | 401, 404, 422 `invalid_code`, 429, 503 |
| `GET /auth/oidc/:provider/callback?code&state` (browser navigation) | flow cookie | `auth.oidc.ip` | `302` to `<front>/<validated returnTo>` with S01 cookies (`__Host-access`, `__Host-refresh`, `__Host-csrf`), or to `<front>/login/mfa?returnTo=…` with `__Host-mfa-challenge`, or (link) to `<returnPath>?linked=google`, no cookies | **every** failure is `302 <front>/login?error=<code>`; codes: `oidc_state_invalid`, `oidc_denied`, `oidc_exchange_failed`, `oidc_token_invalid`, `oidc_provider_unavailable`, `email_not_verified`, `account_unavailable`, `link_conflict`, `identity_already_linked`; `429` only from the rate limiter |
| `GET /auth/identities` (access token) | access token | — | `200 [{id, provider, email: string\|null, linkedAt}]` of the caller only (`federatedIdentitySchema`) | 401 |
| `DELETE /auth/identities/:identityId` (sensitive) | access token | — | `204`; event `identity.federated_identity_unlinked` | 401, 404 `identity_not_found` (other user's, unknown, non-UUID or already deleted: identical), 409 `last_login_method` |

Callback responses always carry `Cache-Control: no-store` and `Referrer-Policy: no-referrer`; redirects target only the configured front-end origin; query parameters other than `code`, `state` and the provider's `error`/`error_description` (never echoed) are ignored. `GET` routes never change state except the callback, which is the registered redirect target of the provider; it consumes the flow record (single use) and nothing else is reachable by `GET`.

Cookies set by S02 (all `Secure`, no `Domain`, `Path=/`, `SameSite=Lax`):

| Cookie | HttpOnly | Max-Age | Set by | Cleared by |
|---|---|---|---|---|
| `__Host-oidc-flow` | yes | 600 s | `…/start`, `…/link/start` | callback (always) |
| `__Host-mfa-challenge` | yes | 300 s | callback when the user has an enabled factor | `mfa/verify` success or burned challenge |
| `__Host-access`, `__Host-refresh`, `__Host-csrf` | per S01 | per S01 | callback success, `mfa/verify` with `delivery:'cookie'` | S01 logout |

Web and API must share one origin (path-routed) for the `__Host-` cookies set by the callback (S48/W01 contract, spec Cross-capability contracts).

## Return path grammar (`returnTo`, FR-045)

Relative path starting with exactly one `/`, ≤ 512 characters, no control characters, no backslash, no `//` prefix before or after one round of percent-decoding. Invalid → `400 validation_failed` at start; never rewritten. Stored in the flow record; the callback redirects to the stored value only.
