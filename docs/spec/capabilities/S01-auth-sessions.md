---
id: S01
title: Registration, password login, sessions, refresh-token rotation, JWKS, service-to-service tokens
kind: capability
status: draft
generated_at: e95ce81
depends_on: [S50, S53, S54, S49]
concepts: [access-token-session, rate-limit-policy, problem-json-errors, outbox-task-queue, job-scheduler-lease, transaction-runner]
models: []
scope:
  - packages/backend/libs/domains/identity/**
---
# S01 - Registration, password login, sessions, refresh-token rotation, JWKS, service-to-service tokens
## Purpose
Buyers, sellers and other backend capabilities need a way to prove who a caller is. S01 registers accounts, checks passwords, and issues short-lived {{concept:access-token-session}} credentials with rotating refresh tokens. It also publishes the public keys that let any service verify those tokens, and it offers user-directory and session-revocation facilities to other domains. It resists account enumeration, brute force and token theft.

## Entry points
- `POST /auth/register` — creates an account; always answers `202 {"status":"accepted"}`. [code: packages/backend/libs/domains/identity/api/auth.controller.ts#AuthController]
- `POST /auth/login` — password login; returns tokens in the body, sets cookies for `delivery: "cookie"`, or returns `{mfaRequired, mfaToken}` when a second factor is enrolled ({{cap:S02}} completes that flow). [code: packages/backend/libs/domains/identity/api/auth.controller.ts#AuthController]
- `POST /auth/refresh` — exchanges a refresh token for a new access token and a new refresh token. [code: packages/backend/libs/domains/identity/application/refresh.service.ts#RefreshService]
- `POST /auth/logout` and `POST /auth/logout-all` — revoke the current session or all sessions of the caller; `logout-all` answers `200 {revokedSessions}` and is a sensitive route. [code: packages/backend/libs/domains/identity/api/auth.controller.ts#AuthController]
- `GET /auth/sessions` and `DELETE /auth/sessions/:sessionId` — list the caller's active sessions; revoke one of them (sensitive). [code: packages/backend/libs/domains/identity/api/sessions.controller.ts#SessionsController]
- `GET /auth/me` — returns the signed-in user.
- `POST /auth/password-reset/request` and `POST /auth/password-reset/confirm` — password reset by single-use token.
- `GET /.well-known/jwks.json` — public key set, served outside the `/api` prefix without credential, with `ETag` and `304`. [code: packages/backend/libs/domains/identity/api/well-known.controller.ts#WellKnownController]
- Scheduled jobs: `auth.rotate-signing-keys` (daily, no run at boot) and `auth.purge-reset-tokens` (daily). [code: packages/backend/libs/domains/identity/infra/keys/key-rotation.jobs.ts#KeyRotationJobs] [code: packages/backend/libs/domains/identity/infra/jobs/reset-token.jobs.ts#ResetTokenJobs]
- Operator routes, ADMIN only, hosted by `core`: `GET /admin/jobs`, `GET /admin/jobs/stats`, `POST /admin/jobs/:id/retry`, `POST /admin/jobs/:id/cancel`, `GET /admin/job-schedules`, `POST /admin/job-schedules/:name/enable` and `POST /admin/job-schedules/:name/disable`. [code: packages/backend/libs/domains/identity/api/jobs-admin.controller.ts#JobsAdminController]
- Exported services for other domains: `UserDirectoryService`, `SessionRevocationService`, `ServiceTokenService`, `SecretBox`; the guard `ServiceAuthGuard` with `@AllowedCallers(...)` protects internal endpoints. [code: packages/backend/libs/domains/identity/application/user-directory.service.ts#UserDirectoryService] [code: packages/backend/libs/domains/identity/api/guards/service-auth.guard.ts#ServiceAuthGuard]
- Events: `identity.user_registered`, `identity.registration_duplicate_attempted`, `identity.password_changed`.

## Rules
- **S01.R-01** Registration MUST answer `202 {"status":"accepted"}` for a new and for an existing address, and MUST create no session. [proof: S01 AS-01, S01 AS-02] [code: packages/backend/libs/domains/identity/application/registration.service.ts#RegistrationService]
- **S01.R-02** The system MUST trim and lower-case an address before use; two simultaneous registrations for one address MUST create exactly one account. [proof: S01 AS-03] [code: packages/backend/libs/domains/identity/domain/password-policy.ts#normalizeEmail]
- **S01.R-03** Self-selected roles MUST be `USER` (default) or `SELLER`; `ADMIN`, `MODERATOR` and unknown body fields MUST give `400 validation_failed`. [proof: S01 AS-04] [code: packages/backend/libs/domains/identity/api/auth.dto.ts#RegisterDto]
- **S01.R-04** A password MUST have 12 to 128 characters and MUST NOT equal the address; a breached password MUST give `422 weak_password` for new and existing addresses alike. [proof: S01 AS-05, S01 AS-06] [code: packages/backend/libs/domains/identity/domain/password-policy.ts#passwordProblem]
- **S01.R-05** When the breached-password check times out (800 ms) or fails, registration MUST proceed and increase `auth_breach_check_skipped_total`. [proof: S01 AS-07]
- **S01.R-06** Registration MUST compute exactly one password hash per request, for new and existing addresses. [proof: S01 AS-08]
- **S01.R-07** The 11th registration from one IP within an hour MUST give `429 rate_limited` with `Retry-After` and create nothing. [proof: S01 AS-09] [code: packages/backend/libs/domains/identity/domain/auth-rate-policies.ts#identityRatePolicies]
- **S01.R-08** Login with an unknown address or a wrong password MUST give the same `401 invalid_credentials` with one password verification. [proof: S01 AS-11] [code: packages/backend/libs/domains/identity/domain/errors.ts#Domain_InvalidCredentialsError]
- **S01.R-09** The 6th login for one address within 15 minutes MUST give `429`, even with the right password and for unregistered addresses alike; a successful login resets the counter. [proof: S01 AS-12, S01 AS-13]
- **S01.R-10** The 21st login request from one IP within a minute MUST give `429`; forwarding headers MUST NOT change the IP unless the peer is a trusted proxy. [proof: S01 AS-14, S01 AS-15]
- **S01.R-11** A stored bcrypt or outdated Argon2id hash MUST verify and MUST be replaced by a current Argon2id hash on the next successful login. [proof: S01 AS-16, S01 AS-17] [code: packages/backend/libs/domains/identity/infra/crypto/password-hasher.ts#PasswordHasher]
- **S01.R-12** Hash operations MUST be bounded by a concurrency limit and a queue limit; excess requests MUST be rejected with `503` and `Retry-After: 1`. [proof: S01 AS-18] [code: packages/backend/libs/domains/identity/domain/bounded-concurrency.ts#BoundedConcurrency]
- **S01.R-13** Every login MUST create a new session ID, and a password of more than 128 characters MUST give `400` before any hash computation. [proof: S01 AS-20, S01 AS-21]
- **S01.R-14** A user with an enrolled second factor MUST receive a challenge instead of a session. [proof: S01 AS-19]
- **S01.R-15** The system MUST reject tokens with `alg: none`, a forged algorithm, an unknown `kid`, a bad `typ`, or a time outside the 5 s tolerance, with one identical `401 invalid_token` body. [proof: S01 AS-23, S01 AS-24] [code: packages/backend/libs/domains/identity/domain/token-verifier.ts#verifyAccessToken]
- **S01.R-16** The principal MUST come from the token alone; identity headers such as `X-User-Id` MUST NOT be trusted, and only `Authorization: Bearer` and the `__Host-access` cookie MUST carry credentials. [proof: S01 AS-25, S01 AS-26] [code: packages/backend/libs/domains/identity/api/guards/extract-auth-token.ts#extractAuthToken]
- **S01.R-17** A sensitive route MUST reject the token of a revoked session at once; an ordinary route MUST accept it until `exp` (300 s). [proof: S01 AS-27] [code: packages/backend/libs/domains/identity/api/guards/sensitive-session.guard.ts#SensitiveSessionGuard]
- **S01.R-18** A role change MUST take effect only at the next refresh. [proof: S01 AS-28]
- **S01.R-19** A protected route without credential MUST give `401`, and authentication and throttling MUST run before body validation. [proof: S01 AS-29, S01 AS-30]
- **S01.R-20** A refresh MUST return a new token for the same session and spend the old one; presenting a spent token MUST revoke the session; exactly one of two simultaneous exchanges MUST succeed. [proof: S01 AS-31, S01 AS-32, S01 AS-33] [code: packages/backend/libs/domains/identity/application/refresh.service.ts#RefreshService]
- **S01.R-21** Unknown, expired, revoked and deleted-user refresh failures MUST give the same `401 invalid_refresh_token`; an overlong value (above 256 characters) MUST give `400`. [proof: S01 AS-34, S01 AS-35, S01 AS-37]
- **S01.R-22** A refresh token MUST expire 30 days after issue, and a session MUST end 90 days after creation. [proof: S01 AS-35, S01 AS-36] [code: packages/backend/libs/domains/identity/domain/session-policy.ts#refreshExpiry]
- **S01.R-23** The 61st refresh request from one IP within a minute MUST give `429` and MUST NOT consume the token. [proof: S01 AS-38]
- **S01.R-24** Responses that carry credentials MUST send `Cache-Control: no-store`. [proof: S01 AS-57]
- **S01.R-25** `GET /auth/sessions` MUST list only the caller's active sessions, newest first, as `{sessionId, device, ip, createdAt, lastUsedAt, current}` and nothing else; another user's session ID MUST answer exactly like an unknown one (`404 session_not_found`). [proof: S01 AS-39, S01 AS-40] [code: packages/backend/libs/domains/identity/api/sessions.controller.ts#SessionsController]
- **S01.R-26** Revoking a session, logging out and logging out everywhere MUST be durable and idempotent: logout twice gives `204` twice and keeps the first revocation time and reason; `logout-all` answers `{revokedSessions}` and only touches the caller's sessions. [proof: S01 AS-41, S01 AS-42, S01 AS-43] [code: packages/backend/libs/domains/identity/application/session-revocation.service.ts#SessionRevocationService]
- **S01.R-27** A user MUST have at most 20 active sessions; the 21st login revokes the oldest with reason `session_limit`. `SessionRevocationService.revokeAllForUser` MUST return the number revoked, record the reason and end the refresh tokens. [proof: S01 AS-44, S01 AS-45] [code: packages/backend/libs/domains/identity/application/session-issuer.service.ts#SessionIssuer]
- **S01.R-28** Login with `delivery: "cookie"` MUST put no token in the body and set `__Host-access`, `__Host-refresh` (HttpOnly) and `__Host-csrf` (readable), all `Secure; SameSite=Lax; Path=/` without `Domain`. [proof: S01 AS-46] [code: packages/backend/libs/domains/identity/api/credential-cookies.ts#CredentialCookies]
- **S01.R-29** A state-changing request authenticated by the access cookie MUST carry an `X-CSRF-Token` equal to the `__Host-csrf` cookie and issued for its own session, else `403 csrf_invalid`; a `Bearer` request is exempt. The token is a random part plus a keyed MAC over the session ID, compared in constant time. [proof: S01 AS-47, S01 AS-48, S01 AS-49, S01 AS-53] [code: packages/backend/libs/domains/identity/domain/csrf-token.ts#verifyCsrfToken]
- **S01.R-30** Cookie-authenticated state changes and cookie-delivery logins MUST come from an allowed `Origin` (or, without `Origin`, not from `Sec-Fetch-Site: cross-site`), else `403 origin_not_allowed` before anything is created. Credential endpoints MUST accept only `application/json` bodies (`415 unsupported_media_type`) and `GET` MUST NOT change state. [proof: S01 AS-50, S01 AS-51, S01 AS-52, S01 AS-56] [code: packages/backend/libs/domains/identity/api/guards/cookie-request.ts#assertCookieRequestAllowed]
- **S01.R-31** Cookie-mode refresh MUST need no body token, rotate all three cookies and return no token; a request refused by the CSRF check MUST NOT consume the refresh token. Cookie-mode logout MUST clear all three cookies. [proof: S01 AS-54, S01 AS-55] [code: packages/backend/libs/domains/identity/api/guards/csrf.guard.ts#CsrfGuard]
- **S01.R-32** The JWKS MUST list the public parts of every NEXT, ACTIVE and RETIRED key (ES256 only, no private member) with `Cache-Control: public, max-age=300, stale-while-revalidate=3600` and an `ETag` that answers `304`; a stock verifier configured only from it MUST verify access tokens. [proof: S01 AS-58, S01 AS-59] [code: packages/backend/libs/domains/identity/api/well-known.controller.ts#WellKnownController]
- **S01.R-33** Exactly one ACTIVE signing key MUST exist, also when ten first uses race on an empty store. [proof: S01 AS-60] [code: packages/backend/libs/domains/identity/infra/keys/key-store.service.ts#KeyStore]
- **S01.R-34** The rotation job MUST promote a NEXT key once it has been published 24 h and the ACTIVE key is 7 days old, keep a NEXT key available, and purge a RETIRED key 24 h after retirement; tokens of a retired key verify until then. Concurrent and repeated runs MUST leave one ACTIVE and one NEXT key and change nothing on the last run. [proof: S01 AS-61, S01 AS-62, S01 AS-63, S01 AS-64] [code: packages/backend/libs/domains/identity/domain/key-rotation-policy.ts#decideRotation]
- **S01.R-35** An unknown `kid` MUST cause at most one forced reload of the key set per 30 s. [proof: S01 AS-65] [code: packages/backend/libs/domains/identity/domain/key-cache-policy.ts#KeyCachePolicy]
- **S01.R-36** A signing key's private part MUST be stored sealed and bound to its `kid`; `SecretBox` MUST detect tampering, a wrong context and a wrong master key, open values sealed with the previous master key, and refuse to start in production without a master key. [proof: S01 AS-66, S01 AS-67] [code: packages/backend/libs/domains/identity/infra/crypto/secret-box.ts#SecretBox]
- **S01.R-37** `ServiceTokenService.mint` MUST issue `svc+jwt` ES256 tokens of 60 s (maximum 300 s) with `sub: svc:<caller>` and no role, session or address, only for a configured audience; a minted token MUST be reused until 80 % of its lifetime. [proof: S01 AS-68, S01 AS-71, S01 AS-72] [code: packages/backend/libs/domains/identity/application/service-token.service.ts#ServiceTokenService]
- **S01.R-38** An internal endpoint guarded by `ServiceAuthGuard` MUST give `401` for a missing, expired, wrong-audience or user token and `403 service_caller_not_allowed` for a valid token of a caller outside its `@AllowedCallers`; `exchange` MUST turn a live user token into a token that names the user and the caller, and refuse a revoked session. [proof: S01 AS-69, S01 AS-70] [code: packages/backend/libs/domains/identity/api/guards/service-auth.guard.ts#ServiceAuthGuard]
- **S01.R-39** A password-reset request MUST answer `202` alike for an existing, a passwordless and an unknown address, send one message only for an existing address with a password, invalidate older links, and keep the raw token out of every table, outbox row and log. [proof: S01 AS-73, S01 AS-74] [code: packages/backend/libs/domains/identity/application/password-reset.service.ts#PasswordResetService]
- **S01.R-40** Confirming a reset MUST replace the password, revoke every session with reason `password_reset` and record `identity.password_changed`; an unknown, spent or expired token MUST give the same `400 invalid_reset_token`, a weak password `422` that keeps the token, and two simultaneous confirms MUST have one winner. [proof: S01 AS-75, S01 AS-76, S01 AS-77] [code: packages/backend/libs/domains/identity/application/password-reset.service.ts#PasswordResetService]
- **S01.R-41** Reset requests MUST be limited to 5 per hour per IP and 3 per hour per address (known or not), and confirmations to 10 per hour per IP, with `429` and `Retry-After`. [proof: S01 AS-78] [code: packages/backend/libs/domains/identity/domain/auth-rate-policies.ts#identityRatePolicies]
- **S01.R-42** Security events (login failure, session creation, revocation, refresh reuse, key rotation, reset request and completion, duplicate registration) MUST each write one audit line with the request ID and known IDs and never an address, password, token or hash, and MUST be counted in `auth_events_total` with the bounded labels `endpoint`, `result`, `reason`. [proof: S01 AS-82, S01 AS-83] [code: packages/backend/libs/domains/identity/application/audit.service.ts#AuditService]
- **S01.R-43** Every S01 error MUST be `application/problem+json` with its stable `code` and a `requestId` equal to the response header; an unreadable signing key MUST give a generic `500` and leave no usable session. [proof: S01 AS-84, S01 AS-85] [code: packages/backend/libs/domains/identity/domain/problem-catalog.ts#identityProblems]
- **S01.R-44** The operator job routes MUST answer `401` without a token and `403` for any role but `ADMIN`; they MUST return job DTOs without payload, map a tampered cursor to `400 validation_failed`, and mark mutations sensitive. [proof: none] [code: packages/backend/libs/domains/identity/api/jobs-admin.controller.ts#JobsAdminController]

## Behaviors
- **S01.B-01** Given no account, when `" New@Example.COM "` registers with a valid password, then the response is `202` with no tokens and one `USER` account exists as `new@example.com`. [proof: S01 AS-01]
- **S01.B-02** Given an existing account, when a registration repeats the address in another case, then the response is byte-identical to a new registration and the account is unchanged. [proof: S01 AS-02]
- **S01.B-03** Given two simultaneous registrations of one address, then both get `202` and one account and one event of each type exist. [proof: S01 AS-03]
- **S01.B-04** Given a registration with `role: ADMIN` or `isAdmin: true`, then the response is `400 validation_failed` naming the field. [proof: S01 AS-04]
- **S01.B-05** Given a breached password, when anyone registers, then the response is `422 weak_password` and nothing is stored. [proof: S01 AS-06]
- **S01.B-06** Given right credentials and no cookie delivery, when a user logs in, then the response is `200` with `accessToken.expiresIn` 300, a refresh token, a session ID and the user. [proof: S01 AS-10]
- **S01.B-07** Given 5 failed logins for an address from different IPs, when the 6th arrives with the right password, then the response is `429` with `Retry-After`. [proof: S01 AS-12]
- **S01.B-08** Given a user with a bcrypt hash, when they log in with the right password, then login succeeds and the hash becomes Argon2id. [proof: S01 AS-16]
- **S01.B-09** Given an enrolled second factor, when the right password arrives, then the response is `200 {mfaRequired:true, mfaToken}` and no session exists. [proof: S01 AS-19]
- **S01.B-10** Given a role changed from `USER` to `ADMIN`, when the user uses the old token, then the role is still `USER`; after a refresh it is `ADMIN`. [proof: S01 AS-28]
- **S01.B-11** Given refresh token T1 exchanged for T2, when T1 is presented again, then the response is `401`, the session is revoked and T2 stops working. [proof: S01 AS-32]
- **S01.B-12** Given a session refreshed at day 29, 58 and 87, when a refresh arrives at day 90 plus 1 s, then the response is `401`. [proof: S01 AS-36]
- **S01.B-13** Given a refresh token whose user was soft-deleted, when it is presented, then the response is `401 invalid_refresh_token` and the session is revoked. [proof: S01 AS-37]
- **S01.B-14** Given a logged-out session with an unexpired access token, when it calls a sensitive route, then the response is `401`; an ordinary route still accepts it until `exp`. [proof: S01 AS-27]
- **S01.B-15** Given users A, B and a soft-deleted C, when `getUsersByIds([A, B, C, unknown])` runs, then the map holds only A and B without secret fields. [proof: S01 AS-79]
- **S01.B-16** Given `findByEmail(" A@Example.com ")`, then A's summary returns; an unknown address returns `null`. [proof: S01 AS-80]
- **S01.B-17** Given a stock-verifier request with `alg: none`, an unknown `kid` or an expired token on a protected route, then the three bodies are identical apart from `requestId`. [proof: S01 AS-24]
- **S01.B-18** Given a user with 3 active sessions and 1 revoked one, when they list sessions, then they see their 3 active ones newest first, one marked `current`, and no storage key or user ID. [proof: S01 AS-39]
- **S01.B-19** Given a user with 20 active sessions, when a 21st login succeeds, then the oldest is revoked with reason `session_limit` and its refresh token yields `401`. [proof: S01 AS-44]
- **S01.B-20** Given a cookie session, when it logs out without `X-CSRF-Token`, then the response is `403 csrf_invalid` and the session is still active; with the matching token it is `204` and the three cookies are cleared. [proof: S01 AS-47, S01 AS-55]
- **S01.B-21** Given a cookie login from `https://evil.example`, then the response is `403 origin_not_allowed`, sets no cookie and creates no session. [proof: S01 AS-51]
- **S01.B-22** Given a session with only the refresh and CSRF cookies, when it refreshes with a valid CSRF header, then it gets three new cookies and no token in the body; without the header the response is `403` and the refresh token still works afterwards. [proof: S01 AS-54]
- **S01.B-23** Given ACTIVE 7 days old and NEXT published 24 h ago, when the rotation job runs, then NEXT is ACTIVE, the former ACTIVE is RETIRED, a new NEXT exists, and a token of the former key still verifies. [proof: S01 AS-61]
- **S01.B-24** Given a RETIRED key retired 25 h ago, when the rotation job runs, then it leaves the store and the JWKS and its tokens yield `401`; at 23 h it stays. [proof: S01 AS-63]
- **S01.B-25** Given caller `worker` and audience `core`, when it presents a service token to an internal endpoint allowing `worker` and `billing`, then the response is `200` with principal `{kind:"service", caller:"worker"}`; a token from `projector` is `403 service_caller_not_allowed`. [proof: S01 AS-69]
- **S01.B-26** Given a user token with a live session, when `exchange` runs for caller `core` and audience `worker`, then the token has `sub` = user, `act.sub` = `svc:core` and the session ID; after the session is revoked the exchange throws. [proof: S01 AS-70]
- **S01.B-27** Given a user who requested a reset, when they confirm with the e-mailed token and a strong password, then the password changes, all their sessions end and the same token yields `400`. [proof: S01 AS-75, S01 AS-76]
- **S01.B-28** Given a full register, login, refresh, logout and reset flow with log capture, then no log line holds the password, a token, a CSRF value or a hash. [proof: S01 AS-83]

## Lifecycles
No model is listed for this capability. Statuses are not stored in a documented model.
- Session: active, then revoked with a reason (`logout`, `logout_all`, `revoked`, `refresh_token_reuse`, `session_limit`, `password_reset`, `admin_ban`). Users, the refresh service, the session cap and other domains move it.
- Signing key: NEXT, then ACTIVE, then RETIRED, then purged; the rotation job moves it (S01.R-34).

## Owns
- Table/model: `User`; also `FederatedIdentity` and `SigningKey` by ownership rule (only `User` is listed in the facts).
- Events: `identity.user_registered`, `identity.registration_duplicate_attempted`, `identity.password_changed`, plus the MFA and federated-identity events used by {{cap:S02}}.
- Rate policies: `auth.register.ip`, `auth.login.ip`, `auth.login.account`, `auth.refresh.ip`, `auth.reset.ip`, `auth.reset.account` and `auth.reset.confirm.ip` ({{concept:rate-limit-policy}}).
- Cookies: `__Host-access`, `__Host-refresh`, `__Host-csrf` (plus the challenge and flow cookies of {{cap:S02}}).
- Jobs: `auth.rotate-signing-keys`, `auth.purge-reset-tokens`. Table `PasswordResetToken`. Metric `auth_events_total`.
- Configuration: master key for secret sealing (`AUTH_KEK`, and `AUTH_KEK_PREVIOUS` while it rotates), trusted proxies, service-token audience allowlist (`SERVICE_TOKEN_AUDIENCES`) and this app's service audience (`SERVICE_AUDIENCE`), front-end origin allowlist. The CSRF MAC key is derived from `JWT_SECRET`.
- Migration: `packages/backend/migrations/20261010090000-identity-s01-expand.js`.

## Decisions
- Registration answers alike for new and existing addresses, and does equal hashing work, so neither the response nor the latency reveals membership.
- Access tokens live 300 s and carry no personal data; revocation is instant only on sensitive routes, which bounds staleness at 300 s.
- Refresh tokens are one-use with no grace period, so a stolen and replayed token revokes the session; clients that refresh in parallel must serialize.
- The breached-password check fails open with a counter, so an outage of the corpus does not block registration.
- Throttle policies are fail-closed, and the per-address counter uses the submitted address whether or not it exists.
- Other domains reach users only through DTO services; identity owns `User`, `FederatedIdentity` and `SigningKey`.
- Errors use {{concept:problem-json-errors}} with stable codes.
- Cookie sessions are opt-in and protected twice: a CSRF token bound to the session, and an origin check; bearer clients carry no ambient credential and need neither.
- Password-reset mail goes straight to the mail channel after commit (a port that notifications binds), not through the outbox, because the raw token must be in no table; a lost mail is recovered by requesting again.
- Key rotation is a pure decision (`decideRotation`) applied until it has nothing left to do, so every run is idempotent and a fresh environment ends with one ACTIVE and one NEXT key.

## Known gaps
- AS-81 (ownership and boundary gates) is a static gate, not a test: `pnpm check:table-ownership --strict` reports no identity-side access to another domain's table, but still lists seven accesses by other domains to identity tables (chat ×4, notifications, payments, tenancy test kit); `UserModel`, `FederatedIdentityModel`, `SigningKeyModel`, `KeyStore`, `OidcService` and `UserRawDto` stay exported until those owners move.
- AS-86 (browser journey) belongs to W01 and is not verified here. The performance and edge criteria (SC-001, SC-005, SC-006, SC-008) are in `specs/UNVERIFIED.md`.
- The operator job routes (R-44) have tests (`auth-jobs-admin.e2e-spec.ts`, ids `OPS-01` to `OPS-07`) but no scenario id a proof can name.
- The CSRF MAC key is `JWT_SECRET`-derived (domain-separated by the `csrf:` prefix), not a dedicated `AUTH_CSRF_SECRET`.
- `auth.e2e-spec.ts` (legacy catch-all, 9 tests, green) is kept: deleting a test file trips the test-integrity gate (see `questions.md`).