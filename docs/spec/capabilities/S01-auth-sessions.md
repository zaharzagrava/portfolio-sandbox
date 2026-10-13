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
- `POST /auth/logout` and `POST /auth/logout-all` — revoke the current session or all sessions of the caller.
- `GET /auth/sessions` and `DELETE /auth/sessions/:sessionId` — list the caller's active sessions; revoke one of them.
- `GET /auth/me` — returns the signed-in user.
- `POST /auth/password-reset/request` and `POST /auth/password-reset/confirm` — password reset by single-use token.
- `GET /.well-known/jwks.json` — public key set, served outside the `/api` prefix without credential. The facts list no controller file for this route.
- Scheduled key-rotation job. [code: packages/backend/libs/domains/identity/infra/keys/key-rotation.jobs.ts#KeyRotationJobs]
- Exported services for other domains: `UserDirectoryService`, `SessionRevocationService`, `ServiceTokenService`, `SecretBox`. [code: packages/backend/libs/domains/identity/application/user-directory.service.ts#UserDirectoryService]
- Events: `identity.user_registered`, `identity.registration_duplicate_attempted`, `identity.password_changed`.

## Rules
- **S01.R-01** Registration MUST answer [`202 {"status":"accepted"}` ↗](../sw-external-terms.md#http-202-accepted) for a new and for an existing address, and MUST create no [session](../terms/session-lifetime.md). [proof: S01 AS-01, S01 AS-02] [code: packages/backend/libs/domains/identity/application/registration.service.ts#RegistrationService]
- **S01.R-02** The system MUST trim and lower-case an address before use; [two simultaneous registrations for one address MUST create exactly one account ↗](../sw-external-terms.md#race-condition). [proof: S01 AS-03] [code: packages/backend/libs/domains/identity/domain/password-policy.ts#normalizeEmail]
- **S01.R-03** Self-selected roles MUST be [`USER`](../terms/shop-role.md) (default) or `SELLER`; `ADMIN`, `MODERATOR` and unknown body fields MUST give [`400 validation_failed`](../terms/validation-failed-error.md). [proof: S01 AS-04] [code: packages/backend/libs/domains/identity/api/auth.dto.ts#RegisterDto]
- **S01.R-04** A password MUST have 12 to 128 characters and MUST NOT equal the address; a [breached password](../terms/breached-password-check.md) MUST give [`422 weak_password`](../terms/weak-password.md) for new and existing addresses alike. [proof: S01 AS-05, S01 AS-06] [code: packages/backend/libs/domains/identity/domain/password-policy.ts#passwordProblem]
- **S01.R-05** When the [breached-password check](../terms/breached-password-check.md) times out (800 ms) or fails, registration MUST proceed and increase [`auth_breach_check_skipped_total`](../terms/auth-breach-check-skipped-total.md). [proof: S01 AS-07]
- **S01.R-06** Registration MUST compute exactly one [password hash](../terms/password-hash.md) per request, for new and existing addresses. [proof: S01 AS-08]
- **S01.R-07** The 11th registration from one IP within an hour MUST give [`429 rate_limited`](../terms/rate-limit.md) with [`Retry-After` ↗](../sw-external-terms.md#retry-after) and create nothing. [proof: S01 AS-09] [code: packages/backend/libs/domains/identity/domain/auth-rate-policies.ts#identityRatePolicies]
- **S01.R-08** Login with an unknown address or a wrong password MUST give the same [`401 invalid_credentials`](../terms/invalid-credentials.md) with one [password verification](../terms/password-hash.md). [proof: S01 AS-11] [code: packages/backend/libs/domains/identity/domain/errors.ts#Domain_InvalidCredentialsError]
- **S01.R-09** The 6th login for one address within 15 minutes MUST give `429`, even with the right password and for unregistered addresses alike; a successful login [resets the counter](../terms/login-throttle.md). [proof: S01 AS-12, S01 AS-13]
- **S01.R-10** The 21st login request from one IP within a minute MUST give `429`; [forwarding headers](../terms/forwarding-headers.md) MUST NOT change the IP unless the peer is a [trusted proxy](../terms/trusted-proxy.md). [proof: S01 AS-14, S01 AS-15]
- **S01.R-11** A stored [bcrypt ↗](../sw-external-terms.md#bcrypt) or outdated [Argon2id ↗](../sw-external-terms.md#argon2id) hash MUST verify and MUST be replaced by a current Argon2id hash on the next successful login. [proof: S01 AS-16, S01 AS-17] [code: packages/backend/libs/domains/identity/infra/crypto/password-hasher.ts#PasswordHasher]
- **S01.R-12** Hash operations MUST be bounded by a [concurrency limit](../terms/concurrency-limit.md) and a [queue limit](../terms/hash-queue-limit.md); excess requests MUST be rejected with `503` and [`Retry-After: 1` ↗](../sw-external-terms.md#retry-after). [proof: S01 AS-18] [code: packages/backend/libs/domains/identity/domain/bounded-concurrency.ts#BoundedConcurrency]
- **S01.R-13** Every login MUST create a new [session ID](../terms/session-lifetime.md), and a password of more than 128 characters MUST give `400` before any hash computation. [proof: S01 AS-20, S01 AS-21]
- **S01.R-14** A user with an [enrolled second factor ↗](../sw-external-terms.md#mfa-step-up) MUST receive a [challenge](../terms/mfa-challenge.md) instead of a session. [proof: S01 AS-19]
- **S01.R-15** The system MUST reject tokens with [`alg: none` ↗](../sw-external-terms.md#jwt-alg), a forged algorithm, an unknown [`kid` ↗](../sw-external-terms.md#jwt-kid), a bad [`typ` ↗](../sw-external-terms.md#jwt-typ), or a time outside the [5 s tolerance](../terms/clock-skew-tolerance.md), with one identical [`401 invalid_token`](../terms/invalid-token-error.md) body. [proof: S01 AS-23, S01 AS-24] [code: packages/backend/libs/domains/identity/domain/token-verifier.ts#verifyAccessToken]
- **S01.R-16** The [principal](../terms/principal.md) MUST come from the token alone; [identity headers](../terms/identity-headers.md) such as [`X-User-Id`](../terms/x-user-id-header.md) MUST NOT be trusted, and only [`Authorization: Bearer` ↗](../sw-external-terms.md#authorization-bearer) and the [`__Host-access` cookie](../terms/host-access-cookie.md) MUST carry credentials. [proof: S01 AS-25, S01 AS-26] [code: packages/backend/libs/domains/identity/api/guards/extract-auth-token.ts#extractAuthToken]
- **S01.R-17** A [sensitive route](../terms/sensitive-route.md) MUST reject the token of a [revoked session](../terms/session-revocation.md) at once; an [ordinary route](../terms/sensitive-route.md) MUST accept it until [`exp` ↗](../sw-external-terms.md#jwt-exp) (300 s). [proof: S01 AS-27] [code: packages/backend/libs/domains/identity/api/guards/sensitive-session.guard.ts#SensitiveSessionGuard]
- **S01.R-18** A [role change](../terms/shop-role.md) MUST take effect only at the [next refresh](../terms/token-refresh.md). [proof: S01 AS-28]
- **S01.R-19** A protected route without credential MUST give `401`, and authentication and [throttling](../terms/rate-limit.md) MUST run before body validation. [proof: S01 AS-29, S01 AS-30]
- **S01.R-20** A refresh MUST return a new token for the same session and [spend the old one](../terms/refresh-token-rotation.md); presenting a [spent token](../terms/refresh-token-rotation.md) MUST [revoke the session](../terms/session-revocation.md); exactly one of two [simultaneous exchanges ↗](../sw-external-terms.md#race-condition) MUST succeed. [proof: S01 AS-31, S01 AS-32, S01 AS-33] [code: packages/backend/libs/domains/identity/application/refresh.service.ts#RefreshService]
- **S01.R-21** Unknown, expired, revoked and deleted-user [refresh failures](../terms/token-refresh.md) MUST give the same [`401 invalid_refresh_token`](../terms/invalid-refresh-token-error.md); an [overlong value](../terms/oversized-refresh-token.md) (above 256 characters) MUST give `400`. [proof: S01 AS-34, S01 AS-35, S01 AS-37]
- **S01.R-22** A [refresh token](../terms/token-refresh.md) MUST expire 30 days after issue, and a [session](../terms/session-lifetime.md) MUST end 90 days after creation. [proof: S01 AS-35, S01 AS-36] [code: packages/backend/libs/domains/identity/domain/session-policy.ts#refreshExpiry]
- **S01.R-23** The 61st refresh request from one IP within a minute MUST give `[429 ↗](../sw-external-terms.md#http-429-too-many-requests)` and MUST NOT [consume the token](../terms/refresh-token-rotation.md). [proof: S01 AS-38]
- **S01.R-24** Responses that carry credentials MUST send [`Cache-Control: no-store` ↗](../sw-external-terms.md#cache-control-no-store). [proof: S01 AS-57]

## Behaviors
- **S01.B-01** Given no account, when `" New@Example.COM "` registers with a valid password, then the response is `202` with no tokens and one [`USER` account](../terms/shop-role.md) exists as `new@example.com`. [proof: S01 AS-01]
- **S01.B-02** Given an existing account, when a registration repeats the address in another case, then the response is [byte-identical](../terms/identical-registration-response.md) to a new registration and the account is unchanged. [proof: S01 AS-02]
- **S01.B-03** Given two simultaneous registrations of one address, then both get `202` and one account and [one event of each type](../terms/event-row.md) exist. [proof: S01 AS-03]
- **S01.B-04** Given a registration with `role: ADMIN` or `isAdmin: true`, then the response is [`400 validation_failed`](../terms/validation-failed-error.md) naming the field. [proof: S01 AS-04]
- **S01.B-05** Given a [breached password](../terms/breached-password.md), when anyone registers, then the response is [`422 weak_password`](../terms/weak-password.md) and nothing is stored. [proof: S01 AS-06]
- **S01.B-06** Given right credentials and no [cookie delivery](../terms/session-cookie.md), when a user logs in, then the response is `200` with [`accessToken.expiresIn`](../terms/access-token.md) 300, a refresh token, [a session ID](../terms/session-lifetime.md) and the user. [proof: S01 AS-10]
- **S01.B-07** Given 5 failed logins for an address from different IPs, when the 6th arrives with the right password, then the response is `429` with [`Retry-After` ↗](../sw-external-terms.md#retry-after). [proof: S01 AS-12]
- **S01.B-08** Given a user with a [bcrypt hash ↗](../sw-external-terms.md#bcrypt), when they log in with the right password, then login succeeds and the hash becomes [Argon2id ↗](../sw-external-terms.md#argon2id). [proof: S01 AS-16]
- **S01.B-09** Given an enrolled [second factor ↗](../sw-external-terms.md#mfa), when the right password arrives, then the response is `200 {mfaRequired:true, [mfaToken](../terms/mfa-challenge-token.md)}` and [no session exists](../terms/session-lifetime.md). [proof: S01 AS-19]
- **S01.B-10** Given a role changed from `USER` to `ADMIN`, when the user uses [the old token](../terms/access-token.md), then the role is still `USER`; after [a refresh](../terms/token-refresh.md) it is `ADMIN`. [proof: S01 AS-28]
- **S01.B-11** Given refresh token T1 exchanged for T2, when T1 is presented again, then the response is `401`, [the session is revoked](../terms/session-revocation.md) and T2 stops working. [proof: S01 AS-32]
- **S01.B-12** Given a [session refreshed at day 29, 58 and 87](../terms/session-lifetime.md), when a refresh arrives at day 90 plus 1 s, then the response is `401`. [proof: S01 AS-36]
- **S01.B-13** Given a refresh token whose user was [soft-deleted](../terms/soft-delete.md), when it is presented, then the response is [`401 invalid_refresh_token`](../terms/invalid-refresh-token-error.md) and the session is revoked. [proof: S01 AS-37]
- **S01.B-14** Given a logged-out session with an unexpired access token, when it calls a [sensitive route](../terms/sensitive-route.md), then the response is `401`; an ordinary route still accepts it until [`exp` ↗](../sw-external-terms.md#jwt-exp). [proof: S01 AS-27]
- **S01.B-15** Given users A, B and a soft-deleted C, when [`getUsersByIds([A, B, C, unknown])`](../terms/get-users-by-ids.md) runs, then the map holds only A and B without [secret fields](../terms/secret-fields.md). [proof: S01 AS-79]
- **S01.B-16** Given [`findByEmail(" A@Example.com ")`](../terms/find-by-email.md), then A's [summary](../terms/user-summary.md) returns; an unknown address returns `null`. [proof: S01 AS-80]
- **S01.B-17** Given a [stock-verifier](../terms/stock-verifier.md) request with [`alg: none` ↗](../sw-external-terms.md#jwt-alg), an unknown [`kid` ↗](../sw-external-terms.md#jwt-kid) or an expired token on a [protected route](../terms/protected-route.md), then the three bodies are identical apart from [`requestId`](../terms/request-id.md). [proof: S01 AS-24]

## Lifecycles
No model is listed for this capability. Statuses are not stored in a documented model.
- Session: active, then revoked with a reason (`logout`, `refresh_token_reuse`, `session_limit`, `password_reset`, `admin_ban`). Users, the refresh service and other domains move it.
- Signing key: NEXT, then ACTIVE, then RETIRED, then purged; the rotation job moves it. Rotation tests (AS-61 to AS-64) are not in the proof list.

## Owns
- Table/model: `User`; also `FederatedIdentity` and `SigningKey` by ownership rule (only `User` is listed in the facts).
- Events: `identity.user_registered`, `identity.registration_duplicate_attempted`, `identity.password_changed`, plus the MFA and federated-identity events used by {{cap:S02}}.
- Rate policies: `auth.register.ip`, `auth.login.ip`, `auth.login.account`, `auth.refresh.ip`, `auth.reset.ip`, `auth.reset.account` ({{concept:rate-limit-policy}}).
- Cookies: `__Host-access`, `__Host-refresh`, `__Host-csrf`.
- Configuration: master key for secret sealing, trusted proxies, audience allowlist, front-end origin allowlist.
- Migration: `packages/backend/migrations/20261010090000-identity-s01-expand.js`.

## Decisions
- Registration answers alike for new and existing addresses, and does equal hashing work, so neither the response nor the latency reveals membership.
- Access tokens live 300 s and carry no personal data; revocation is instant only on sensitive routes, which bounds staleness at 300 s.
- Refresh tokens are one-use with no grace period, so a stolen and replayed token revokes the session; clients that refresh in parallel must serialize.
- The breached-password check fails open with a counter, so an outage of the corpus does not block registration.
- Throttle policies are fail-closed, and the per-address counter uses the submitted address whether or not it exists.
- Other domains reach users only through DTO services; identity owns `User`, `FederatedIdentity` and `SigningKey`.
- Errors use {{concept:problem-json-errors}} with stable codes.

## Known gaps
- No test carries a scenario id for AS-39 to AS-56 (sessions list, logout, cookie delivery, CSRF, origin check, media type) and AS-58 to AS-64, AS-66 to AS-78, AS-81 to AS-86. Their behavior is not tied to a test in this page. AS-22, AS-65 are covered by unit tests but no rule here depends on them beyond R-07.
- Not proven: session limit of 20 (AS-44), `revokeAllForUser` (AS-45), CSRF and origin checks, cookie delivery, JWKS content and cache, key rotation and purge, `SecretBox`, service tokens, password reset and its throttles.
- AS-30 and AS-29 are described in R-19, but AS-29 has no test in the list that includes AS-30 coverage by id beyond `auth-tokens.e2e-spec.ts`; the proof is accepted from that file.
- The JWKS route has no controller in the listed files, so its code location is unverified.
- Audit logging and log redaction (AS-82, AS-83) have no test.
- Rotation tests, the P1 AS-22 policy table limits and AS-86 (browser journey, owned by W01) are not verified here.