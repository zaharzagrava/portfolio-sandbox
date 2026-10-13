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
- **S02.R-01** The [second-factor state](../terms/mfa-state.md) of a user MUST be exactly one of `none`, `pending`, `enabled`. [proof: S02 AS-06, S02 AS-09]
- **S02.R-02** [Enrolling](../terms/mfa-enrolment.md) MUST NOT change an enabled factor: the call answers `[409 mfa_already_enabled](../terms/mfa-already-enabled.md)` and the secret, codes and state stay. [proof: S02 AS-03]
- **S02.R-03** [Re-enrolling](../terms/mfa-enrolment.md) in state `pending` MUST replace the secret and set a new [15-minute expiry](../terms/mfa-pending-expiry.md); a code from the old secret MUST NOT confirm. [proof: S02 AS-02]
- **S02.R-04** [Confirm](../terms/mfa-confirm.md) MUST be [atomic ↗](../sw-external-terms.md#atomicity): under two concurrent requests with the same code, one returns `200` and the other `[409 mfa_not_pending](../terms/mfa-not-pending.md)`. [proof: S02 AS-07] [code: packages/backend/libs/domains/identity/application/second-factor.service.ts#SecondFactorService]
- **S02.R-05** [Confirm](../terms/mfa-confirm.md) MUST answer `[409 mfa_not_pending](../terms/mfa-not-pending.md)` in states `none` and `enabled`, and after the [15-minute pending expiry](../terms/mfa-pending-expiry.md). [proof: S02 AS-06]
- **S02.R-06** Every [management endpoint](../terms/mfa-management-endpoint.md) MUST answer `401` without a credential and for a [challenge token](../terms/mfa-challenge-token.md) used as [Bearer ↗](../sw-external-terms.md#authorization-bearer). [proof: S02 AS-08]
- **S02.R-07** Status responses MUST NOT contain a secret, URI, [digest](../terms/mfa-recovery-digest.md) or code. [proof: S02 AS-09]
- **S02.R-08** A [TOTP ↗](../sw-external-terms.md#totp) code MUST be accepted only for the current, previous or next [30-second step](../terms/totp-time-step.md), and only for a step above the last accepted step. [proof: S02 AS-10] [code: packages/backend/libs/domains/identity/domain/totp.ts#verifyTotp]
- **S02.R-09** The accepted step MUST be [stored durably](../terms/durable-conditional-write.md), so a [replayed code](../terms/totp-replay-protection.md) stays rejected after a cache flush and restart. [proof: S02 AS-14, S02 AS-24]
- **S02.R-10** A [recovery code](../terms/mfa-recovery-code.md) MUST have the form `XXXXX-XXXXX`; a set MUST hold 10 distinct codes; matching MUST ignore case, surrounding spaces and a missing hyphen. [proof: S02 AS-11, S02 AS-20] [code: packages/backend/libs/domains/identity/domain/recovery-code.ts#normaliseRecoveryCode]
- **S02.R-11** A [recovery code](../terms/mfa-recovery-code.md) MUST be [spent](../terms/mfa-recovery-code-spend.md) once, even under concurrent requests. [proof: S02 AS-21]
- **S02.R-12** A [challenge](../terms/mfa-challenge.md) MUST be valid for 5 minutes, single-use, and [burned](../terms/mfa-challenge.md) after 3 wrong codes; every challenge defect MUST answer [`401 invalid_mfa_challenge`](../terms/mfa-challenge.md). [proof: S02 AS-14, S02 AS-16, S02 AS-19]
- **S02.R-13** Wrong codes of any kind MUST return the same [`401 invalid_mfa_code`](../terms/invalid-mfa-code.md) body at login. [proof: S02 AS-16]
- **S02.R-14** After 5 wrong codes in 15 minutes for one user, across all endpoints, the next attempt MUST return [`429 rate_limited`](../terms/rate-limited.md) with [`Retry-After` ↗](../sw-external-terms.md#retry-after), even with a correct code. [proof: S02 AS-17]
- **S02.R-15** The [verify endpoint](../terms/mfa-verify-endpoint.md) MUST allow 20 requests per minute per IP; [throttling](../terms/request-throttle.md) MUST run before body validation. [proof: S02 AS-18]
- **S02.R-16** A password reset MUST NOT change the [second-factor state](../terms/mfa-state.md). [proof: S02 AS-22]
- **S02.R-17** The [OIDC start](../terms/oidc-start.md) MUST answer [`404 oidc_provider_not_found`](../terms/oidc-start.md) for an unknown, malformed or unconfigured provider, and [`403 origin_not_allowed`](../terms/origin-not-allowed.md) for a foreign [`Origin` ↗](../sw-external-terms.md#origin-header). [proof: S02 AS-30]
- **S02.R-18** Every [callback](../terms/oidc-callback.md) response MUST be a `302` to the [front-end origin](../terms/front-end-origin.md) with [`Cache-Control: no-store` ↗](../sw-external-terms.md#cache-control-no-store) and [`Referrer-Policy: no-referrer` ↗](../sw-external-terms.md#referrer-policy), and MUST NOT contain a token, code, state or e-mail. [proof: S02 AS-33]
- **S02.R-19** The callback MUST reject a missing, unknown, expired (over 10 minutes), [replayed](../terms/oidc-state.md) or [browser-unbound](../terms/oidc-flow-cookie.md) [`state`](../terms/oidc-state.md); a concurrent duplicate callback MUST yield [one winner](../terms/optimistic-concurrency.md). [proof: S02 AS-37, S02 AS-38] [code: packages/backend/libs/domains/identity/application/oidc-callback.service.ts#OidcCallbackService]
- **S02.R-20** A [return path](../terms/return-path.md) MUST be a relative path starting with exactly one `/`; [protocol-relative ↗](../sw-external-terms.md#protocol-relative-url), backslash, scheme and control-character values MUST be refused. [proof: S02 AS-34] [code: packages/backend/libs/domains/identity/domain/return-path.ts#parseReturnPath]
- **S02.R-21** The system MUST link by e-mail only when the provider reports [`email_verified`](../terms/email-verified.md) as the boolean `true`; otherwise the [callback](../terms/oauth-callback.md) ends with [`email_not_verified`](../terms/email-not-verified.md). [proof: S02 AS-36, S02 AS-43]
- **S02.R-22** A login for a known [`(provider, subject)`](../terms/provider-subject.md) MUST sign in the linked user, whatever e-mail the provider now reports. [proof: S02 AS-32]
- **S02.R-23** One account MUST hold at most one [identity](../terms/identity-link.md) per provider, and the [store](../terms/identity-store.md) MUST enforce it. [proof: S02 AS-46, S02 AS-53]
- **S02.R-24** [Unlinking](../terms/identity-link.md) MUST be [scoped to the caller](../terms/caller-scoping.md); another user's or unknown identity answers the same [`404 identity_not_found`](../terms/identity-not-found.md). [proof: S02 AS-52]
- **S02.R-25** Regenerating [recovery codes](../terms/mfa-recovery-code.md) MUST need [state `enabled`](../terms/mfa-state.md) and a current [TOTP ↗](../sw-external-terms.md#totp) code, never a recovery code, and MUST replace the whole set in one [transaction ↗](../sw-external-terms.md#database-transaction). [proof: S02 AS-25, S02 AS-27] [code: packages/backend/libs/domains/identity/application/second-factor.service.ts#SecondFactorService]
- **S02.R-26** Disabling MUST need state `enabled` and a current TOTP code or an [unspent recovery code](../terms/mfa-recovery-code-spend.md), and MUST delete the [secret](../terms/second-factor-model.md) and all codes. [proof: S02 AS-26]
- **S02.R-27** Of two [concurrent disables ↗](../sw-external-terms.md#race-condition) with one code, one MUST answer `204` and the other [`409 mfa_not_enabled`](../terms/mfa-not-enabled.md), and exactly one [`identity.mfa_disabled` event](../terms/mfa-disabled-event.md) MUST exist. [proof: S02 AS-27]
- **S02.R-28** A Google login of a user whose factor is `enabled` MUST NOT [issue a session](../terms/session-lifetime.md); it MUST set [`__Host-mfa-challenge`](../terms/mfa-challenge.md) and redirect to [`/login/mfa?returnTo=<path>`](../terms/login-mfa-page.md). [proof: S02 AS-54] [code: packages/backend/libs/domains/identity/application/oidc-callback.service.ts#OidcCallbackService]
- **S02.R-29** Verify with the [challenge cookie](../terms/mfa-challenge.md) MUST refuse a [foreign `Origin`](../terms/origin-allow-list.md) with `403` before touching the challenge, and the cookie MUST be cleared once the challenge is [spent or burned](../terms/mfa-challenge-spent-burned.md). [proof: S02 AS-55]
- **S02.R-30** A [registry resolver prefix](../terms/reserved-provider-prefix.md) MUST be refused at registration when it is empty, starts with or is a prefix of `google`, or overlaps a registered prefix. [proof: S02 AS-57] [code: packages/backend/libs/domains/identity/application/oidc-provider-registry.ts#OidcProviderRegistry]
- **S02.R-31** A provider from a [resolver](../terms/oidc-provider-resolver.md) MUST be [believed for its subject only](../terms/provider-subject.md): its login creates an account with `email = null` and [never links to an existing account by e-mail](../terms/oidc-account-link.md). [proof: S02 AS-56]
- **S02.R-32** A provider that is disabled, unknown or answered with a [malformed settings object](../terms/oidc-provider-registry.md) MUST answer [`404 oidc_provider_not_found`](../terms/oidc-provider-not-found.md); a resolver that throws MUST answer [`503 oidc_provider_unavailable`](../terms/oidc-provider-unavailable.md). [proof: S02 AS-57]
- **S02.R-33** A provider [issuer ↗](../sw-external-terms.md#jwt-iss) that is not `https`, uses a port other than 443, or resolves to a [loopback, private or link-local address ↗](../sw-external-terms.md#ssrf) MUST answer `404 oidc_provider_not_found` with no outbound request. [proof: S02 AS-58]
- **S02.R-34** An [unreadable stored secret](../terms/secret-box.md) MUST answer a generic `500` that spends no [TOTP step](../terms/totp-time-step.md), [challenge attempt](../terms/mfa-challenge.md) or [recovery code](../terms/mfa-recovery-code.md) and issues no session. [proof: S02 AS-62]
- **S02.R-35** Each of [the six events](../terms/security-events.md) MUST carry [`eventId`](../terms/event-id.md), `type`, [`version`](../terms/aggregate-version.md), `occurredAt` and [`aggregateId`](../terms/aggregate-id.md) with identifiers only, MUST [commit with its state change ↗](../sw-external-terms.md#transactional-outbox), and MUST be absent after a rejected call. [proof: S02 AS-64]
- **S02.R-36** Each security step MUST write one [audit line](../terms/audit-log.md) with [`requestId`](../terms/request-id.md) and `userId` and count it, and no log line MUST contain a secret, code, challenge, [`state`](../terms/oidc-state.md), [`nonce` ↗](../sw-external-terms.md#oidc-nonce), [verifier ↗](../sw-external-terms.md#pkce) or e-mail. [proof: S02 AS-59, S02 AS-60]

## Behaviors
- **S02.B-01** Given [state `none`](../terms/mfa-state.md), when the user calls [enrol](../terms/mfa-enrolment.md), then the answer is `200` with [`otpauthUri`](../terms/otpauth-uri.md) and [`manualEntryKey`](../terms/manual-entry-key.md), with [`Cache-Control: no-store` ↗](../sw-external-terms.md#cache-control-no-store). [proof: S02 AS-01]
- **S02.B-02** Given [state `pending`](../terms/mfa-state.md) and a current code, when the user [confirms](../terms/mfa-confirm.md), then the factor becomes [`enabled`](../terms/mfa-state.md) and ten [recovery codes](../terms/mfa-recovery-code.md) are returned once. [proof: S02 AS-04]
- **S02.B-03** Given a malformed [confirm body](../terms/mfa-confirm.md) (5 or 7 digits, letters, [extra field](../terms/unknown-body-field.md)), when sent, then [`400 validation_failed`](../terms/validation-failed-error.md) and nothing changes. [proof: S02 AS-05]
- **S02.B-04** Given an enabled user who logs in with a password, when the login returns a [challenge](../terms/mfa-challenge.md) and the user sends the current code to [verify](../terms/mfa-verify-endpoint.md), then a session is issued with the [S01 login body](../terms/post-auth-login.md). [proof: S02 AS-12]
- **S02.B-05** Given [cookie delivery](../terms/cookie-delivery.md) and an allowed [`Origin` ↗](../sw-external-terms.md#origin-header), when verify succeeds, then three cookies are set and no token is in the body; with `Origin: https://evil.example` the answer is [`403 origin_not_allowed`](../terms/origin-not-allowed.md). [proof: S02 AS-13]
- **S02.B-06** Given a code already accepted at [step T](../terms/totp-time-step.md), when a second login presents it, then [`401 invalid_mfa_code`](../terms/invalid-mfa-code.md). [proof: S02 AS-14]
- **S02.B-07** Given a [recovery code](../terms/mfa-recovery-code.md) in any accepted form, when verified, then the session is issued with [`amr` ↗](../sw-external-terms.md#jwt-amr) `["pwd","rcv","mfa"]` and the code is [spent](../terms/mfa-recovery-code-spend.md). [proof: S02 AS-20]
- **S02.B-08** Given a [challenge](../terms/mfa-challenge.md) that is expired, tampered, for another [audience ↗](../sw-external-terms.md#jwt-aud), or for a deleted user, when verified, then [`401 invalid_mfa_challenge`](../terms/invalid-mfa-challenge.md). [proof: S02 AS-19]
- **S02.B-09** Given Google is configured, when a visitor calls [start](../terms/oidc-start.md) with [`returnTo`](../terms/return-to.md), then the answer carries an [`authorizationUrl`](../terms/authorization-url.md) with [PKCE ↗](../sw-external-terms.md#pkce) and a [flow cookie](../terms/oidc-flow-cookie.md). [proof: S02 AS-29]
- **S02.B-10** Given a valid flow and a verified [ID token ↗](../sw-external-terms.md#oidc-id-token) for an unknown subject and e-mail, when the [callback](../terms/oidc-callback.md) runs, then a new user is created and signed in. [proof: S02 AS-31]
- **S02.B-11** Given an ID token with a wrong [`nonce` ↗](../sw-external-terms.md#oidc-nonce), wrong [`aud` ↗](../sw-external-terms.md#jwt-aud), different [`iss` ↗](../sw-external-terms.md#jwt-iss), expired [`exp` ↗](../sw-external-terms.md#jwt-exp), bad signature, [`alg: none` ↗](../sw-external-terms.md#jwt-alg) or `alg: HS256`, when the callback runs, then the login fails with a [closed error code](../terms/closed-error-code.md) and no session. [proof: S02 AS-35]
- **S02.B-12** Given the provider returns [`access_denied` ↗](../sw-external-terms.md#oauth-access-denied), when the callback runs, then the redirect is [`/login?error=oidc_denied`](../terms/oidc-login-error.md) and the provider text is not echoed. [proof: S02 AS-39]
- **S02.B-13** Given the [token endpoint ↗](../sw-external-terms.md#oauth-token-endpoint) fails (`400`, `500`, non-JSON, no `id_token`, over 1 MB), when the callback runs, then [`error=oidc_exchange_failed`](../terms/oidc-login-error.md). [proof: S02 AS-40]
- **S02.B-14** Given a [token endpoint ↗](../sw-external-terms.md#oauth-token-endpoint) silent for 3 s, when the callback runs, then [`error=oidc_provider_unavailable`](../terms/oidc-login-error.md) within 10 s, with one token request and no retry. [proof: S02 AS-41]
- **S02.B-15** Given a password account [never verified by a provider](../terms/email-verified.md), when a Google login arrives with its verified e-mail, then the same user is signed in and [linked](../terms/identity-link.md). [proof: S02 AS-44]
- **S02.B-16** Given two [concurrent ↗](../sw-external-terms.md#race-condition) first Google logins for one subject, when both complete, then [one user and one link exist](../terms/identity-link.md). [proof: S02 AS-45]
- **S02.B-17** Given a user linked to `g-1`, when a login arrives for `g-2` with the user's e-mail, then [`error=link_conflict`](../terms/link-conflict.md). [proof: S02 AS-46]
- **S02.B-18** Given a [soft-deleted linked user](../terms/soft-deleted-user.md), when the [callback](../terms/oidc-callback.md) completes, then [`error=account_unavailable`](../terms/account-unavailable.md). [proof: S02 AS-47]
- **S02.B-19** Given a signed-in user, when [explicit linking](../terms/linked-identity.md) completes, then the callback redirects with [`?linked=google`](../terms/linked-query-param.md) and [issues no new session](../terms/oidc-account-link.md). [proof: S02 AS-49, S02 AS-50]
- **S02.B-20** Given a user with two [identities](../terms/linked-identity.md), when the user lists them, then only their own identities appear, newest first. [proof: S02 AS-51]
- **S02.B-21** Given an [enabled factor](../terms/mfa-state.md) and a [TOTP code ↗](../sw-external-terms.md#totp), when the user [regenerates](../terms/mfa-recovery-code-regenerate.md), then [ten new codes](../terms/mfa-recovery-code.md) are returned, the old ten stop working and one [`identity.mfa_recovery_codes_regenerated` event](../terms/mfa-recovery-codes-regenerated-event.md) is written. [proof: S02 AS-25]
- **S02.B-22** Given an enabled factor, when the user disables it with a [recovery code](../terms/mfa-recovery-code.md), then the answer is `204` and [`identity.mfa_recovery_code_used`](../terms/mfa-recovery-code-used-event.md) and [`identity.mfa_disabled`](../terms/mfa-disabled-event.md) with reason `user` are written. [proof: S02 AS-26]
- **S02.B-23** Given a Google login of a user with an enabled factor, when the user posts the current code with [`delivery: cookie`](../terms/cookie-delivery.md), then a session with [`amr` ↗](../sw-external-terms.md#jwt-amr) [`["fed","otp","mfa"]` ↗](../sw-external-terms.md#jwt-amr) is issued. [proof: S02 AS-54]
- **S02.B-24** Given a [shop provider](../terms/static-provider-configuration.md) [asserting a victim's verified e-mail](../terms/email-verified.md), when its callback completes, then a new account without e-mail is created and the victim's password, [factor](../terms/mfa-state.md) and sessions stay unchanged. [proof: S02 AS-56]
- **S02.B-25** Given [`invalidate`](../terms/invalidate.md) for a provider, when the next [flow](../terms/oidc-flow-cookie.md) starts, then the [provider document](../terms/provider-document.md) is fetched again and the [resolver's current settings](../terms/oidc-provider-registry.md) are used. [proof: S02 AS-57]

## Lifecycles
The second-factor state moves as follows. The user moves `none→pending` (enrol), `pending→pending` (re-enrol), `pending→enabled` (confirm) and `enabled→none` (disable). Account linking by e-mail also moves `enabled→none`. A pending enrolment expires after 15 minutes and reads as `none`.

## Owns
- Models: `SecondFactor`, `MfaRecoveryCode`, `MfaChallengeState`, `FederatedIdentity`.
- Events: `identity.mfa_enabled`, `identity.mfa_disabled`, `identity.mfa_recovery_code_used`, `identity.mfa_recovery_codes_regenerated`, `identity.federated_identity_linked`, `identity.federated_identity_unlinked`, and `identity.user_registered` for Google-created users.
- Cookies: `__Host-oidc-flow`, `__Host-mfa-challenge`.
- Rate-limit policies: `auth.mfa.ip`, `auth.mfa.account`, `auth.oidc.ip`.
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
- AS-61 (every error answers the problem schema with the stable code) and AS-63 (ownership gates) are tested or checked but not stated as their own rules.
- AS-65 and AS-66 (the browser journeys "MFA" and "Google") belong to {{cap:W01}} and are not run by this capability's tests.
- A redirect from a dynamic issuer is not followed and answers `503 oidc_provider_unavailable`, not the `404` that {{cap:S02}} AS-58 asks for.
- AS-42 (discovery with a mismatched issuer or non-https endpoints) is tested but not stated as its own rule.
- The Rules list does not include the unlink refusal `409 last_login_method`, because no listed test names it.