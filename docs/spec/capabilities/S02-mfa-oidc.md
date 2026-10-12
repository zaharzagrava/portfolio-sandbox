---
id: S02
title: TOTP MFA with recovery codes, Google OIDC login (PKCE), account linking
kind: capability
status: draft
generated_at: e95ce81
depends_on: [S01, S03, S50, S53, S54]
concepts: [access-token-session, rate-limit-policy, outbox-task-queue, problem-json-errors, transaction-runner]
models: []
scope:
  - packages/backend/libs/domains/identity/**
---
# S02 - TOTP MFA with recovery codes, Google OIDC login (PKCE), account linking
## Purpose
Account holders need a second factor on top of the password, and a way to sign in with Google without a password. This capability adds TOTP enrolment, single-use recovery codes, Google sign-in with Authorization Code and PKCE, and linking of Google identities to accounts. It also exposes a registry through which {{cap:S03}} supplies per-shop enterprise identity providers. Sessions are issued by {{cap:S01}}.

## Entry points
- `GET /auth/mfa`: shows the second-factor state (`none`, `pending`, `enabled`) of the signed-in user. [code: packages/backend/libs/domains/identity/api/mfa.controller.ts#MfaController]
- `POST /auth/mfa/enroll`: starts or restarts enrolment and returns the otpauth URI and manual key.
- `POST /auth/mfa/confirm`: proves a code, enables the factor and returns ten recovery codes once.
- `POST /auth/mfa/recovery-codes/regenerate`: replaces the recovery-code set; needs a current TOTP code.
- `POST /auth/mfa/disable`: removes the factor; needs a TOTP code or an unspent recovery code.
- `POST /auth/mfa/verify`: completes a login that returned a challenge, with a TOTP or recovery code, and issues the session.
- `GET /auth/oidc/providers`: lists the enabled static providers as `{id, displayName}`. [code: packages/backend/libs/domains/identity/api/oidc.controller.ts#OidcController]
- `POST /auth/oidc/:provider/start`: creates a flow and returns the provider `authorizationUrl`.
- `GET /auth/oidc/:provider/callback`: the provider's redirect target; it always answers with a `302`.
- `POST /auth/oidc/:provider/link/start`: starts a flow that links a Google identity to the signed-in user.
- `GET /auth/identities`: lists the caller's linked identities. [code: packages/backend/libs/domains/identity/api/identities.controller.ts#IdentitiesController]
- `DELETE /auth/identities/:identityId`: unlinks one identity of the caller.
- Registry `OidcProviderRegistry`: lets another domain register a resolver for a reserved provider prefix. [code: packages/backend/libs/domains/identity/application/oidc-provider-registry.ts#OidcProviderRegistry]

## Rules
- **S02.R-01** The second-factor state of a user MUST be exactly one of `none`, `pending`, `enabled`. [proof: S02 AS-06, S02 AS-09]
- **S02.R-02** Enrolling MUST NOT change an enabled factor: the call answers `409 mfa_already_enabled` and the secret, codes and state stay. [proof: S02 AS-03]
- **S02.R-03** Re-enrolling in state `pending` MUST replace the secret and set a new 15-minute expiry; a code from the old secret MUST NOT confirm. [proof: S02 AS-02]
- **S02.R-04** Confirm MUST be atomic: under two concurrent requests with the same code, one returns `200` and the other `409 mfa_not_pending`. [proof: S02 AS-07] [code: packages/backend/libs/domains/identity/application/second-factor.service.ts#SecondFactorService]
- **S02.R-05** Confirm MUST answer `409 mfa_not_pending` in states `none` and `enabled`, and after the 15-minute pending expiry. [proof: S02 AS-06]
- **S02.R-06** Every management endpoint MUST answer `401` without a credential and for a challenge token used as Bearer. [proof: S02 AS-08]
- **S02.R-07** Status responses MUST NOT contain a secret, URI, digest or code. [proof: S02 AS-09]
- **S02.R-08** A TOTP code MUST be accepted only for the current, previous or next 30-second step, and only for a step above the last accepted step. [proof: S02 AS-10] [code: packages/backend/libs/domains/identity/domain/totp.ts#verifyTotp]
- **S02.R-09** The accepted step MUST be stored durably, so a replayed code stays rejected after a cache flush and restart. [proof: S02 AS-14, S02 AS-24]
- **S02.R-10** A recovery code MUST have the form `XXXXX-XXXXX`; a set MUST hold 10 distinct codes; matching MUST ignore case, surrounding spaces and a missing hyphen. [proof: S02 AS-11, S02 AS-20] [code: packages/backend/libs/domains/identity/domain/recovery-code.ts#normaliseRecoveryCode]
- **S02.R-11** A recovery code MUST be spent once, even under concurrent requests. [proof: S02 AS-21]
- **S02.R-12** A challenge MUST be valid for 5 minutes, single-use, and burned after 3 wrong codes; every challenge defect MUST answer `401 invalid_mfa_challenge`. [proof: S02 AS-14, S02 AS-16, S02 AS-19]
- **S02.R-13** Wrong codes of any kind MUST return the same `401 invalid_mfa_code` body at login. [proof: S02 AS-16]
- **S02.R-14** After 5 wrong codes in 15 minutes for one user, across all endpoints, the next attempt MUST return `429 rate_limited` with `Retry-After`, even with a correct code. [proof: S02 AS-17]
- **S02.R-15** The verify endpoint MUST allow 20 requests per minute per IP; throttling MUST run before body validation. [proof: S02 AS-18]
- **S02.R-16** A password reset MUST NOT change the second-factor state. [proof: S02 AS-22]
- **S02.R-17** The OIDC start MUST answer `404 oidc_provider_not_found` for an unknown, malformed or unconfigured provider, and `403 origin_not_allowed` for a foreign `Origin`. [proof: S02 AS-30]
- **S02.R-18** Every callback response MUST be a `302` to the front-end origin with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`, and MUST NOT contain a token, code, state or e-mail. [proof: S02 AS-33]
- **S02.R-19** The callback MUST reject a missing, unknown, expired (over 10 minutes), replayed or browser-unbound `state`; a concurrent duplicate callback MUST yield one winner. [proof: S02 AS-37, S02 AS-38] [code: packages/backend/libs/domains/identity/application/oidc-callback.service.ts#OidcCallbackService]
- **S02.R-20** A return path MUST be a relative path starting with exactly one `/`; protocol-relative, backslash, scheme and control-character values MUST be refused. [proof: S02 AS-34] [code: packages/backend/libs/domains/identity/domain/return-path.ts#parseReturnPath]
- **S02.R-21** The system MUST link by e-mail only when the provider reports `email_verified` as the boolean `true`; otherwise the callback ends with `email_not_verified`. [proof: S02 AS-36, S02 AS-43]
- **S02.R-22** A login for a known `(provider, subject)` MUST sign in the linked user, whatever e-mail the provider now reports. [proof: S02 AS-32]
- **S02.R-23** One account MUST hold at most one identity per provider, and the store MUST enforce it. [proof: S02 AS-46, S02 AS-53]
- **S02.R-24** Unlinking MUST be scoped to the caller; another user's or unknown identity answers the same `404 identity_not_found`. [proof: S02 AS-52]

## Behaviors
- **S02.B-01** Given state `none`, when the user calls enrol, then the answer is `200` with `otpauthUri` and `manualEntryKey`, with `Cache-Control: no-store`. [proof: S02 AS-01]
- **S02.B-02** Given state `pending` and a current code, when the user confirms, then the factor becomes `enabled` and ten recovery codes are returned once. [proof: S02 AS-04]
- **S02.B-03** Given a malformed confirm body (5 or 7 digits, letters, extra field), when sent, then `400 validation_failed` and nothing changes. [proof: S02 AS-05]
- **S02.B-04** Given an enabled user who logs in with a password, when the login returns a challenge and the user sends the current code to verify, then a session is issued with the S01 login body. [proof: S02 AS-12]
- **S02.B-05** Given cookie delivery and an allowed `Origin`, when verify succeeds, then three cookies are set and no token is in the body; with `Origin: https://evil.example` the answer is `403 origin_not_allowed`. [proof: S02 AS-13]
- **S02.B-06** Given a code already accepted at step T, when a second login presents it, then `401 invalid_mfa_code`. [proof: S02 AS-14]
- **S02.B-07** Given a recovery code in any accepted form, when verified, then the session is issued with `amr` `["pwd","rcv","mfa"]` and the code is spent. [proof: S02 AS-20]
- **S02.B-08** Given a challenge that is expired, tampered, for another audience, or for a deleted user, when verified, then `401 invalid_mfa_challenge`. [proof: S02 AS-19]
- **S02.B-09** Given Google is configured, when a visitor calls start with `returnTo`, then the answer carries an `authorizationUrl` with PKCE and a flow cookie. [proof: S02 AS-29]
- **S02.B-10** Given a valid flow and a verified ID token for an unknown subject and e-mail, when the callback runs, then a new user is created and signed in. [proof: S02 AS-31]
- **S02.B-11** Given an ID token with a wrong `nonce`, wrong `aud`, different `iss`, expired `exp`, bad signature, `alg: none` or `alg: HS256`, when the callback runs, then the login fails with a closed error code and no session. [proof: S02 AS-35]
- **S02.B-12** Given the provider returns `access_denied`, when the callback runs, then the redirect is `/login?error=oidc_denied` and the provider text is not echoed. [proof: S02 AS-39]
- **S02.B-13** Given the token endpoint fails (`400`, `500`, non-JSON, no `id_token`, over 1 MB), when the callback runs, then `error=oidc_exchange_failed`. [proof: S02 AS-40]
- **S02.B-14** Given a token endpoint silent for 3 s, when the callback runs, then `error=oidc_provider_unavailable` within 10 s, with one token request and no retry. [proof: S02 AS-41]
- **S02.B-15** Given a password account never verified by a provider, when a Google login arrives with its verified e-mail, then the same user is signed in and linked. [proof: S02 AS-44]
- **S02.B-16** Given two concurrent first Google logins for one subject, when both complete, then one user and one link exist. [proof: S02 AS-45]
- **S02.B-17** Given a user linked to `g-1`, when a login arrives for `g-2` with the user's e-mail, then `error=link_conflict`. [proof: S02 AS-46]
- **S02.B-18** Given a soft-deleted linked user, when the callback completes, then `error=account_unavailable`. [proof: S02 AS-47]
- **S02.B-19** Given a signed-in user, when explicit linking completes, then the callback redirects with `?linked=google` and issues no new session. [proof: S02 AS-49, S02 AS-50]
- **S02.B-20** Given a user with two identities, when the user lists them, then only their own identities appear, newest first. [proof: S02 AS-51]

## Lifecycles
The second-factor state moves as follows. The user moves `none→pending` (enrol), `pending→pending` (re-enrol), `pending→enabled` (confirm) and `enabled→none` (disable). Account linking by e-mail also moves `enabled→none`. A pending enrolment expires after 15 minutes and reads as `none`.

## Owns
- Models: `SecondFactor`, `MfaRecoveryCode`, `MfaChallengeState`, `FederatedIdentity`.
- Events: `identity.mfa_enabled`, `identity.mfa_disabled`, `identity.mfa_recovery_code_used`, `identity.mfa_recovery_codes_regenerated`, `identity.federated_identity_linked`, `identity.federated_identity_unlinked`, and `identity.user_registered` for Google-created users.
- Cookies: `__Host-oidc-flow`, `__Host-mfa-challenge`.
- Rate-limit policies: `auth.mfa.ip`, `auth.oidc.ip`.
- Configuration: Google client settings, the redirect URI and the front-end origin, validated in `config-rules.ts`.

## Decisions
- An enabled factor cannot be reset by an access token alone, so a stolen token cannot remove the second factor.
- The replay guard is a durable conditional write, not a cache, so a flush or restart cannot reopen a spent code.
- The code kind is distinguished by form (6 digits or recovery shape), not by trying both.
- Callback failures redirect with a closed set of error codes, so provider text never reaches the user.
- The code exchange is never retried because it is not idempotent.
- No provider call happens inside a database transaction.
- Dynamic providers from {{cap:S03}} are trusted for the subject only and never link by e-mail.

## Known gaps
- AS-25 to AS-27 (regenerate and disable; step-up with a recovery code; concurrent disable) have no test with a scenario id.
- AS-54 and AS-55 (challenge cookie for federated logins) have no test with a scenario id.
- AS-56 to AS-58 (registry, subject-only providers, SSRF guard for shop issuers) have no test with a scenario id.
- AS-59 to AS-66 (audit lines, log secrecy, error schema, corrupted secret, ownership boundaries, event envelope, front-end flows) have no test with a scenario id.
- The rules for regeneration, disabling, the challenge cookie, the SSRF guard and the registry are therefore `[proof: none]` and absent from the Rules list.
- AS-42 (discovery with a mismatched issuer or non-https endpoints) is tested but not stated as its own rule.
- The Rules list does not include the unlink refusal `409 last_login_method`, because no listed test names it.
- Event emission (one event per change) has test evidence only inside AS-07 and AS-21 and is not stated as a rule.