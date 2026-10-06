# Feature Specification: S02 — TOTP MFA with Recovery Codes, Google OIDC Login (PKCE), Account Linking

**Capability**: S02 · **Domain**: `identity` · **Spec directory**: `specs/domains/S02-mfa-oidc`

**Created**: 2026-10-05

**Status**: Draft

**Input**: "TOTP MFA with recovery codes, Google OIDC login (PKCE), account linking (domain `identity`)", sources `SD-39-auth-sso`, `05-Security/02-authentication-authorization` (§4 OAuth/OIDC, §5 password and MFA hardening, §9 secrets). Pattern: P0513 (OAuth 2 / OIDC + PKCE, state, nonce).

Companion files: [`questions.md`](questions.md) (decisions taken unattended, tagged), [`test-plan.md`](test-plan.md) (constitution VII.8 table), [`gaps.md`](gaps.md) (what today's code lacks, debt rows, IX.7 replacements).

## Scope

In scope:

- **Second factor**: TOTP enrolment (pending → enabled), status, verification at login for password and Google logins, single-use recovery codes, regeneration of recovery codes, disabling, replay and brute-force protection, step-up (a fresh code) for changing the factor.
- **Google sign-in**: Authorization Code flow with PKCE (S256), `state`, `nonce`, exact redirect URI, ID-token validation, browser-bound flow, safe return path, timeouts, uniform failure handling.
- **Account linking**: first-time Google login creating an account or linking to an existing one by verified e-mail, hardening against pre-hijacking, explicit linking from a signed-in account, listing and unlinking identities, one identity per provider, concurrency safety.
- **Provider seam for S03**: an exported registry through which tenancy supplies per-shop enterprise IdPs. S02 owns the protocol engine and the trust rules; S03 owns the shop configuration.

Out of scope (owned elsewhere or deliberately not built):

- Password login, sessions, refresh, JWKS, CSRF/cookie primitives, service tokens, password reset → **S01** (S02 plugs into its seams; see Cross-capability contracts).
- Shop SSO configuration, memberships, "which shop does this staff member belong to" → **S03**.
- Sending mails ("new sign-in method added", "recovery code used") → **S28**; S02 only emits events.
- WebAuthn/passkeys, SMS or e-mail codes, device trust ("remember this browser"), CAPTCHA, e-mail verification at registration, a general "re-authenticate" challenge for other capabilities: not built (see Assumptions).
- Native-app/mobile OIDC with custom URI schemes, Apple/Microsoft/GitHub providers: not built. The engine is provider-generic; only Google is configured.

## User Scenarios & Testing *(mandatory)*

Every acceptance scenario has a stable ID `AS-nn`; `test-plan.md` maps each to exactly one row. Scenarios of S01 are cited as "S01 AS-nn". Defaults used below are listed under *Defaults*. "Second-factor state" is one of `none`, `pending`, `enabled`.

### User Story 1 — Turn on an authenticator app (Priority: P1)

A signed-in member starts enrolment, adds the secret to an authenticator app, proves it works with one code, and receives ten recovery codes, shown exactly once. Until the proof succeeds nothing changes at login, and an enabled factor can never be silently reset.

**Why this priority**: the factor protects every account that opts in; a flawed enrolment (silent downgrade, weak codes) is worse than none.

**Independent Test**: enrol, confirm, attempt illegal transitions, check stored data.

**Acceptance Scenarios**:

1. **AS-01** — **Given** a user with state `none` and a valid Bearer access token, **When** `POST /api/auth/mfa/enroll` is sent, **Then** `200` with `{otpauthUri, manualEntryKey}` and `Cache-Control: no-store`; the URI has scheme `otpauth://totp/`, label `Marketplace:<email>` (the user ID when the account has no e-mail) and parameters `secret`, `issuer=Marketplace`, `algorithm=SHA1`, `digits=6`, `period=30`; `manualEntryKey` is the same secret in unpadded upper-case base32 of ≥ 160 bits; state is `pending` with a pending expiry of now + 15 min; the persisted secret is sealed (does not contain the plaintext secret in any encoding) and cannot be opened in the context of another user; no recovery code exists; a password login by this user still returns a session directly.
2. **AS-02** — **Given** state `pending`, **When** enrol is called again, **Then** `200` with a different secret and a new 15-minute expiry; a code from the first secret no longer confirms, a code from the new one does.
3. **AS-03** — **Given** state `enabled`, **When** enrol is called, **Then** `409` `mfa_already_enabled`; the secret, the recovery codes and the state are unchanged and the next login still demands a valid code (an enabled factor can never be reset by an access token alone).
4. **AS-04** — **Given** state `pending` and a correct current code, **When** `POST /api/auth/mfa/confirm` `{code}` is sent, **Then** `200` `{recoveryCodes:[…10 items…]}` with `Cache-Control: no-store`; the codes are distinct and have the format of FR-021; state is `enabled` with `enabledAt` = now; the pending expiry is gone; the persisted recovery codes are keyed one-way digests (no plaintext, no unkeyed hash); the accepted time step is recorded so the same code cannot be used at the next login; exactly one outbox event `identity.mfa_enabled` v1 exists.
5. **AS-05** — **Given** state `pending`, **When** confirm is sent with: no body, `code` missing, not a string, an integer, 5 digits, 7 digits, letters, spaces inside, empty, longer than 32 characters, an unknown extra field, **Then** each returns `400` `validation_failed` with a per-field list and nothing changes; **When** a well-formed but wrong code is sent (also: a code of the previous pending secret, a recovery-code-shaped string), **Then** `422` `invalid_code`, state stays `pending`, no recovery codes exist, and the failure counts towards FR-016.
6. **AS-06** — **Given** state `none`, or `pending` for more than 15 min + 1 s (a correct code for that secret), or `enabled`, **When** confirm is sent, **Then** `409` `mfa_not_pending` in all three cases; an expired pending enrolment reads as `none`; an enabled factor keeps its recovery codes.
7. **AS-07** — **Given** state `pending` and a correct code, **When** two confirm requests with that code run at the same time (`Promise.all`), **Then** exactly one returns `200` and the other `409` `mfa_not_pending`; exactly one set of ten recovery codes is stored and exactly one `identity.mfa_enabled` event exists.
8. **AS-08** — **Given** each of the five management endpoints (`GET /auth/mfa`, `POST /auth/mfa/enroll`, `confirm`, `recovery-codes/regenerate`, `disable`), **When** called with no credential, a challenge token (`typ: mfa+jwt`) as Bearer, a token of a revoked session (all but `GET`; these four are sensitive routes of S01), **Then** `401` `invalid_token` problem+json each; **Given** users A and B both `pending`, **When** A confirms with B's current code, **Then** `422` `invalid_code` and B's enrolment is untouched (every operation acts on the principal only).
9. **AS-09** — **Given** users in each state, **When** `GET /api/auth/mfa` is called, **Then** `none` → `{state:"none"}`; `pending` → `{state:"pending"}`; `enabled` → `{state:"enabled", enabledAt, recoveryCodesRemaining:n}`; the body never contains a secret, URI, digest or code and parses with the contracts schema.
10. **AS-10** — **Given** the code verifier (pure) and a frozen clock, **When** given the RFC 6238 SHA-1 vectors (`12345678901234567890` at T = 59, 1111111109, 1111111111, 1234567890, 2000000000, 20000000000, 6-digit truncation), the previous and next 30-second step, two steps away, a step ≤ the last accepted step, and inputs that are empty, 5 or 7 digits, non-digits or have whitespace, **Then** the vectors, previous and next step are accepted (returning the matched step), two steps away and any step ≤ last accepted are rejected, malformed inputs are rejected without throwing.
11. **AS-11** — **Given** the recovery-code generator and normaliser (pure), **When** 1,000 sets are generated and the inputs `abcde-fghjk`, `ABCDE-FGHJK`, `abcdefghjk`, ` ABCDE-FGHJK `, `abcde fghjk`, `ABCDE-FGHJ`, `ABCDE-FGHJKL`, `abcde_fghjk`, `` are normalised, **Then** every set has 10 distinct codes of the form `XXXXX-XXXXX` over a 32-symbol alphabet without look-alike characters; the first four inputs normalise to the same canonical value `ABCDE-FGHJK`, and the other five (inner space, too short, too long, other punctuation, empty) are rejected without throwing.

### User Story 2 — Log in with a password and a code (Priority: P1)

A member whose factor is enabled logs in with a password, receives a short challenge, and trades it plus a current code for a session. Codes work once, guessing is capped per challenge and per account, and a spent or stale challenge is worthless.

**Why this priority**: the second factor is only worth its guarantees at this step.

**Independent Test**: log in, verify, replay, race, brute-force.

**Acceptance Scenarios**:

1. **AS-12** — **Given** an enabled user and a challenge from a correct password login (S01 AS-19), **When** `POST /api/auth/mfa/verify` `{mfaToken, code}` with the current code is sent, **Then** `200` with the S01 login body `{accessToken:{token, expiresIn:300}, refreshToken, sessionId, user}`, `Cache-Control: no-store`, `Pragma: no-cache`, no `Set-Cookie`; the access token carries `amr: ["pwd","otp","mfa"]`; one session exists, with an ID different from any session the caller already held (the caller's old session is unaffected); the challenge is spent; the code's time step is recorded; one audit line `auth.mfa.verified` exists.
2. **AS-13** — **Given** the same preconditions, **When** the request adds `delivery:"cookie"` with an allowed `Origin`, **Then** `200` with `{sessionId, user, accessTokenExpiresIn}` and the three cookies of S01 AS-46, no token in the body; **When** `Origin` is `https://evil.example`, **Then** `403` `origin_not_allowed`, no cookie, no session, and the challenge is **not** consumed (a later correct request succeeds).
3. **AS-14** — **Given** a code accepted at time step T, **When** a second login obtains a new challenge and presents the same code (still inside its validity window), **Then** `401` `invalid_mfa_code`; **When** the first, spent challenge is presented again with a fresh code, **Then** `401` `invalid_mfa_challenge`; no extra session is created either way.
4. **AS-15** — **Given** one challenge and a correct code, **When** two verify requests run at once, **Then** exactly one returns `200`, the other `401`, and exactly one session exists; **Given** two challenges of the same user and the same correct code, **When** both are verified at once, **Then** exactly one succeeds (the time step is single-use across challenges).
5. **AS-16** — **Given** a challenge, **When** wrong codes are sent (wrong digits; a recovery-code-shaped value that does not match; another user's current code), **Then** each returns `401` `invalid_mfa_code` with identical bodies and no session; **When** the 3rd wrong code for the same challenge arrives, **Then** the challenge is burned: the 4th request, even with the correct code, returns `401` `invalid_mfa_challenge` and the user must log in again.
6. **AS-17** — **Given** one user, **When** 5 wrong codes have been submitted within 15 minutes across any mix of challenges, enrolment confirmations, disables and regenerations, **Then** the 6th second-factor attempt — even with a correct code, even on a fresh challenge — returns `429` `rate_limited` with `Retry-After` > 0 and an identical shape to other 429s; a successful verification earlier in the window resets the counter; after the window passes the correct code works.
7. **AS-18** — **Given** one client IP that sent 20 verify requests in a minute, **When** it sends the 21st, **Then** `429` with `Retry-After`; **Given** that IP over the limit and an invalid body, **Then** `429` (not `400`): throttling runs before validation.
8. **AS-19** — **Given** challenges that are: expired (5 min + 1 s), tampered in payload, tampered in signature, an ordinary access token, signed for another audience, for a deleted user, for a user whose factor was disabled after the challenge was issued, and a challenge presented as a Bearer access token on `GET /api/auth/me`, **When** verify is called (and `/auth/me` for the last), **Then** the verify cases all return `401` `invalid_mfa_challenge` with byte-identical bodies (apart from `requestId`), no session exists, and `/auth/me` returns `401` `invalid_token`.
9. **AS-20** — **Given** an enabled user with an unspent recovery code C, **When** verify is sent with the challenge and `c` in any of the forms `C`, lower-case, without hyphen, with surrounding spaces, **Then** `200` with `amr: ["pwd","rcv","mfa"]`; C is spent (the same code on a new challenge → `401` `invalid_mfa_code`); `recoveryCodesRemaining` in `GET /auth/mfa` drops by one; exactly one event `identity.mfa_recovery_code_used` v1 `{userId, remaining}` exists.
10. **AS-21** — **Given** one unspent recovery code and two challenges of the user, **When** both challenges present that code at once, **Then** exactly one returns `200`, the other `401`; the code is spent once; one event exists.
11. **AS-22** — **Given** an enabled user who completes an S01 password reset, **Then** the state is still `enabled`, recovery codes unchanged, and the next password login returns `mfaRequired:true` (a mailbox compromise does not bypass the factor).
12. **AS-23** — **Given** the verify endpoint, **When** the body has `mfaToken` missing with no challenge cookie (FR-063), `code` missing, a non-string `mfaToken`/`code`, `mfaToken` longer than 4,096 or `code` longer than 32 characters, an unknown field, `delivery` other than `body`/`cookie`, **Then** each returns `400` `validation_failed` (or `401` `invalid_mfa_challenge` for the missing-challenge case) with no state change; **When** the content type is `application/x-www-form-urlencoded` or `text/plain`, **Then** `415`.
13. **AS-24** — **Given** a code accepted at step T, **When** the cache layer is flushed and the service restarted before the replay, **Then** the same code is still rejected (the replay guard is durable, not cache-held).

### User Story 3 — Replace recovery codes, turn the factor off (Priority: P2)

A member who has used up or lost their recovery codes can mint a new set; a member who no longer wants the factor can switch it off. Both need a current code, because a stolen session must not be enough.

**Why this priority**: without these, recovery codes are a dead end and the only "disable" path would be a back door.

**Independent Test**: regenerate and check old codes die; disable and log in without a challenge.

**Acceptance Scenarios**:

1. **AS-25** — **Given** an enabled user, **When** `POST /api/auth/mfa/recovery-codes/regenerate` `{code}` is sent with a current TOTP code, **Then** `200` `{recoveryCodes:[10]}` (`no-store`); every old code now yields `401` `invalid_mfa_code` at login; the new set verifies; exactly one event `identity.mfa_recovery_codes_regenerated` v1 exists; **When** the factor state is `none` or `pending`, **Then** `409` `mfa_not_enabled`; **When** the code is wrong, **Then** `422` `invalid_code` and the old set still works.
2. **AS-26** — **Given** an enabled user, **When** `POST /api/auth/mfa/disable` `{code}` is sent with a current TOTP code, or with an unspent recovery code, **Then** `204`; state is `none`, secret and recovery codes are removed, the next password login returns a session directly; exactly one event `identity.mfa_disabled` v1 `{userId, reason:"user"}` exists; **When** the code is wrong, **Then** `422` `invalid_code` and the factor stays enabled; **When** state is `none`, **Then** `409` `mfa_not_enabled`.
3. **AS-27** — **Given** an enabled user, **When** regenerate is sent with a recovery code instead of a TOTP code, **Then** `422` `invalid_code` (recovery codes cannot mint recovery codes); **When** regenerate or disable reuses the TOTP code that was last accepted (same time step), **Then** `422` `invalid_code`; **When** two disable requests with the same correct code run at once, **Then** exactly one returns `204` and the other `409` `mfa_not_enabled` or `422`, and exactly one `identity.mfa_disabled` event exists.

### User Story 4 — Sign in with Google (Priority: P1)

A visitor chooses "Continue with Google", approves at Google, and lands signed in on the page they came from, with a new account if they have none. No token ever appears in a URL, a page script or a log.

**Why this priority**: one-click sign-in is the main social-login path (SD-39) and the main attack surface of redirect-based flows.

**Independent Test**: run the flow against a fake identity provider and inspect requests, cookies and stored data.

**Acceptance Scenarios**:

1. **AS-28** — **Given** Google configured, **When** `GET /api/auth/oidc/providers`, **Then** `200 [{id:"google", displayName:"Google"}]`; **Given** Google not configured, **Then** `200 []`; neither contains a client ID, secret or issuer; the body parses with the contracts schema.
2. **AS-29** — **Given** Google configured, **When** `POST /api/auth/oidc/google/start` `{returnTo:"/account"}` is sent (JSON, allowed `Origin`), **Then** `200 {authorizationUrl}` with `no-store`; the URL points at the provider's discovered authorization endpoint and carries exactly `response_type=code`, `client_id`, `redirect_uri` equal to the one configured callback URL, `scope=openid email profile`, `state` and `nonce` (each ≥ 128 bits of randomness), `code_challenge` (43 characters) and `code_challenge_method=S256`; it contains no `client_secret` and no `code_verifier`; a cookie `__Host-oidc-flow` is set (`HttpOnly; Secure; SameSite=Lax; Path=/`, no `Domain`, `Max-Age=600`); a server-side flow record exists, expiring in 10 min, that holds the verifier, nonce, return path, purpose `login` and a digest of the cookie value; two starts produce different `state`, `nonce` and `code_challenge`.
3. **AS-30** — **Given** the start endpoint, **When** the provider is `facebook`, `GOOGLE`, `google ` , `shop:not-a-uuid`, `../x`, 200 characters long, or `google` while unconfigured, **Then** `404` `oidc_provider_not_found` with identical bodies and no flow record; **When** `Origin` is `https://evil.example`, **Then** `403` `origin_not_allowed` and no flow record; **When** the content type is a form type, **Then** `415`; **When** the 31st start from one IP arrives within a minute, **Then** `429` with `Retry-After`; **When** `returnTo` is one of the rejected values of AS-34, **Then** `400` `validation_failed` naming `returnTo` and no flow record.
4. **AS-31** — **Given** a valid flow (cookie and state from AS-29) and a fake provider that answers the code exchange with a valid ID token `{iss, aud, sub:"g-123", email:"New@Example.com", email_verified:true, nonce, exp}`, **When** `GET /api/auth/oidc/google/callback?code=C&state=S` arrives with the flow cookie and no existing account, **Then** `302` to `<front>/account`; cookies `__Host-access`, `__Host-refresh` (HttpOnly), `__Host-csrf` (S01 AS-46 attributes) are set and `__Host-oidc-flow` is cleared; exactly one user `new@example.com`, role `USER`, no password verifier; exactly one federated identity `(google, g-123)` with the e-mail copy; one session whose access token has `amr: ["fed"]`; outbox events `identity.user_registered` v1 and `identity.federated_identity_linked` v1 `{userId, provider:"google", linkMethod:"login", passwordInvalidated:false, mfaReset:false}`; the flow record is gone; the provider saw one token request with `grant_type=authorization_code`, the exact `redirect_uri`, `code=C`, and a `code_verifier` whose S256 challenge equals the one sent at start; the provider's access, refresh and ID tokens appear in no persisted row, cache key or log line.
5. **AS-32** — **Given** an existing identity link `(google, g-123) → U` and a provider that now reports a different e-mail for `g-123`, **When** the callback completes, **Then** U is signed in (no second user, no change to U's e-mail), one new session exists, and no `identity.federated_identity_linked` or `identity.user_registered` event is emitted.
6. **AS-33** — **Given** any callback response (success or failure), **Then** it is a `302` whose `Location` starts with the configured front-end origin, carries `Cache-Control: no-store` and `Referrer-Policy: no-referrer`, and contains no token, code, state or e-mail; a `returnTo`, `redirect`, `next` or `url` query parameter on the callback URL has no effect on `Location`.
7. **AS-34** — **Given** the return-path validator (pure), **When** given `/`, `/account`, `/account/security?tab=mfa`, `/orders/123#top` (accepted) and `//evil.example`, `/\evil.example`, `/%2F%2Fevil.example`, `/%5Cevil.example`, `https://evil.example`, `javascript:alert(1)`, ``, `account`, `/a\nb` (CR/LF or other control characters), a 513-character path, a non-string, **Then** the first four are accepted unchanged and every other value is rejected without throwing.
8. **AS-35** — **Given** a valid flow, **When** the fake provider returns an ID token with: a wrong `nonce`, a wrong `aud`, a different `iss` than the discovered issuer, `exp` 6 s in the past, a signature by a key not in the provider's key set, header `alg: none`, header `alg: HS256` signed with the client secret, no `sub`, no `exp`, an oversized token (> 8 KB), **Then** each callback ends `302` to `<front>/login?error=oidc_token_invalid` with no session, no user, no link, no cookie other than the cleared flow cookie; **When** `exp` is 3 s in the past (inside the 5 s tolerance), **Then** it is accepted.
9. **AS-36** — **Given** the ID-token claim reader (pure), **When** given: `email_verified: true` and `false`; `"true"` (string) and absent; an e-mail with surrounding spaces and mixed case; no e-mail; an e-mail without `@` or over 254 characters; `sub` empty, 255 and 256 characters, a number; unknown extra claims, **Then** the result is respectively `{emailVerified:true}`, `{false}`, `{false}`, `{false}`, the e-mail trimmed and lower-cased, e-mail absent, e-mail treated as absent and unverified, `sub` rejected / accepted / rejected / rejected, extra claims ignored.

### User Story 5 — A forged, replayed or interrupted callback never signs anyone in (Priority: P1)

Whoever reaches the callback URL — an attacker with a stolen link, a second tab, a slow provider — either completes exactly the flow this browser started, once, or gets sent back to the login page with a stable error code.

**Why this priority**: the callback is the one place where an outsider's input becomes a session.

**Independent Test**: replay, cross-browser and failure-injection cases against the fake provider.

**Acceptance Scenarios**:

1. **AS-37** — **Given** a flow started in browser X, **When** the callback arrives with: no `state`; an unknown `state`; a `state` older than 10 min + 1 s; a `state` that already completed once (replay of a finished callback); a valid `state` but without the flow cookie (an attacker's link opened in another browser: login CSRF); a valid `state` with a different cookie value; a valid `state` under another provider name in the path, **Then** each ends `302` `<front>/login?error=oidc_state_invalid`, no session, no user, no link, and no token request reaches the provider; a flow record whose state is valid is consumed even when the cookie is wrong or the provider name differs; **When** one IP sends a 31st callback request within a minute, **Then** `429` `rate_limited` with `Retry-After`, and no flow record is consumed by that request.
2. **AS-38** — **Given** one valid flow, **When** two callbacks with the same `state` and cookie run at once, **Then** exactly one proceeds (one session, one token request at the provider) and the other ends with `error=oidc_state_invalid`.
3. **AS-39** — **Given** a valid flow, **When** the provider redirects back with `error=access_denied&error_description=<script>…`, **Then** `302` `<front>/login?error=oidc_denied`, the flow record is consumed, the provider's description is not echoed anywhere; the same for `error=server_error` and `error=login_required`; **When** `code` is missing or repeated (`code=a&code=b`) without an `error`, **Then** `error=oidc_exchange_failed`.
4. **AS-40** — **Given** a valid flow, **When** the provider's token endpoint answers `400 invalid_grant`, `500`, non-JSON, JSON without `id_token`, or a token response over 1 MB, **Then** `302` `error=oidc_exchange_failed`, no session, no user, flow record consumed.
5. **AS-41** — **Given** a valid flow and a provider whose token endpoint does not answer within 3 s, **When** the callback runs, **Then** it ends `302` `error=oidc_provider_unavailable` within the 10 s budget, exactly one token request was sent (no retry of the non-idempotent code exchange), no session, no user, the flow record is consumed, and the counter `auth_oidc_login_total{provider="google",result="provider_unavailable"}` increases by 1; a hung discovery or key-set request behaves the same.
6. **AS-42** — **Given** a provider whose discovery document names a different `issuer` than the URL it was fetched from, or an authorization or token endpoint that is not `https`, **When** start is requested, **Then** `503` `oidc_provider_unavailable` (generic detail) and no flow record; **Given** a successful discovery, **When** the next 100 starts occur within an hour, **Then** the provider is asked for its discovery document once.

### User Story 6 — One person, one account, however they sign in (Priority: P1)

A person who registered with a password and later clicks "Continue with Google" with the same verified address ends up in the same account — without a squatter's leftovers. A person can also link or unlink Google deliberately from their account page.

**Why this priority**: linking is where account takeover happens (pre-hijacking, unverified e-mails, recycled addresses); the notes say link by e-mail only when the provider verified it.

**Independent Test**: seed accounts in each state, run Google logins, inspect the account afterwards.

**Acceptance Scenarios**:

1. **AS-43** — **Given** no link for `(google, g-9)`, **When** the provider reports `email_verified:false`, `email_verified:"true"` (string), or no e-mail, **Then** the callback ends `302` `error=email_not_verified`; no user, link, session or event is created, and an existing account with that address is untouched.
2. **AS-44** — **Given** user U registered with a password at `a@example.com` (never verified by a provider), who has two active sessions and an enabled second factor, **When** a Google login arrives for `(google, g-1)` with verified e-mail `  A@Example.COM `, **Then** U (same ID; no second user) is signed in with a new session `amr: ["fed"]`; the identity is linked; U's password verifier is removed (a password login now yields `401` `invalid_credentials`); the second factor is reset to `none` (secret and recovery codes removed); both earlier sessions are revoked with reason `account_linked` (their refresh tokens yield `401`); events: `identity.federated_identity_linked` `{linkMethod:"email_match", passwordInvalidated:true, mfaReset:true}` and `identity.mfa_disabled` `{reason:"account_linking"}`.
3. **AS-45** — **Given** two callbacks for the same new `(google, g-2)` run at the same time, **Then** exactly one user and one link exist, both callbacks end signed in as that user (two sessions), and exactly one `identity.user_registered` event exists; **Given** an S01 registration and a Google first login for the same address run at the same time (`Promise.all`), **Then** whichever order wins, exactly one user exists, it has one link, and **no password verifier** (if registration landed first it was cleared by linking; if Google landed first the registration was treated as a duplicate, S01 AS-02).
4. **AS-46** — **Given** user U linked to `(google, g-1)`, **When** a login arrives for `(google, g-2)` with U's verified e-mail, **Then** `302` `error=link_conflict`; no session, no new link, no change to U (an e-mail match never overrides a subject match, and one account holds at most one identity per provider).
5. **AS-47** — **Given** a link whose user is soft-deleted, **When** the callback completes for that subject, **Then** `302` `error=account_unavailable`; no session; no new account with the same address is created.
6. **AS-48** — **Given** the linking decision function (pure), **When** given the combinations of {link by subject: none / active user / deleted user} × {provider trust: verified-email / subject-only} × {e-mail: absent / unverified / verified} × {user with that e-mail: none / exists without any federated identity / exists with a federated identity for this provider / exists with a federated identity for another provider} × {purpose: login / link by user}, **Then** each combination yields exactly one of `login(U)`, `create+link`, `link+login`, `link+login+wipe(password, factor, sessions)`, or `refuse(code)` per FR-060–FR-066, and the table has no unmapped combination.
7. **AS-49** — **Given** a signed-in user (Bearer, or cookie plus CSRF) with state `none`, **When** `POST /api/auth/oidc/google/link/start` `{returnTo}` is sent, **Then** `200 {authorizationUrl}` with a flow record of purpose `link` bound to this user; **Given** state `enabled`, **When** the body lacks `code` or has a wrong one, **Then** `422` `invalid_code` (counted by FR-016) and no flow record, **When** it has a current code, **Then** `200`; **Given** no credential or a revoked session, **Then** `401` `invalid_token`.
8. **AS-50** — **Given** a `link` flow of user U and a provider reporting `(google, g-5)`, **When** the callback completes, **Then** `302` to the return path with `?linked=google`, the identity is linked to U whatever e-mail the provider reports (even none or unverified), **no new session** is issued and U's sessions are untouched; one `identity.federated_identity_linked` `{linkMethod:"explicit", passwordInvalidated:false, mfaReset:false}` event exists; **When** `(google, g-5)` is already linked to another user, **Then** `error=identity_already_linked` and nothing changes; **When** U already has a Google identity, **Then** `error=link_conflict`; **When** the link flow's cookie belongs to another browser, **Then** `error=oidc_state_invalid`.
9. **AS-51** — **Given** user A with two identities and user B with one, **When** A calls `GET /api/auth/identities`, **Then** `200` lists only A's, newest first with `id` as tiebreaker, each exactly `{id, provider, email, linkedAt}` (no subject, user ID or internal field), parses with the contracts schema; `401` without a credential.
10. **AS-52** — **Given** A's identity I1 and B's identity I2, **When** A calls `DELETE /api/auth/identities/I2`, **Then** `404` `identity_not_found` identical to a non-existent ID and I2 stays; **When** the identity ID is not a UUID, **Then** the same `404`; **When** A deletes I1 and has a password or another identity, **Then** `204`, one `identity.federated_identity_unlinked` v1 `{userId, provider}` event, and a second delete → `404`; **When** I1 is A's only login method (no password, no other identity), **Then** `409` `last_login_method` and I1 stays; **When** the session is revoked, **Then** `401` (sensitive route).
11. **AS-53** — **Given** the identity store, **When** a second row is inserted directly for the same `(provider, subject)`, or for the same `(userId, provider)`, **Then** the store rejects both (uniqueness is enforced by the store, not by application code).

### User Story 7 — Google login does not bypass my second factor (Priority: P2)

A member with an enabled factor who signs in with Google still has to present a code; the challenge never travels in a URL.

**Why this priority**: otherwise the factor protects the password path only, and an attacker would just use the other door.

**Acceptance Scenarios**:

1. **AS-54** — **Given** an enabled user with a Google link, **When** the Google callback completes, **Then** `302` to `<front>/login/mfa?returnTo=<encoded return path>`, **no** session cookies and no session, and a cookie `__Host-mfa-challenge` (`HttpOnly; Secure; SameSite=Lax; Path=/`, `Max-Age=300`) holding a challenge with first factor `fed`; neither `Location` nor any body contains a token; **When** `POST /api/auth/mfa/verify` `{code, delivery:"cookie"}` follows without `mfaToken` and with an allowed `Origin`, **Then** `200` with the three session cookies, `amr: ["fed","otp","mfa"]`, and the challenge cookie cleared.
2. **AS-55** — **Given** the challenge cookie, **When** verify is sent with `Origin: https://evil.example`, without the cookie, with an expired cookie, or with `delivery:"body"` and no `mfaToken`, **Then** `403 origin_not_allowed` (challenge not consumed) or `401 invalid_mfa_challenge` respectively, never a session; **When** a body `mfaToken` is present, **Then** it is used and the cookie ignored.

### User Story 8 — Enterprise IdPs of shops cannot take over other accounts (Priority: P2)

Tenancy (S03) can register a per-shop identity provider by name (`shop:<uuid>`) so staff sign in through their company IdP. Because a tenant controls what its IdP claims, such a provider is trusted for "who is this subject" and never for "who owns this e-mail".

**Why this priority**: otherwise any shop admin could mint an identity asserting a victim's address and take over the victim's account.

**Acceptance Scenarios**:

1. **AS-56** — **Given** a provider `shop:<uuid>` registered through the registry with a fake IdP that asserts `email:"victim@example.com", email_verified:true` for subject `s-1`, and a password account for `victim@example.com`, **When** the shop IdP login completes, **Then** a **new** user is created with e-mail `null`, linked to `(shop:<uuid>, s-1)` with the claimed e-mail kept only on the link as a hint; the victim's account (password, factor, sessions) is untouched and not linked; the session is for the new user; a second login by `s-1` returns the same new user.
2. **AS-57** — **Given** the registry, **When** the resolver returns nothing (shop disabled or unknown) for `shop:<uuid>`, **Then** start returns `404` `oidc_provider_not_found`; **When** the resolver throws, **Then** `503` with a generic detail; **When** `invalidate("shop:<uuid>")` is called, **Then** the next start rediscovers the provider with the new settings; **When** a resolver is registered for the prefix `google` or an empty prefix, or twice for `shop:`, **Then** registration is rejected at startup.
3. **AS-58** — **Given** a shop provider whose issuer is `http://idp.example`, `https://localhost`, `https://127.0.0.1`, `https://10.0.0.5`, `https://169.254.169.254`, a hostname resolving to a private address, or an issuer that redirects to one of these, **When** start is requested, **Then** `404` `oidc_provider_not_found`, no outbound request is made to the private target, and a warning audit line names the provider ID (never the secret).

### User Story 9 — Operators can see what happened and secrets stay secret (Priority: P3)

**Acceptance Scenarios**:

1. **AS-59** — **Given** enrolment, confirmation, a successful and a failed verification, a recovery-code use, regeneration, disabling, a Google login (each result class of FR-054), a link, an unlink and an account-takeover wipe, **Then** each produces one structured audit line with an event name, `requestId`, `userId` (and `provider` where relevant) and never a code, secret, state, nonce, verifier or e-mail; counters exist with bounded labels: `auth_mfa_verify_total{result,method}` (`method` ∈ `totp|recovery`), `auth_mfa_challenge_burned_total`, `auth_oidc_login_total{provider,result}`, `auth_account_link_total{method}`, `auth_account_link_wipe_total`.
2. **AS-60** — **Given** the full flows (enrol → confirm → login with code → recovery login → disable; Google start → callback → link → unlink) with log capture, **Then** no log line, error body or `Location` header contains the TOTP secret, the otpauth URI, any TOTP or recovery code, the challenge, `state`, `nonce`, `code_verifier`, the authorization code, the provider's tokens, or a client secret.
3. **AS-61** — **Given** each error class of FR-100, **Then** the response parses with the shared problem schema (`type`, `title`, `status`, `detail`, `instance`, `requestId`) plus the stable `code`, `requestId` equals the response's request-ID header, and callback failures redirect with one of the closed error codes of FR-054.
4. **AS-62** — **Given** an enabled user whose stored secret cannot be opened (corrupted, or copied from another user's record), **When** they submit a code, **Then** `500` with a generic `detail` (no stack, key or SQL text), no session is created, nothing is spent, and the failure is logged server-side with the same `requestId`.

### User Story 10 — Identity's data stays inside identity (Priority: P3)

**Acceptance Scenarios**:

1. **AS-63** — **Given** the strict ownership and boundary checks, **Then** no domain other than identity reads, joins, associates, injects or imports the federated-identity data, the second-factor data, or the models and services behind them; `FederatedIdentityModel` and `OidcService` are not exported from `@app/domains/identity`; tenancy reaches the OIDC engine only through the exported `OidcProviderRegistry` (IX.7 R1).
2. **AS-64** — **Given** each event of the Provides list, **Then** it carries the envelope (`eventId`, `type`, `version`, `occurredAt`, `aggregateId = userId`), a payload of identifiers and flags only (no e-mail, secret, code or provider token), is written in the same transaction as the state change it describes, and is **absent** when the operation was rejected (409, 422, 429, failed callback).

### User Story 11 — The browser journeys work end to end (Priority: P3)

**Acceptance Scenarios** (happy paths only, owned by W01's Playwright file):

1. **AS-65** — **Given** a signed-in buyer, **When** they open security settings, enrol, scan or type the key, confirm with a current code, save the ten recovery codes, log out and log in again with password and code, **Then** each step succeeds, the recovery codes are shown once, and no token is ever present in script-readable storage or the URL.
2. **AS-66** — **Given** a visitor and a fake Google provider, **When** they choose "Continue with Google", approve, and return, **Then** they land signed in on the page they came from with their account in the navbar, and the sessions list shows the device.

### Edge Cases

Each edge case is covered by the scenario shown; none is left to implementation judgement.

- Enabled factor reset by an access token → AS-03. Illegal transitions (confirm without pending, disable when none, regenerate when pending) → AS-06, AS-25, AS-26.
- Concurrent confirm, verify, recovery use, disable → AS-07, AS-15, AS-21, AS-27. Idempotent replay of a spent code or challenge → AS-14, AS-20, AS-21.
- Brute force of a 6-digit code: per challenge, per account, per IP → AS-16, AS-17, AS-18. Throttling before validation → AS-18.
- Replay guard surviving a cache flush → AS-24. Clock skew of ±1 step → AS-10.
- Cross-user access (IDOR): confirm with another user's code, unlink another user's identity → AS-08, AS-52. Challenge of one user used for another → AS-19.
- Login CSRF and cross-origin cookie delivery → AS-13, AS-30, AS-37, AS-55. Open redirect → AS-33, AS-34.
- Callback forgery, replay, expiry, provider mismatch, parallel callbacks → AS-37, AS-38. Provider errors and denial → AS-39, AS-40. Timeouts without retry → AS-41. Discovery integrity and cache → AS-42.
- ID-token attacks (nonce, aud, iss, exp, alg none/confusion, key, size) → AS-35, AS-36.
- Pre-hijacking and unverified e-mail → AS-43, AS-44. Concurrent first login / registration race → AS-45. Recycled address (same e-mail, different subject) → AS-46. Soft-deleted user → AS-47.
- One identity per provider, last login method, duplicate rows → AS-46, AS-52, AS-53.
- Tenant-controlled IdP asserting someone else's e-mail; SSRF through issuer URLs → AS-56, AS-58.
- Federated login with an enabled factor → AS-54, AS-55. Password reset leaving the factor → AS-22.
- Corrupt secret → AS-62.
- Duplicate or out-of-order events: identity emits events through the outbox and consumes none; delivery guarantees and consumer idempotency belong to the consumers (S28) and the event infrastructure (S53); every event carries a stable `eventId` (FR-092).
- Timeouts: provider calls 3 s each inside a 10 s callback budget (AS-41); other outbound calls inherit platform timeouts (S54).

## Requirements *(mandatory)*

### Defaults

TOTP: SHA-1, 6 digits, 30-second step, ±1 step tolerance, secret ≥ 160 bits. Pending enrolment lifetime 15 min. Recovery codes: 10 per set, 10 symbols from a 32-symbol look-alike-free alphabet (50 bits), shown `XXXXX-XXXXX`. Challenge lifetime 5 min (S01); attempts per challenge 3; second-factor failures per account 5 per 15 min; verify per IP 20/min; OIDC start and callback per IP 30/min. OIDC flow lifetime 10 min; provider calls 3 s each, callback budget 10 s; provider response limit 1 MB; ID-token limit 8 KB; clock tolerance 5 s; discovery cached 1 h; return path ≤ 512 characters. One identity per provider per user. All are configuration values with these defaults.

### Functional Requirements

**Enrolment and status**

- **FR-001**: The second-factor state of a user is exactly one of `none`, `pending`, `enabled`; transitions are `none→pending` (enrol), `pending→pending` (re-enrol, new secret), `pending→enabled` (confirm), `enabled→none` (disable, account-linking wipe) and `pending→none` (expiry); every other transition MUST be refused with `409` (AS-03, AS-06, AS-25, AS-26).
- **FR-002**: Enrolment MUST NOT affect login until confirmed; an enabled factor MUST NOT be altered by enrolment (AS-01, AS-03).
- **FR-003**: Secrets MUST be generated with ≥ 160 bits of randomness, stored only in sealed form bound to the owning user, and never returned after enrolment (AS-01, AS-09, AS-62).
- **FR-004**: Confirmation MUST require a currently valid code, MUST be atomic (one winner under concurrency), enable the factor and issue the recovery codes in one step, and emit `identity.mfa_enabled` (AS-04, AS-07).
- **FR-005**: All management endpoints act only on the authenticated principal, answer `401` without a credential, reject purpose-limited tokens, and are sensitive routes that refuse revoked sessions immediately (AS-08).
- **FR-006**: `GET /auth/mfa` returns the state, and for `enabled` the enable time and the number of unspent recovery codes (AS-09).

**Verification**

- **FR-010**: A TOTP code is valid when it matches the current, previous or next time step; the matched step MUST be recorded durably and atomically, and a code whose step is not greater than the last accepted step for that user MUST be rejected, across all challenges, confirmations and step-ups, including concurrent ones (AS-10, AS-14, AS-15, AS-24).
- **FR-011**: A challenge is bound to one user and one first factor (`pwd` or `fed`), is valid 5 minutes, is single-use, and is burned after 3 wrong attempts; every challenge defect (expired, tampered, wrong type or audience, spent, burned, user deleted, factor not enabled) yields the same `401 invalid_mfa_challenge` (AS-14, AS-16, AS-19).
- **FR-012**: A successful verification creates a new session through the S01 session issuer with `amr` `["pwd","otp","mfa"]`, `["pwd","rcv","mfa"]`, `["fed","otp","mfa"]` or `["fed","rcv","mfa"]`; the response is credential-bearing and non-cacheable; cookie delivery requires the S01 origin check and consumes nothing when it fails (AS-12, AS-13, AS-20).
- **FR-013**: The code field is a 6-digit TOTP code or a recovery code; the two are distinguished by form, not by trying both (AS-16, AS-20).
- **FR-014**: Wrong codes of any kind return the same `401 invalid_mfa_code` at login and `422 invalid_code` in management calls, with no information about which kind or which part was wrong (AS-16).
- **FR-015**: Second-factor attempts are throttled per challenge (3), per account (5 failures per 15 min, shared by login verification, confirmation, step-up and regeneration, reset on success) and per IP (20/min), all fail-closed, with `429` and `Retry-After`; authentication and throttling run before body validation (AS-17, AS-18).
- **FR-016**: Every failed code check in any endpoint counts toward the per-account budget of FR-015 (AS-05, AS-17).
- **FR-017**: Verification endpoints accept only `application/json` (AS-23) and validate bodies with a whitelist (AS-05, AS-23).

**Recovery codes and management**

- **FR-021**: A set has 10 distinct codes of 10 symbols (≥ 50 bits each); they are shown only in the response that creates them; they are stored only as keyed one-way digests; matching ignores case and a surrounding-space or missing hyphen but accepts no other punctuation (AS-04, AS-11).
- **FR-022**: A recovery code is spent atomically by one verification or one disable; the same code can never succeed twice, even concurrently; using one emits `identity.mfa_recovery_code_used` with the remaining count (AS-20, AS-21).
- **FR-023**: Regeneration requires state `enabled` and a current TOTP code (not a recovery code), replaces the whole set atomically and emits `identity.mfa_recovery_codes_regenerated` (AS-25, AS-27).
- **FR-024**: Disabling requires state `enabled` and a current TOTP code or an unspent recovery code, removes the secret and all codes, and emits `identity.mfa_disabled` with reason `user` (AS-26, AS-27).
- **FR-025**: Completing an S01 password reset MUST NOT change the second-factor state (AS-22).

**Google sign-in**

- **FR-040**: The flow is Authorization Code with PKCE S256, a `state` and a `nonce` of ≥ 128 bits each, scope exactly `openid email profile`, and the single configured redirect URI matched exactly; no client secret or verifier appears in any front-channel URL (AS-29).
- **FR-041**: Starting a flow is a `POST` (the request creates state), requires `application/json` and the S01 origin check, validates the provider name against `^google$|^shop:<uuid>$` shapes and the return path per FR-045, and is throttled per IP; unknown or disabled providers answer `404` identically (AS-29, AS-30).
- **FR-042**: A flow is bound to the initiating browser by an HttpOnly `__Host-oidc-flow` cookie whose digest is stored with the flow; it is single-use, expires after 10 minutes, and records provider, purpose (`login` or `link`), user (for `link`), verifier, nonce and return path (AS-29, AS-37, AS-38).
- **FR-043**: The callback MUST check, in this order, flow existence (atomic consume), cookie binding, provider match, provider error parameters, then exchange the code with the verifier, then validate the ID token: signature against the provider's published keys with the algorithm pinned to the provider's advertised signing algorithm (never `none`, never a symmetric one), `iss` equal to the discovered issuer, `aud` containing the client ID (and `azp` equal to it when several), `exp`/`iat` with 5 s tolerance, `nonce`, `sub` present; any failure is `oidc_token_invalid` with no detail (AS-35, AS-37, AS-39).
- **FR-044**: Provider responses are validated against a schema before use (anti-corruption layer): sizes limited, types checked, `email_verified` honoured only when it is the boolean `true`, e-mail trimmed and lower-cased, `sub` 1–255 characters (AS-35, AS-36).
- **FR-045**: A return path is a relative path starting with exactly one `/`, ≤ 512 characters, with no control characters, no backslash and no `//` prefix before or after one round of percent-decoding; invalid values are rejected with `400` at start, never silently rewritten (AS-30, AS-34).
- **FR-046**: Every provider request has a 3 s timeout and a 1 MB limit, the callback has a 10 s budget, the code exchange is never retried, discovery and key-set documents are cached for ≤ 1 h and reloaded at most once per 30 s on an unknown key, and requests go through the platform's SSRF-guarded client (AS-41, AS-42, AS-58).
- **FR-047**: The provider's access, refresh and ID tokens are used only inside the callback and discarded: never stored, forwarded, logged, or used as API credentials (AS-31, AS-60).
- **FR-048**: Callback outcomes: success → session issued through the S01 session issuer with cookie delivery and `amr ["fed"]`; enabled factor → challenge cookie and redirect to `/login/mfa` (FR-063); every failure → `302` to `<front>/login?error=<code>` with a code from the closed list `oidc_state_invalid`, `oidc_denied`, `oidc_exchange_failed`, `oidc_token_invalid`, `oidc_provider_unavailable`, `email_not_verified`, `account_unavailable`, `link_conflict`, `identity_already_linked`; all callback responses are non-cacheable with `Referrer-Policy: no-referrer` and redirect only to the configured front-end origin (AS-31, AS-33, AS-54).
- **FR-049**: `GET /auth/oidc/providers` lists enabled static providers by `{id, displayName}` only (AS-28).

**Account linking**

- **FR-060**: Resolution order for a `login` flow: (1) a link for `(provider, subject)` exists → that user (refused for a deleted user); (2) otherwise, for a **verified-email** provider with a verified e-mail → link by e-mail or create (FR-061, FR-062); (3) otherwise refuse (`email_not_verified`; for **subject-only** providers, create per FR-066). A subject match always wins over an e-mail match (AS-32, AS-43, AS-46, AS-47, AS-48).
- **FR-061**: Linking by e-mail to an existing account with no federated identity (an account created by password registration, whose address was never proven) MUST, in the same atomic step as creating the link: remove the password verifier, reset the second factor to `none`, revoke every existing session with reason `account_linked`, and emit the events of AS-44. An account that already has a verified-email federated identity is linked without that wipe (AS-44, AS-48).
- **FR-062**: A new account created by Google has role `USER`, the verified e-mail, no password verifier, and emits `identity.user_registered` and `identity.federated_identity_linked` (AS-31, AS-45).
- **FR-063**: Challenge delivery for federated logins uses an HttpOnly `__Host-mfa-challenge` cookie; `POST /auth/mfa/verify` uses it only when `delivery` is `cookie`, the body has no `mfaToken`, and the origin check passes (AS-54, AS-55).
- **FR-064**: One account holds at most one identity per provider and one `(provider, subject)` belongs to one account; both are enforced by the data store; concurrent first logins and a concurrent registration of the same address converge to one account with one link and no password (AS-45, AS-53).
- **FR-065**: Explicit linking (`purpose = link`) requires an authenticated principal and, when the factor is `enabled`, a current code; it links the verified `(provider, subject)` to that user regardless of e-mail, issues no session, and refuses conflicts without changing anything (AS-49, AS-50).
- **FR-066**: **Subject-only** providers (every dynamic provider supplied through the registry) are trusted only for the subject: they never link by e-mail, a first login creates a new account with e-mail `null` and keeps the claimed address only on the link as a hint, and `email_verified` from them has no effect. Only the platform-configured provider `google` is verified-email (AS-56).
- **FR-067**: Users can list their identities and unlink one; unlinking is scoped to the caller (another user's identity answers `404`), refused when it is the only login method (`409 last_login_method`), idempotent in effect and emits `identity.federated_identity_unlinked` (AS-51, AS-52).

**Provider seam (for S03)**

- **FR-070**: `OidcProviderRegistry` (exported, R1) lets a domain register a resolver for a reserved name prefix and invalidate cached provider settings; registration of an empty prefix, `google`, or a duplicate prefix is refused at startup; resolver output is validated and its trust level is forced to subject-only (AS-57).
- **FR-071**: Dynamic provider issuers MUST be `https` and MUST pass the SSRF guard (no loopback, private, link-local or metadata addresses, re-checked on every redirect and on DNS rebinding); otherwise the provider answers as unknown (AS-58).

**Data, boundaries, observability, errors**

- **FR-080**: Identity owns the user's second-factor data and `FederatedIdentity`; no other domain reads, joins, associates, injects or imports them; the only cross-owner write is the outbox append (IX.6) (AS-63).
- **FR-090**: State changes and the events that describe them commit in one transaction; rejected operations emit nothing (AS-64).
- **FR-091**: No network call to a provider happens inside an open database transaction (III.3); the callback performs the exchange first, then one transaction for resolution, wipe, link and outbox.
- **FR-092**: Events carry `eventId`, `type`, `version`, `occurredAt`, `aggregateId` and identifiers only (AS-64).
- **FR-093**: Security-relevant actions are audited and counted without secrets (AS-59, AS-60).
- **FR-100**: Errors are problem+json with stable codes: `validation_failed` 400, `invalid_token` 401, `invalid_mfa_code` 401, `invalid_mfa_challenge` 401, `csrf_invalid` 403, `origin_not_allowed` 403, `oidc_provider_not_found` 404, `identity_not_found` 404, `mfa_already_enabled` 409, `mfa_not_pending` 409, `mfa_not_enabled` 409, `last_login_method` 409, `unsupported_media_type` 415, `invalid_code` 422, `rate_limited` 429, `oidc_provider_unavailable` 503; any 5xx is generic (AS-61, AS-62).

### Key Entities

- **Second-factor enrolment** (one per user): `{state, sealed secret, pending expiry, enabledAt, last accepted time step, recovery-code digests with spent marks}`.
- **Challenge**: `{id, userId, firstFactor, expiry, attemptsLeft, spent}`; transported as a purpose-limited token (S01).
- **Federated identity**: `{id, userId, provider, subject, email hint, createdAt}`; unique `(provider, subject)` and `(userId, provider)`.
- **OIDC flow**: `{state, provider, purpose, userId?, verifier, nonce, returnPath, cookie digest, expiry}`; single-use, short-lived, never persisted beyond expiry.
- **Provider settings**: `{issuer, clientId, clientSecret, scope, trust}`; `trust` is `verified-email` (configured Google) or `subject-only` (registry).

### Consistency model (P0610)

Strong: single-use of time steps, recovery codes, flows and challenges (exactly one winner); factor state transitions; uniqueness of identities; the link-plus-wipe step. Bounded-stale: none beyond S01's access-token window (a session minted before a factor change keeps working until S01 revokes it; the account-linking wipe revokes explicitly). Eventual: events to other domains (outbox).

## Cross-capability contracts

Earlier specs searched: `specs/domains/S01-auth-sessions` (the only one naming `S02`; `specs/web` and `specs/journeys` do not exist yet). Every S01 requirement on S02 is honoured; where S02 needs an addition, it is raised as a `[CONTRACT]` line in `questions.md`.

**Provides** (exact names; exported from `@app/domains/identity` unless it is an HTTP endpoint):

- HTTP under `/api`, problem+json errors, contracts schemas in `packages/contracts`:
  - `GET /auth/mfa` → `{state: 'none'|'pending'|'enabled', enabledAt?: string, recoveryCodesRemaining?: number}` (`mfaStatusSchema`).
  - `POST /auth/mfa/enroll` → `{otpauthUri: string, manualEntryKey: string}` (`mfaEnrollSchema`).
  - `POST /auth/mfa/confirm {code}` → `{recoveryCodes: string[10]}` (`mfaRecoveryCodesSchema`).
  - `POST /auth/mfa/verify {mfaToken?: string, code: string, delivery?: 'body'|'cookie'}` → the S01 login result (`authSessionSchema`, `cookie` variant per S01 FR-050).
  - `POST /auth/mfa/recovery-codes/regenerate {code}` → `{recoveryCodes: string[10]}`; `POST /auth/mfa/disable {code}` → `204`.
  - `GET /auth/oidc/providers` → `{id: string, displayName: string}[]` (`oidcProviderSchema`); `POST /auth/oidc/:provider/start {returnTo?}` and `POST /auth/oidc/:provider/link/start {returnTo?, code?}` → `{authorizationUrl: string}` (`oidcStartSchema`); `GET /auth/oidc/:provider/callback` (browser redirect target; not a JSON API).
  - `GET /auth/identities` → `{id, provider, email: string|null, linkedAt}[]` (`federatedIdentitySchema`); `DELETE /auth/identities/:identityId` → `204`.
  - Front-end routes the callback redirects to (owned by W01): `/login?error=<code>`, `/login/mfa?returnTo=…`, the validated return path, and `<returnPath>?linked=google`.
- `SecondFactorService.isSecondFactorEnrolled(userId: UserId): Promise<boolean>` — true only for state `enabled`; consulted by S01 after a correct password (S01 FR-015).
- `OidcProviderRegistry` (R1): `registerResolver(prefix: string, resolver: (providerId: string) => Promise<OidcProviderSettings | undefined>): void`, `invalidate(providerId: string): void`; `OidcProviderSettings = { issuer: string; clientId: string; clientSecret: string; scope?: string }` (plain secret; the caller opens its own sealed value). The login URL for a registered provider is `POST /auth/oidc/<providerId>/start`. **Consumer: S03** (replaces `OidcService.setResolver` / `register`).
- Session `amr` values added to S01's claim: `fed`, `otp`, `rcv`, `mfa` (with S01's `pwd`); a session whose `amr` contains `mfa` has passed a second factor.
- Events (outbox → topic keyed by `userId`, envelope per FR-092): `identity.mfa_enabled` v1 `{userId}`; `identity.mfa_disabled` v1 `{userId, reason: 'user'|'account_linking'}`; `identity.mfa_recovery_code_used` v1 `{userId, remaining}`; `identity.mfa_recovery_codes_regenerated` v1 `{userId}`; `identity.federated_identity_linked` v1 `{userId, provider, linkMethod: 'login'|'email_match'|'explicit', passwordInvalidated, mfaReset}`; `identity.federated_identity_unlinked` v1 `{userId, provider}`; and S01's `identity.user_registered` v1 `{userId, role}` for Google-created accounts. **Consumers: S28** (security mails: factor on/off, recovery code used, sign-in method added or removed, account linked with password removed; resolves addresses with `UserDirectoryService`); **S03** may subscribe to `identity.user_registered` and `identity.federated_identity_linked` to provision shop membership for shop-IdP users.
- Rate-limit policies (declared in S50's registry): `auth.mfa.ip` 20/min per IP; `auth.mfa.account` 5 failures per 15 min per user ID, failures only, reset on success; `auth.oidc.ip` 30/min per IP; all fail-closed.

**Requires**:

- **S01** (`identity`, same domain): `SessionIssuer.issue({userId, amr, delivery, meta})` for every session S02 creates; `SessionIssuer.createChallenge({userId, firstFactor: 'pwd'|'fed'}): Promise<{token, jti}>` and `verifyChallenge(token): Promise<{userId, firstFactor, jti}>` (`typ: mfa+jwt`, `aud: mfa`, 5 min; S02 keeps single-use and attempt state keyed by `jti`) — an addition to S01's signatures, see `[CONTRACT]` in `questions.md`; `SessionRevocationService.revokeAllForUser(userId, reason)`; `SecretBox.seal/open(value, context)` with the context `mfa:<userId>`; `Firewall({ sensitive })`, `AuthenticatedUser` with `amr`; cookie delivery, CSRF check and origin check of S01 FR-050–FR-053; the user store for removing a password verifier inside S02's transaction; password login with `amr: ["pwd"]` and the S01 call to `isSecondFactorEnrolled`; S01 password reset not touching the factor.
- **S50**: the three policies above (`failMode: closed`, `Retry-After`).
- **S54**: global problem+json filter with `code`; request-ID header; trusted-proxy client IP; metrics registry; config validation at startup (Google client ID without secret, or a non-HTTPS redirect base other than localhost, fails startup); an outbound HTTP client port with timeouts, response-size limit and the SSRF guard of `infrastructure/net` (P0507), used for discovery, key-set and token requests.
- **S53**: `outbox.append(event)` inside identity's own transaction (IX.6).
- **S03**: registers `shop:` through `OidcProviderRegistry`, sets `enabled`/issuer/client and sealed secret per shop, owns membership provisioning; must stop using `OidcService`.
- **S28**: delivers the mails for the events above.
- **S48 / W01**: the OIDC callback sets cookies on the API's own host, so the web application and the API must be served from one origin (path-routed), or W01 uses the BFF's own session instead of OIDC cookie delivery; W01 renders `/login?error=<code>` and `/login/mfa`, starts flows with `POST …/start` then navigates to `authorizationUrl`, and keeps the challenge token out of URLs (it travels in the `__Host-mfa-challenge` cookie or in memory).

Cross-domain data used by S02: none. Identity depends on no other domain (domain-map §2); S02 reads nothing from another owner. The only cross-owner write is the outbox append (IX.6). Tenancy reaches identity only through `OidcProviderRegistry` (R1) and events (IV.3).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100 % of logins by accounts with an enabled second factor — by password or by Google — end without a session until a valid code is presented; zero sessions are issued otherwise.
- **SC-002**: A given authenticator code or recovery code is accepted at most once: 100 % of replays are refused, including simultaneous ones and after a service or cache restart.
- **SC-003**: An attacker can make at most 5 second-factor guesses per account per 15 minutes and at most 3 per challenge, regardless of source address.
- **SC-004**: 100 % of forged, replayed, expired, cross-browser or tampered Google callbacks end on the login page with a stable error code and no session; after the user approves at Google, 95 % of sign-ins complete within 3 seconds.
- **SC-005**: 100 % of accounts linked by e-mail that originated from password registration have no usable password, second factor or session from before the link.
- **SC-006**: A shop's enterprise IdP can never sign in as, link to, or alter an account outside its own subjects: 0 successful cross-account logins in the AS-56 attack.
- **SC-007**: A member can turn on the authenticator app and save their recovery codes in under 2 minutes.
- **SC-008**: Zero tokens, codes, secrets, `state`, `nonce` or verifiers appear in any URL, log line, error body or script-readable browser storage across the S02 flows.
- **SC-009**: Zero queries or imports from other domains touch identity's federated-identity or second-factor data (ownership and boundary checks report 0 findings).
- **SC-010**: An enabled factor is never weakened by a request that lacks a current code: 0 successful disable, reset or regeneration calls without one.

## Assumptions

- Decisions marked `[BREAKING]`/`[CONTRACT]`/`[LOCAL]` are listed one per line in `questions.md`; this spec adopts each default stated there.
- Only TOTP is offered as a factor; phishing-resistant passkeys (notes 05/02 §5) are acknowledged but not built. SMS is deliberately absent (SIM-swap weakness, same note).
- A provider's `email_verified` is trusted only for the configured Google provider. Registration e-mail ownership is never proven by S01, which is why linking an unproven account wipes it (FR-061).
- An account created or linked through Google has no password; it can add TOTP, link or unlink identities, but cannot gain a password in this capability (S01 password reset only serves accounts that have one). Unlinking its only identity is refused.
- Linking from a signed-in session requires a fresh code only when a factor is enabled. Users without a factor are exposed to a stolen session adding an attacker's Google identity; enabling the factor is the mitigation, and a general "re-authenticate" challenge is out of scope.
- The OIDC callback issues cookies, so the browser must reach the API on the web application's origin (S48/W01 contract above). Bearer-body OIDC delivery is not offered.
- Google profile data (name, picture) is neither requested beyond the `profile` scope nor stored; only the subject and the e-mail hint are kept.
- Google's `hd` and other proprietary claims are ignored.
- Per-attempt limits (3 per challenge, 5 per 15 min per account) trade availability for safety: an attacker can lock a victim's second-factor step for 15 minutes; this is bounded by the window and by the per-IP limit.
- Recovery codes are the only recovery path: an account that loses both authenticator and codes needs support, which is outside this capability.
- Provider keys and discovery are fetched over the platform's resilient client; retries (≤ 3, backoff with jitter) apply to discovery and key-set GETs only, never to the code exchange.
- Tests replace only system-edge dependencies: the identity provider (a fake that signs ID tokens and can inject delays and failures), the outbound client's DNS resolution (for the SSRF cases), mail transport and the clock.
