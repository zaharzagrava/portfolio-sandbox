# Feature Specification: S01 — Registration, Password Login, Sessions, Refresh-Token Rotation, JWKS, Service-to-Service Tokens

**Capability**: S01 · **Domain**: `identity` · **Spec directory**: `specs/domains/S01-auth-sessions`

**Created**: 2026-10-05

**Status**: Draft

**Input**: "Registration, password login, sessions, refresh-token rotation, JWKS, service-to-service tokens (domain `identity`)", sources `SD-39-auth-sso`, `05-Security/02-authentication-authorization`, `05-Security/01-web-security-xss-csrf-csp`.

Companion files: [`questions.md`](questions.md) (decisions taken unattended, tagged), [`test-plan.md`](test-plan.md) (constitution VII.8 table), [`gaps.md`](gaps.md) (what today's code lacks, debt rows, IX.7 replacements).

## Scope

In scope: account registration; password login with brute-force protection; short-lived access tokens; opaque refresh tokens with rotation and reuse detection; server-side sessions and instant revocation; credential delivery to browsers (HttpOnly cookies, CSRF defence) and to non-browser clients (response body); the public key set (JWKS) with key rotation; audience-scoped service-to-service tokens; password reset; envelope encryption of stored secrets; the identity facilities other domains call (user directory, session revocation, principal resolution, events).

Out of scope (owned elsewhere or deliberately not built):

- TOTP enrolment/verification, recovery codes, Google/OIDC login, account linking → **S02**. S01 only provides the seam they plug into (see Cross-capability contracts).
- Shops, memberships, roles-per-shop, per-shop SSO → **S03**. S01 knows only the platform role of a user (`USER`, `SELLER`, `MODERATOR`, `ADMIN`).
- Browser session cookie of the BFF, GraphQL, per-request token forwarding → **S48**.
- Rate-limit algorithms and the problem+json filter themselves → **S50**, **S54**. S01 chooses which named policies guard which endpoint.
- Email verification, e-mail change, CAPTCHA, WebAuthn, "re-authenticate for sensitive actions" challenge: not built (see Assumptions).
- The legacy `admin` external-DB-sync tool and the empty `users` controller/service: not part of this capability (see `gaps.md`).

## User Scenarios & Testing *(mandatory)*

Every acceptance scenario has a stable ID `AS-nn`; `test-plan.md` maps each to exactly one row. Defaults referenced below are listed under *Defaults* in Requirements.

### User Story 1 — Create an account without revealing who already has one (Priority: P1)

A visitor registers with e-mail and password. The response is the same whether or not the address is already registered, so nobody can use the form to discover members. The new member then logs in (User Story 2).

**Why this priority**: nothing else works without accounts; the uniform response is a binding rule (constitution V.4).

**Independent Test**: call register twice with the same address and compare the two responses; inspect the persisted accounts.

**Acceptance Scenarios**:

1. **AS-01** — **Given** no account for `new@example.com`, **When** `POST /api/auth/register` is sent with `{email: "  New@Example.COM ", password: <valid 12+ char password>}`, **Then** the response is `202` with body `{"status":"accepted"}` and no tokens, no cookies; exactly one user exists with email `new@example.com`, role `USER`, and a stored password verifier in Argon2id format with the parameters of FR-012; no session exists; exactly one outbox event `identity.user_registered` v1 exists whose payload contains only `eventId, type, version, occurredAt, aggregateId (= userId), userId, role` (no email, no password data).
2. **AS-02** — **Given** an account for `new@example.com` with password P1, **When** register is sent for `new@example.com`, `NEW@example.com`, and `" new@example.com "` with password P2, **Then** each response is `202` with a byte-identical body and the same headers as AS-01 (apart from request-specific ones); no second user exists; P1 still logs in and P2 does not; one outbox event `identity.registration_duplicate_attempted` v1 `{userId = existing id}` is written per request.
3. **AS-03** — **Given** no account, **When** two registrations for the same address with different passwords run simultaneously, **Then** both receive `202`; exactly one user exists; exactly one `identity.user_registered` and one `identity.registration_duplicate_attempted` event exist; the stored password verifies against exactly one of the two submitted passwords; and a direct insert of the same address in a different letter case is rejected by the data store itself.
4. **AS-04** — **Given** the registration form, **When** `role` is omitted, `USER`, or `SELLER`, **Then** the account gets `USER`, `USER`, or `SELLER`; **When** `role` is `ADMIN` or `MODERATOR`, or the body carries any unknown field (e.g. `isAdmin: true`), **Then** the response is `400` `validation_failed` naming the offending field and nothing is persisted.
5. **AS-05** — **Given** the registration form, **When** the email is missing, not a string, not an address, empty, or longer than 254 characters, or the password is missing, not a string, shorter than 12, or longer than 128 characters, **Then** each case returns `400` `validation_failed` with a per-field error list, the response body does not contain the submitted password, and no user, event or hash computation results.
6. **AS-06** — **Given** a password found in the breached-password corpus (fake corpus client), **When** registering — for a new and for an already-registered address alike — **Then** the response is `422` `weak_password` in both cases and nothing is persisted.
7. **AS-07** — **Given** the corpus client times out (800 ms) or fails, **When** a valid registration is sent, **Then** it proceeds (`202`), the account is created, and the counter `auth_breach_check_skipped_total` increases by 1.
8. **AS-08** — **Given** a new and an existing address, **When** each is registered, **Then** exactly one password hash computation happens per request in both cases (equal work, so latency does not reveal membership).
9. **AS-09** — **Given** a client IP that already made 10 registration requests in the last hour, **When** it sends an 11th, **Then** the response is `429` `rate_limited` with a `Retry-After` header and no user or event is created.

### User Story 2 — Log in with a password, safely (Priority: P1)

A member logs in and receives an access token (valid 5 minutes) and a refresh token. Wrong guesses are slowed per account and per IP, and failures look identical whether or not the account exists. Old password hashes are upgraded transparently.

**Why this priority**: the primary entry point and the main attack surface.

**Independent Test**: log in with right and wrong credentials for known and unknown addresses; hammer one address.

**Acceptance Scenarios**:

1. **AS-10** — **Given** a registered user and a client with no cookie delivery requested, **When** `POST /api/auth/login` is sent with the right credentials, **Then** the response is `200` with `{accessToken:{token, expiresIn:300}, refreshToken, sessionId, user:{id, email, role}}`, headers `Cache-Control: no-store` and no `Set-Cookie`; the access token satisfies FR-021; one session exists for the user with the request's (truncated) device string and client IP; the stored refresh credential is a one-way digest, not the token.
2. **AS-11** — **Given** one registered and one unregistered address, **When** login is attempted with a wrong password for the first and any password for the second, **Then** both return `401` with identical `type`, `title`, `detail`, `code: invalid_credentials`, and exactly one password verification (against a real or placeholder hash) was performed in each case.
3. **AS-12** — **Given** an address (registered or not), **When** 5 failed logins for it occur within 15 minutes from different IPs, **Then** the 6th attempt — even with the right password — returns `429` `rate_limited` with `Retry-After` > 0, and the response for an unregistered address is identical in shape to that for a registered one.
4. **AS-13** — **Given** 4 failed logins for an address, **When** a login with the right password succeeds, **Then** the failure counter for that address is reset: 4 further failures are accepted before throttling starts.
5. **AS-14** — **Given** one client IP, **When** it sends 20 login requests within a minute (any addresses), **Then** the 21st returns `429` `rate_limited` with `Retry-After`.
6. **AS-15** — **Given** a client that rotates the `CF-Connecting-IP`, `X-Forwarded-For`, `X-Real-IP` request headers on every request, **When** it sends 21 login attempts within a minute from the same TCP peer, **Then** the 21st is still `429` (the headers have no effect unless the peer is a configured trusted proxy).
7. **AS-16** — **Given** a user whose stored hash is (a) bcrypt, (b) Argon2id with outdated parameters, **When** the user logs in with the right password, **Then** login succeeds and the stored hash becomes Argon2id with current parameters (conditional on the old hash being unchanged); **When** the password is wrong, **Then** `401` and the stored hash is unchanged.
8. **AS-17** — **Given** the password verifier component, **When** `verify` is called with: valid Argon2id current params; valid Argon2id old params; valid bcrypt (cost 10 and 12); wrong password for each; null hash; malformed hash, **Then** results are respectively `{valid:true, needsRehash:false}`, `{true,true}`, `{true,true}`×2, `{false,false}`×3, `{false,false}` (with real work performed for null), `{false,false}` without throwing.
9. **AS-18** — **Given** hashing concurrency limit 2 and queue limit 2, **When** 5 hash operations are submitted at once, **Then** 2 run, 2 wait, the 5th is rejected with `overloaded` (mapped to `503` with `Retry-After: 1`); and a configuration whose concurrency limit exceeds the runtime worker-pool size minus one fails at startup.
10. **AS-19** — **Given** a user whose second factor is enrolled (seeded), **When** the right password is submitted, **Then** the response is `200` `{mfaRequired:true, mfaToken}` (challenge valid 5 minutes), no session and no refresh credential exist, and no `Set-Cookie` is sent.
11. **AS-20** — **Given** a client already holding a valid access token for session S1, **When** it logs in again (same or another user), **Then** a new session S2 ≠ S1 is created and S1 is unaffected (no session ID is ever reused).
12. **AS-21** — **Given** the login form, **When** the password is longer than 128 characters, **Then** `400` without any hash computation; **When** the password is a wrong 5-character string, **Then** `401` (login never applies the registration password policy); **When** the JSON body exceeds 16 KB, **Then** `413`; and missing/non-string fields return `400`.
13. **AS-22** — **Given** the policy table for the S01 endpoints, **Then** every authentication-related policy (`auth.register.ip`, `auth.login.ip`, `auth.login.account`, `auth.refresh.ip`, `auth.reset.ip`, `auth.reset.account`) is declared fail-closed with the limits of FR-017.

### User Story 3 — Every service verifies tokens locally and strictly (Priority: P1)

Each request carries an access token. Verification needs no call to identity, checks every claim, and rejects every forged, confused or stale token the notes warn about.

**Why this priority**: it is the hot path of the whole platform (100k authenticated requests per second target).

**Independent Test**: feed the verifier tokens mutated one claim at a time.

**Acceptance Scenarios**:

1. **AS-23** — **Given** a key set and a frozen clock, **When** the verifier is given each of: a valid token; a token 3 s past `exp` (within the 5 s tolerance); 6 s past `exp`; `nbf` 3 s ahead; `nbf` 60 s ahead; `alg: none`; an HS256 token whose secret is the public key bytes; an RS256-labelled token with an ES256 `kid`; an unknown `kid`; `kid` values `../../etc/passwd`, `' OR 1=1 --`, an empty string, a 300-char string; no `kid`; wrong `iss`; wrong `aud`; missing `aud`; `typ: mfa+jwt`; `typ: svc+jwt`; `typ` absent; missing `sub`; missing `sid`; a `sub` that is not a UUID; a token signed by a different key with a correct `kid`; a 9 KB token, **Then** only three cases are accepted (the valid token, the token 3 s past `exp`, the token with `nbf` 3 s ahead) and every other case is rejected with a single generic `invalid_token` reason, without performing any store lookup (the verifier has no store dependency), and without throwing for malformed input.
2. **AS-24** — **Given** a protected route, **When** the request carries (a) `alg: none`, (b) an unknown `kid`, (c) an expired token, **Then** the three responses are `401` with identical body (same `type`, `title`, `detail`, `code: invalid_token`) apart from `requestId`, and none contains the word "expired", "signature", "kid" or any library message.
3. **AS-25** — **Given** a valid token for user A, **When** the request also carries `X-User-Id: B`, `X-Tenant-Id: T`, `X-Forwarded-User: B`, **Then** the principal is A; **When** the same headers are sent without a token, **Then** `401`.
4. **AS-26** — **Given** a valid access token, **When** it is presented only in a legacy channel (`x-auth-token` header, `x-auth-token` cookie, query string `?token=`), **Then** `401`; only `Authorization: Bearer` and (FR-050) the `__Host-access` cookie are accepted.
5. **AS-27** — **Given** a logged-out session whose access token has not expired, **When** it calls a sensitive route, **Then** `401` immediately; **When** it calls an ordinary route, **Then** it is still accepted until `exp` (≤ 300 s), which is the documented staleness bound.
6. **AS-28** — **Given** a user whose role is changed `USER → ADMIN` in the store while holding an access token minted before, **When** the old token is used, **Then** the principal still carries `USER`; **When** the user refreshes, **Then** the new access token carries `ADMIN`.
7. **AS-29** — **Given** each protected endpoint of S01 (`logout`, `logout-all`, `sessions`, `sessions/:id`, `me`), **When** called without any credential, **Then** `401` `invalid_token` problem+json.
8. **AS-30** — **Given** no token and an invalid body on a protected route, **Then** the response is `401` (not `400`); **Given** an IP over the login limit and an invalid body, **Then** `429` (not `400`): authentication and throttling run before validation.

### User Story 4 — Stay logged in; a stolen refresh token dies on first reuse (Priority: P1)

Clients exchange a refresh token for a new access token. Every exchange returns a new refresh token and spends the old one. Presenting a spent token means theft: the session is revoked.

**Why this priority**: it is what makes short-lived access tokens usable and revocation real.

**Independent Test**: refresh once, then replay the old token.

**Acceptance Scenarios**:

1. **AS-31** — **Given** a session with refresh token T1, **When** `POST /api/auth/refresh` `{refreshToken: T1}`, **Then** `200` with a new access token and refresh token T2 ≠ T1 for the same `sessionId`, `Cache-Control: no-store`; T1 is spent; the session's last-used time is updated; only T2's digest is stored.
2. **AS-32** — **Given** T1 was exchanged for T2, **When** T1 is presented again (any time), **Then** `401` `invalid_refresh_token`; the session is revoked (T2 now also yields `401`, sensitive routes reject the session's access tokens, the session shows revoked reason `refresh_token_reuse`); the user's other sessions remain valid; one audit event `auth.refresh.reuse_detected` and the counter `auth_refresh_reuse_total` +1 are recorded.
3. **AS-33** — **Given** T1, **When** two refresh requests with T1 run at exactly the same time, **Then** exactly one returns `200` and the other `401`; exactly one successor token was ever stored; the winner's successor is subsequently rejected too (the reuse revoked the session).
4. **AS-34** — **Given** no refresh token, a random 43-char string, a token of another session after logout, **Then** `401` `invalid_refresh_token` with identical bodies and no side effects; **Given** a value longer than 256 characters, **Then** `400` `validation_failed`.
5. **AS-35** — **Given** a frozen clock, **When** a refresh token is presented 30 days minus 1 s after its issue, **Then** `200`; **When** 30 days plus 1 s after, **Then** `401` and the session is not marked as compromised (no reuse audit event).
6. **AS-36** — **Given** a session created at day 0 and refreshed at day 29, 58 and 87, **When** a refresh is attempted at day 90 plus 1 s, **Then** `401` although the latest token is younger than 30 days; a refresh at day 89 returns a token whose expiry is capped at day 90.
7. **AS-37** — **Given** a valid refresh token, **When** its user was soft-deleted, or `logout-all` completed earlier, **Then** `401` `invalid_refresh_token` and (for the deleted user) the session is revoked.
8. **AS-38** — **Given** an IP that sent 60 refresh requests in a minute, **When** it sends a 61st, **Then** `429` `rate_limited` with `Retry-After` and the presented token is not consumed.

### User Story 5 — See and end my sessions (Priority: P2)

A member lists the devices that are logged in, logs out the current one, one other, or all of them. Other domains can end all sessions of a user (ban, offboarding).

**Why this priority**: instant revocation is the reason sessions exist next to JWTs.

**Independent Test**: create three sessions, list, revoke one, revoke all.

**Acceptance Scenarios**:

1. **AS-39** — **Given** a user with 3 active and 1 revoked session, and another user with sessions, **When** `GET /api/auth/sessions`, **Then** `200` lists only the caller's 3 active sessions newest first, each exactly `{sessionId, device, ip, createdAt, lastUsedAt, current}` (one has `current: true`); no user ID, token digest, family or storage key appears; the response parses with the contracts schema.
2. **AS-40** — **Given** user B's session S_B, **When** user A calls `DELETE /api/auth/sessions/S_B`, **Then** `404` problem+json identical to the response for a non-existent ID, and S_B stays active.
3. **AS-41** — **Given** user A with sessions S1 (current) and S2, **When** A calls `DELETE /api/auth/sessions/S2`, **Then** `204`, S2's refresh token yields `401`, S1 remains valid; deleting S1 behaves as logout.
4. **AS-42** — **Given** a valid access token, **When** `POST /api/auth/logout` is called twice with it, **Then** both return `204`; the session is revoked with reason `logout` and the revoked-at time of the first call is unchanged by the second; its refresh token yields `401`.
5. **AS-43** — **Given** a user with 3 sessions, **When** `POST /api/auth/logout-all` is called, **Then** `200 {revokedSessions: 3}`, every refresh token yields `401`, sensitive routes reject all their access tokens; a second call returns `{revokedSessions: 0}`; another user's sessions are untouched.
6. **AS-44** — **Given** a user with 20 active sessions, **When** a 21st login succeeds, **Then** the oldest session is revoked with reason `session_limit`, 20 remain active, and the evicted session's refresh token yields `401`.
7. **AS-45** — **Given** an exported-service call `SessionRevocationService.revokeAllForUser(userId, "admin_ban")`, **Then** it returns the number of sessions revoked, each session records the reason, and the user's refresh tokens yield `401`.

### User Story 6 — Browser sessions held in HttpOnly cookies, protected against CSRF (Priority: P2)

A browser that talks to the API directly (for example after an OIDC redirect, S02) can ask for cookie delivery: no token ever reaches page scripts, and every state-changing request is CSRF-protected, login and logout included.

**Why this priority**: constitution VI.2; the notes' recommended browser storage.

**Independent Test**: cookie login, then forged and genuine state-changing requests.

**Acceptance Scenarios**:

1. **AS-46** — **Given** a login request with `{delivery: "cookie"}` from an allowed origin, **When** the credentials are right, **Then** `200` with `{sessionId, user, accessTokenExpiresIn}` and no token in the body, and three cookies: `__Host-access` and `__Host-refresh` (`HttpOnly; Secure; SameSite=Lax; Path=/`, no `Domain`, `Max-Age` = their lifetime) and `__Host-csrf` (`Secure; SameSite=Lax; Path=/`, no `Domain`, **not** HttpOnly).
2. **AS-47** — **Given** a cookie-authenticated session, **When** a state-changing request (`POST /api/auth/logout`) is sent without the `X-CSRF-Token` header, **Then** `403` `csrf_invalid` and the session is still active.
3. **AS-48** — **Given** a cookie-authenticated session, **When** the request carries `X-CSRF-Token` equal to the `__Host-csrf` cookie, **Then** it succeeds; **When** the token and cookie are equal but were issued for a different session, **Then** `403` (see AS-53 for the pure token cases).
4. **AS-49** — **Given** a request authenticated by `Authorization: Bearer` (no ambient credential), **When** it changes state without any CSRF header, **Then** it succeeds.
5. **AS-50** — **Given** a cookie-authenticated state-changing request with a valid CSRF token, **When** `Origin` is `https://evil.example`, **Then** `403` `origin_not_allowed`; **When** `Origin` is absent and `Sec-Fetch-Site: cross-site`, **Then** `403`; **When** `Origin` is the allowed front-end origin, **Then** it succeeds.
6. **AS-51** — **Given** cookie delivery requested, **When** login is sent with `Origin: https://evil.example`, **Then** `403` `origin_not_allowed`, no `Set-Cookie` header, and no session is created (login CSRF).
7. **AS-52** — **Given** an HTML form post (`Content-Type: application/x-www-form-urlencoded` or `text/plain`) to login, register or refresh, **Then** `415` `unsupported_media_type`, nothing is processed.
8. **AS-53** — **Given** the CSRF token verifier, **When** given: a token issued for the session; a token for another session; a tampered random part; a tampered MAC; a truncated token; an empty header; header ≠ cookie; an upper-cased valid token; a token with a different secret, **Then** only the first is accepted, comparison is constant-time, and nothing throws.
9. **AS-54** — **Given** a session with only the `__Host-refresh` and `__Host-csrf` cookies (access cookie expired), **When** `POST /api/auth/refresh` is sent with a valid CSRF header and no body token, **Then** `200`, the three cookies are re-set with a rotated refresh token, and the body contains no token; **When** the CSRF header is missing, **Then** `403` and the refresh token is **not** consumed (a later valid request succeeds).
10. **AS-55** — **Given** a cookie session, **When** `POST /api/auth/logout` succeeds with a valid CSRF token, **Then** `204` and all three cookies are cleared (`Max-Age=0`, same attributes).
11. **AS-56** — **Given** `GET /api/auth/logout`, `GET /api/auth/logout-all`, `GET /api/auth/refresh`, **Then** each returns `404`/`405` and no session changes (GET never changes state).
12. **AS-57** — **Given** login (body delivery), cookie login, refresh, and the MFA challenge response, **Then** each carries `Cache-Control: no-store` and `Pragma: no-cache`.

### User Story 7 — Anyone can verify our tokens; keys rotate without outages (Priority: P2)

The edge and other services fetch a public key set and verify tokens by `kid`. Keys rotate on a schedule: the next key is published a day before it signs, and the old key stays published until its tokens have expired.

**Why this priority**: removes identity from the hot path and limits the blast radius of a leaked key.

**Independent Test**: fetch the key set, verify a token with a stock JOSE library, run a rotation.

**Acceptance Scenarios**:

1. **AS-58** — **Given** keys in states ACTIVE, NEXT and RETIRED, **When** `GET /.well-known/jwks.json` (outside the `/api` prefix, no credential), **Then** `200` JSON `{keys:[…]}` with one entry per key in those states, each exactly `{kty:"EC", crv:"P-256", x, y, kid, alg:"ES256", use:"sig"}` and no private member; headers `Cache-Control: public, max-age=300, stale-while-revalidate=3600` and an `ETag`; a request with the matching `If-None-Match` gets `304`; the body parses with the contracts schema.
2. **AS-59** — **Given** an access token from login, **When** a stock JOSE verifier is configured only with the JWKS URL and `algorithms: ["ES256"]`, `issuer`, `audience`, **Then** verification succeeds without any other input.
3. **AS-60** — **Given** an environment with no signing key, **When** 10 logins arrive concurrently, **Then** all succeed, exactly one ACTIVE key exists and all ten tokens carry its `kid`.
4. **AS-61** — **Given** ACTIVE age ≥ 7 days and NEXT age ≥ 24 h, **When** the rotation job runs, **Then** NEXT becomes ACTIVE, the former ACTIVE becomes RETIRED with a retirement time, a new NEXT is created; tokens signed by the former ACTIVE still verify; new logins carry the new `kid`; JWKS lists all three.
5. **AS-62** — **Given** the rotation decision function and a frozen clock, **When** given: no keys; ACTIVE only; ACTIVE age 6 d 23 h with NEXT 2 d; ACTIVE 7 d with NEXT 23 h 59 m; ACTIVE 7 d with NEXT 24 h; two NEXT keys; RETIRED 23 h 59 m; RETIRED 24 h 1 m, **Then** the decisions are respectively `create ACTIVE`, `create NEXT`, `none`, `none`, `promote`, `none (keep newest)`, `keep`, `purge`.
6. **AS-63** — **Given** a RETIRED key retired more than 24 h ago, **When** the rotation job runs, **Then** the key disappears from the store and JWKS and tokens it signed yield `401`; a RETIRED key retired 23 h ago is kept.
7. **AS-64** — **Given** two rotation runs started at the same moment, then **Given** a third run immediately after, **Then** the final state has exactly one ACTIVE and exactly one NEXT, no run fails with an unhandled error, and the third run changes nothing.
8. **AS-65** — **Given** the key-set cache policy with a frozen clock, **When** 100 verifications with unknown `kid`s occur within 30 s, **Then** at most one forced reload from the store happens; a reload happens again after 30 s; a `kid` that appears after the reload verifies.
9. **AS-66** — **Given** a stored signing key, **Then** the persisted private-key field contains no readable key material (not parseable as a key, does not contain `PRIVATE KEY`) and cannot be opened with a different master key.
10. **AS-67** — **Given** the secret sealing component, **When** given: round trip; tampered ciphertext, IV, tag, or version; sealed with context "A" opened with context "B"; sealed with the previous master key and opened while current + previous are configured; an unknown version; starting in production without a master key, **Then** only the round trips with matching context/keys succeed, tampering and mismatches throw, and production start fails.

### User Story 8 — Services prove who they are to each other (Priority: P2)

A service calling another internal endpoint presents a short-lived token naming itself and the intended recipient. The recipient accepts only tokens meant for it, from callers it allows for that endpoint. A user's token is never forwarded.

**Why this priority**: closes the "replay a user's token to a service it was never meant for" threat (constitution IV.7).

**Independent Test**: mint a token for audience X and present it to audience Y.

**Acceptance Scenarios**:

1. **AS-68** — **Given** caller `worker`, **When** `ServiceTokenService.mint({caller:"worker", audience:"core"})`, **Then** the token has `typ: svc+jwt`, `alg: ES256`, a `kid` in JWKS, `iss: marketplace`, `sub: svc:worker`, `aud: core`, `exp − iat = 60`, a unique `jti`, and no `role`, `sid` or e-mail claim.
2. **AS-69** — **Given** an internal endpoint declared for audience `core` allowing callers `worker` and `billing`, **When** requests present: a valid token from `worker`; a token for audience `billing-api`; a valid token from caller `projector`; an expired token; a user access token; no token, **Then** results are `200` (principal `{kind:"service", caller:"worker"}`), `401`, `403` `service_caller_not_allowed`, `401`, `401`, `401`.
3. **AS-70** — **Given** a user access token with a live session, **When** `ServiceTokenService.exchange({userAccessToken, caller:"core", audience:"worker"})`, **Then** the result has `sub = userId`, `act: {sub:"svc:core"}`, `sid`, `aud: worker`, `exp − iat = 60`, and the endpoint principal exposes `onBehalfOf: {userId, sessionId}`; **When** the user's session was revoked, **Then** the exchange throws and no token is minted.
4. **AS-71** — **Given** the mint policy, **When** an audience outside the configured allowlist, a TTL of 301 s, a TTL of 0, or an empty caller is requested, **Then** each is rejected; a TTL of 300 s is accepted.
5. **AS-72** — **Given** the minted-token cache with a frozen clock, **When** the same `(caller, audience)` is requested at t = 0 s, 47 s, 49 s, **Then** the first two return the same token and the third a fresh one (reuse until 80 % of lifetime); different audiences never share a token.

### User Story 9 — Recover a forgotten password without leaking membership (Priority: P3)

A member who forgot the password asks for a reset link; the answer is the same for every address. The link works once, within 30 minutes, and ends every session.

**Why this priority**: required by the notes' anti-enumeration rules and by the account UI (W01).

**Independent Test**: request for known and unknown addresses; confirm; replay.

**Acceptance Scenarios**:

1. **AS-73** — **Given** a user with a password, a user without a password (social-only), and an unknown address, **When** `POST /api/auth/password-reset/request` is sent for each, **Then** all return `202 {"status":"accepted"}` with identical headers/body; only the first causes one outbox message `identity.password_reset_requested` v1 with `{eventId, userId, resetToken, expiresAt = now + 30 min}`; only the digest of the token is stored.
2. **AS-74** — **Given** an outstanding reset token R1, **When** a second request is made for the same user, **Then** a new token R2 is issued and R1 no longer works.
3. **AS-75** — **Given** a valid token and a policy-compliant new password, **When** `POST /api/auth/password-reset/confirm` `{token, password}`, **Then** `204`; the stored hash is Argon2id of the new password; the token is spent; every session of the user is revoked (reason `password_reset`); the old password fails and the new one logs in; one outbox event `identity.password_changed` v1 `{userId}` exists.
4. **AS-76** — **Given** a token that is unknown, already used, or older than 30 min plus 1 s, **When** confirm is sent, **Then** each returns `400` `invalid_reset_token` with identical bodies; **Given** a valid token with a breached or too-short password, **Then** `422` `weak_password` / `400` `validation_failed` and the token is **not** consumed.
5. **AS-77** — **Given** one valid token, **When** two confirm requests with different new passwords run simultaneously, **Then** exactly one returns `204`, the other `400` `invalid_reset_token`, and the stored password verifies against the winner's.
6. **AS-78** — **Given** limits per IP (5 requests/hour for request, 10/hour for confirm) and per address (3 requests/hour), **When** exceeded — for a registered and an unregistered address alike — **Then** `429` `rate_limited` with `Retry-After`, identical in shape for both.

### User Story 10 — Other domains use identity without touching its tables (Priority: P3)

Domains needing a user's e-mail or role call an exported service with batch methods; domains reacting to sign-ups subscribe to events. Nobody reads or joins `User`.

**Why this priority**: pays debt D-7/D-12 for identity (constitution IX.7 R1).

**Independent Test**: call the directory with a mix of known and unknown IDs.

**Acceptance Scenarios**:

1. **AS-79** — **Given** users A, B and a soft-deleted user C, **When** `UserDirectoryService.getUsersByIds([A, B, C, unknownId])` is called, **Then** a map with entries for A and B only, each `{id, email, role, createdAt}` with no password, second-factor or token field, using a single read; **When** more than 500 IDs are passed, **Then** it throws `TooManyIds`.
2. **AS-80** — **Given** user A with email `a@example.com`, **When** `UserDirectoryService.findByEmail("  A@Example.com ")`, **Then** A's summary; for an unknown address `null`.
3. **AS-81** — **Given** the `identity` code and the other domains, **When** the ownership and boundary checks run in strict mode, **Then** the ownership check reports 0 findings that read, join, associate or inject `User`, `FederatedIdentity` or `SigningKey` outside identity, and no domain imports identity models or `infra/`.

### User Story 11 — Operators can see and trust what happens (Priority: P3)

Security-relevant events are logged and counted without secrets; errors are uniform and safe.

**Acceptance Scenarios**:

1. **AS-82** — **Given** a login failure, a session creation, a revocation, a reuse detection, a key rotation, a reset request and completion, a duplicate registration, **Then** each produces one structured audit line with an event name, `requestId`, `userId`/`sessionId` when known and never an e-mail, password, token or hash (failures for unknown accounts carry a keyed hash of the address); metric counters exist with bounded labels (`result`, `reason`, `endpoint`).
2. **AS-83** — **Given** a full register → login → refresh → logout → reset flow with a log capture, **Then** no log line contains the submitted password, any access/refresh/reset/CSRF token, or a password hash.
3. **AS-84** — **Given** each S01 error class, **Then** the response parses with the shared problem schema (`type`, `title`, `status`, `detail`, `instance`, `requestId`) plus the stable `code` of FR-100, and `requestId` equals the response's request-ID header.
4. **AS-85** — **Given** a corrupted active signing key (unreadable private key), **When** a user logs in with the right password, **Then** the response is `500` with a generic `detail`, no stack, SQL or key text; no usable session exists afterwards (none persisted or the new one revoked); the failure is logged server-side with the same `requestId`.
5. **AS-86** — **Given** a buyer in the browser, **When** they register, log in, see their account, open the sessions list, log out another device and log out, **Then** each step succeeds and the browser's script-readable storage never contains an access or refresh token (happy-path journey, owned by W01).

### Edge Cases

Each edge case is covered by the scenario shown; none is left to implementation judgement.

- Same address in different case or with whitespace → AS-02, AS-03. Simultaneous duplicate → AS-03.
- Role escalation by body field → AS-04. Oversized/ malformed inputs → AS-05, AS-21, AS-34.
- Enumeration through status, body, headers, timing, throttling → AS-02, AS-08, AS-11, AS-12, AS-73, AS-78.
- Brute force, credential stuffing, spoofed client IP → AS-12 to AS-15.
- Hash upgrade without forced reset; hash overload → AS-16 to AS-18.
- Algorithm confusion, `alg: none`, `kid` injection, wrong issuer/audience/type, clock skew → AS-23, AS-24.
- Trusting identity headers; legacy credential channels → AS-25, AS-26.
- Revoked but unexpired token; role change in flight → AS-27, AS-28.
- Refresh replay, concurrent refresh, expiry (idle and absolute), deleted user → AS-32 to AS-37.
- Cross-user session access (IDOR) → AS-40. Idempotent logout and logout-all → AS-42, AS-43. Session limit → AS-44.
- CSRF with missing/forged token, cross-origin, login CSRF, form posts, GET side effects, cookie tossing → AS-47 to AS-56.
- Key rotation timing, concurrent rotation, retention, kid-spray → AS-61 to AS-65.
- Token for the wrong audience, caller not allowed, replay of a user token to a service → AS-69, AS-70.
- Reset token reuse, expiry, concurrent confirm → AS-75 to AS-77.
- Duplicate or reordered events: identity emits events through the outbox and consumes none; at-least-once delivery and consumer idempotency belong to the consumers (S28) and the event infrastructure (S53). Events carry a stable `eventId` so consumers can deduplicate (FR-094).
- Timeouts: breach-corpus lookup 800 ms (AS-07); all other outbound calls inherit platform timeouts (S54).

## Requirements *(mandatory)*

### Defaults

Access token lifetime 300 s. Refresh token idle lifetime 30 days; session absolute lifetime 90 days. Max active sessions per user 20. Clock tolerance 5 s. Login limits: 20/min/IP; 5 failures/15 min/address. Register: 10/hour/IP. Refresh: 60/min/IP. Reset request: 5/hour/IP and 3/hour/address; confirm 10/hour/IP. Reset token lifetime 30 min. Service token lifetime 60 s (max 300 s). Retired keys published ≥ 24 h after retirement; NEXT published ≥ 24 h before activation; ACTIVE key age before promotion ≥ 7 days. JWKS max-age 300 s. Password length 12–128. Hash concurrency 4, queue 64. Max auth request body 16 KB. All are configuration values with these defaults.

### Functional Requirements

**Registration**

- **FR-001**: Registration MUST respond `202 {"status":"accepted"}` with identical body and headers whether the address is new or taken (AS-01, AS-02), and MUST create no session.
- **FR-002**: Addresses MUST be trimmed and lower-cased before use; uniqueness MUST be case-insensitive and enforced by the data store, so concurrent registrations create exactly one account (AS-03). Lookups by address use a case-insensitive unique index (P0305).
- **FR-003**: A registration for an existing address MUST NOT change the existing account and MUST emit `identity.registration_duplicate_attempted`; a new account MUST emit `identity.user_registered`; each event is written in the same transaction as the state change it describes, via the outbox, with the envelope of FR-094 (AS-01, AS-02, AS-03).
- **FR-004**: Self-selectable roles are `USER` (default) and `SELLER`; `ADMIN`/`MODERATOR` and unknown fields MUST be rejected (AS-04).
- **FR-005**: Password policy: 12–128 characters, not equal to the address, not found in the breached-password corpus. Policy errors MUST be independent of whether the account exists (AS-05, AS-06).
- **FR-006**: The breached-password check MUST go through a port with an 800 ms timeout, fail open on timeout/outage and count the skip (AS-07).
- **FR-007**: New and duplicate registrations MUST perform the same hashing work (AS-08).
- **FR-008**: Registration is throttled per IP (AS-09).
- **FR-009**: Validation failures return `400 validation_failed` with per-field errors that never echo secrets (AS-05).

**Login & password storage**

- **FR-010**: Login MUST return the same `401 invalid_credentials` for unknown address and wrong password, with equal work (AS-11).
- **FR-011**: Failed attempts MUST be throttled per address (5 per 15 minutes, counted by the submitted address whether or not it exists, reset on success) and per IP (20 per minute) with `429` + `Retry-After` (AS-12, AS-13, AS-14).
- **FR-012**: Passwords MUST be stored as Argon2id (m = 19 MiB, t = 2, p = 1). Bcrypt and outdated Argon2id hashes MUST verify and be upgraded on the next successful login, conditional on the stored hash being unchanged (AS-16, AS-17). A placeholder hash with the same cost is verified when no account exists.
- **FR-013**: Concurrent hash operations MUST be bounded (limit, queue) and excess requests shed with `503` + `Retry-After`; the limit MUST not exceed the runtime worker-pool size minus one, checked at startup (AS-18) (P0202).
- **FR-014**: Client IP for throttling and session metadata MUST come only from the trusted proxy chain; client-supplied forwarding headers MUST be ignored unless the peer is a configured trusted proxy (AS-15).
- **FR-015**: A successful password check for an account with an enrolled second factor MUST return a purpose-limited challenge instead of a session (AS-19).
- **FR-016**: Every login MUST create a new session ID (AS-20).
- **FR-017**: Input limits: password ≤ 128 characters (login), body ≤ 16 KB; login never enforces the registration policy (AS-21). Throttle policies are declared fail-closed (AS-22).
- **FR-018**: Authentication and throttling MUST run before body validation (AS-30) (P0214; pipeline placement: guards for authentication, interceptors for throttling, pipes for validation, one filter for errors).

**Access tokens**

- **FR-021**: Access tokens MUST be ES256 JWTs with header `typ: at+jwt` and a `kid`; claims `iss: marketplace`, `aud: marketplace-api`, `sub` (user ID), `sid`, `role`, `amr`, `iat`, `nbf`, `exp` (= `iat` + 300), `jti`. They MUST contain no e-mail or other personal data (AS-10).
- **FR-022**: Verification MUST pin the algorithm per key, require `kid` to be a well-formed identifier present in the key set, and check signature, `exp`, `nbf` (tolerance 5 s), `iss`, `aud`, `typ`, and presence/format of `sub` and `sid`; any failure yields one generic reason; verification MUST not query any store and MUST not trust header-supplied keys (AS-23, AS-24).
- **FR-023**: The principal MUST be derived from the token alone: `{id, role, sessionId, amr}`. Role changes take effect at the next refresh (AS-28).
- **FR-024**: Credentials are accepted only as `Authorization: Bearer` or the `__Host-access` cookie; identity headers from clients are never trusted (AS-25, AS-26).
- **FR-025**: Sensitive routes (declared with the `sensitive` option of the authentication guard) MUST additionally reject tokens of revoked sessions immediately; other routes accept them until expiry, a bounded staleness of ≤ access lifetime (AS-27). If the revocation store is unreachable, sensitive routes MUST fail closed.
- **FR-026**: Every protected route answers `401 invalid_token` without credentials (AS-29).
- **FR-027**: Purpose-limited tokens (second-factor challenge, service tokens) MUST never be accepted as access tokens, and vice versa (AS-23).
- **FR-028**: Responses carrying credentials MUST be non-cacheable (AS-57).

**Refresh tokens & sessions**

- **FR-030**: Refresh tokens are opaque, ≥ 256 bits random, stored only as a one-way digest; each use returns a new token and spends the old one; the exchange either consumes the presented token and stores its successor, or does neither (AS-31, AS-33).
- **FR-031**: Presenting a spent token MUST revoke the session, record an audit event and increment a counter (AS-32). There is no reuse grace period; clients that refresh in parallel must serialize their refreshes (see Cross-capability contracts, Requires of S48).
- **FR-032**: Exactly one of N simultaneous exchanges of the same token succeeds (AS-33).
- **FR-033**: Refresh failures for unknown, expired, revoked, reused tokens and deleted users are indistinguishable to the client: `401 invalid_refresh_token` (AS-34, AS-35, AS-37).
- **FR-034**: Idle lifetime 30 days per token, session absolute lifetime 90 days; the successor's expiry never exceeds the absolute limit; expiry is checked at use, not by background deletion (AS-35, AS-36).
- **FR-035**: Refresh is throttled per IP; a throttled request does not consume the token (AS-38).
- **FR-036**: A session is described by `{sessionId, device (≤ 200 chars), ip, createdAt, lastUsedAt}`; at most 20 are active per user, the oldest being revoked on overflow (AS-39, AS-44).
- **FR-037**: Users can list their own sessions, revoke one of them, log out the current one, or log out all; revocation is durable, idempotent, and scoped to the caller's own sessions — another user's session ID answers `404` (AS-39 to AS-43).
- **FR-038**: `SessionRevocationService.revokeAllForUser(userId, reason)` MUST be exported for other domains (AS-45).
- **FR-039**: A login that fails after credential verification (for example token issuance) MUST leave no usable session (AS-85).

**Browser delivery & CSRF**

- **FR-050**: Clients may request `delivery: "cookie"` at login (and the same applies to completed second-factor/OIDC logins issued by S02); the response then carries no token in the body and sets `__Host-access`, `__Host-refresh` (HttpOnly) and `__Host-csrf` with the attributes of AS-46. Without it, tokens are returned in the body and no cookie is set (AS-10, AS-46).
- **FR-051**: Any state-changing request authenticated by cookie MUST carry a CSRF token: a signed double-submit value bound to the session (random part + keyed MAC over session ID and random part), sent in `X-CSRF-Token`, equal to the `__Host-csrf` cookie, and verified in constant time. Requests authenticated by `Authorization: Bearer` are exempt (AS-47, AS-48, AS-49, AS-53).
- **FR-052**: Cookie-authenticated state-changing requests and cookie-delivery logins MUST also pass an origin check: `Origin` in the allowlist, or, when `Origin` is absent, `Sec-Fetch-Site` not `cross-site` (AS-50, AS-51).
- **FR-053**: State-changing auth endpoints accept only `application/json` bodies (AS-52).
- **FR-054**: GET and HEAD never change state (AS-56).
- **FR-055**: Cookie-mode refresh needs no body token, requires CSRF, rotates all three cookies, and a request rejected by CSRF does not consume the token (AS-54). Cookie-mode logout requires CSRF and clears all three cookies (AS-55).

**Keys & JWKS**

- **FR-060**: Signing keys have states NEXT, ACTIVE, RETIRED; exactly one ACTIVE exists, enforced by the data store (AS-60, AS-64).
- **FR-061**: JWKS lists public parts of NEXT, ACTIVE and RETIRED keys, is served unauthenticated outside the API prefix, cacheable for 300 s with `ETag`/304 (AS-58, AS-59).
- **FR-062**: A scheduled job (once per schedule across replicas, idempotent) creates NEXT when absent, promotes NEXT when it was published ≥ 24 h and ACTIVE is ≥ 7 days old, and purges RETIRED keys ≥ 24 h after retirement (AS-61, AS-62, AS-63, AS-64).
- **FR-063**: A fresh environment bootstraps one ACTIVE key safely under concurrency (AS-60).
- **FR-064**: Unknown-`kid` reloads of the key set are limited to one per 30 s (AS-65).
- **FR-065**: Private keys are stored only in sealed form (AS-66).

**Secrets (envelope encryption)**

- **FR-066**: `SecretBox` seals and opens strings with authenticated encryption, a versioned format, an optional context bound to the ciphertext, support for a current and a previous master key, and refusal to start in production without a master key. It is exported for other domains' secrets (AS-67) (P0518).

**Service-to-service**

- **FR-070**: `ServiceTokenService.mint` issues tokens per AS-68; audiences are restricted to a configured allowlist, TTL ≤ 300 s (AS-71); minted tokens are reused until 80 % of their lifetime (AS-72).
- **FR-071**: The service-authentication guard (`ServiceAuthGuard` with `@AllowedCallers(...)`, audience taken from configuration) verifies per FR-022, requires `typ: svc+jwt` and its own audience, and applies a per-endpoint caller allowlist (AS-69).
- **FR-072**: `ServiceTokenService.exchange` converts a live user access token into an on-behalf-of service token (`sub` = user, `act.sub` = caller); a user access token is never forwarded to another service (AS-70).

**Password reset**

- **FR-080**: Reset request answers `202 {"status":"accepted"}` for every address and sends a message only when the account exists and has a password (AS-73).
- **FR-081**: Reset tokens are random ≥ 256 bits, stored as digest, valid 30 minutes, single-use; a new request invalidates earlier tokens (AS-73, AS-74).
- **FR-082**: Confirm sets the new password (policy of FR-005), spends the token atomically, revokes every session, emits `identity.password_changed` (AS-75, AS-77).
- **FR-083**: Unknown, spent and expired tokens are indistinguishable (`400 invalid_reset_token`); a policy failure does not consume the token (AS-76).
- **FR-084**: Reset endpoints are throttled per IP and per address, uniformly for unknown addresses (AS-78).

**Cross-domain, events, observability**

- **FR-090**: Identity MUST expose `UserDirectoryService` (batch by IDs, by address) returning DTOs (AS-79, AS-80) and MUST own `User`, `FederatedIdentity`, `SigningKey`; no other domain reads, joins, associates or injects them (AS-81).
- **FR-094**: Every event has `eventId` (UUID), `type`, `version`, `occurredAt`, `aggregateId`; payloads hold identifiers only, never e-mail or secrets, except the reset message of FR-080 which carries the single-use token and is delivered as a single-consumer message, not a fan-out topic (AS-01, AS-73).
- **FR-095**: Security events are audited and counted (AS-82); secrets never reach logs (AS-83).
- **FR-100**: Errors are problem+json with stable codes: `validation_failed` 400, `invalid_credentials` 401, `invalid_token` 401, `invalid_refresh_token` 401, `csrf_invalid` 403, `origin_not_allowed` 403, `service_caller_not_allowed` 403, `session_not_found` 404, `invalid_reset_token` 400, `unsupported_media_type` 415, `weak_password` 422, `rate_limited` 429, `overloaded` 503; any 5xx is generic (AS-84, AS-85).

### Key Entities

- **User**: an account `{id, email (unique, case-insensitive), role, password verifier or none, second-factor enrolment fields (S02), created/updated/deleted times}`. Owned by identity.
- **Session**: one login on one device `{sessionId, userId, device, ip, createdAt, lastUsedAt, absoluteExpiry, revokedAt, revokeReason}`; the family of refresh tokens of a session is revoked together.
- **Refresh token**: opaque random value; stored as digest `{sessionId, expiry, usedAt}`.
- **Signing key**: `{kid, alg, public key, sealed private key, status, activatedAt, retiredAt}`.
- **Reset token**: `{userId, digest, expiry, usedAt}`.
- **Principal**: `{id, role, sessionId, amr}` for users or `{kind:"service", caller, onBehalfOf?}` for services.
- **Federated identity** (S02): link `(provider, subject) → userId`; only owned here.

### Consistency model (P0610)

Strong: account uniqueness, the single ACTIVE key, token spending (exactly one winner), reset-token spending, session revocation record. Bounded-stale: access tokens (≤ 300 s after revocation or role change on non-sensitive routes; immediately revoked on sensitive routes), key sets cached by verifiers (≤ 300 s + 24 h publication lead). Eventual: events to other domains (outbox).

## Cross-capability contracts

No earlier spec exists (`specs/web`, `specs/journeys` absent; `specs/domains` held only this one), so the lists below are the contracts later specs must honour.

**Provides** (exact names; exported from `@app/domains/identity` unless it is an HTTP endpoint):

- HTTP (all under `/api` unless noted, problem+json errors): `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `POST /auth/logout-all`, `GET /auth/sessions`, `DELETE /auth/sessions/:sessionId`, `GET /auth/me` → `{id, email, role}`, `POST /auth/password-reset/request`, `POST /auth/password-reset/confirm`; `GET /.well-known/jwks.json` (no prefix).
  - Login/refresh response (body delivery): `{accessToken:{token:string, expiresIn:number}, refreshToken:string, sessionId:string, user:{id, email, role}}`; MFA challenge: `{mfaRequired:true, mfaToken:string}`. Contracts schemas live in `packages/contracts` (`authSessionSchema`, `mfaChallengeSchema`, `sessionListItemSchema`, `jwksSchema`, `problemSchema` usage).
- Access-token contract for every verifier (edge-be, services): ES256 via JWKS; `iss: marketplace`; `aud: marketplace-api`; `typ: at+jwt`; claims `sub, sid, role, amr, iat, nbf, exp, jti`. **Consumer: S54, S48 (BFF forwards it as-is), `packages/edge-be` (must pin `ES256`, `aud`, `typ`; drop the legacy RS256 key).**
- Guards and decorators: `Firewall({ anonymous?, roles?, sensitive? })`, `@User()`, `RequestWithUser` with `user: AuthenticatedUser`; `AuthenticatedUser = { id: UserId; role: Role; sessionId: string; amr: string[] }` (replaces `UserRawDto` on requests); `UserUtilsService.getUser(request)`.
- `UserDirectoryService` (R1): `getUsersByIds(ids: UserId[]): Promise<Map<UserId, UserSummaryDto>>` (≤ 500 IDs), `findByEmail(email: string): Promise<UserSummaryDto | null>`; `UserSummaryDto = { id, email: string | null, role, createdAt }`. **Consumers: S03 (members list, invitations), S24 (user display), S28 (recipient contact), S14/ledger (user existence), replacing every direct `User` read.**
- `SessionRevocationService` (R1): `revokeAllForUser(userId: UserId, reason: string): Promise<number>`, `revokeSession(userId, sessionId, reason)`. **Consumers: S03 (offboarding), admin bans.**
- `SessionIssuer` (R1, for S02 and test fixtures): `issue({ userId, amr: string[], delivery: 'body'|'cookie', meta })` → same result as login; `createChallenge(userId)` / `verifyChallenge(token)` for the second-factor step (`typ: mfa+jwt`, `aud: mfa`, 5 min).
- `ServiceTokenService` (R1): `mint({caller, audience, ttlSec?})`, `exchange({userAccessToken, caller, audience})`; `ServiceAuthGuard`, `@AllowedCallers(...callers: string[])`, `ServicePrincipal = { kind:'service', caller: string, onBehalfOf?: { userId, sessionId } }`. **Consumers: S54 (internal HTTP client attaches the token), S43/S42/S55 as they add internal endpoints.**
- `SecretBox` (R1): `seal(plaintext, context?)`, `open(sealed, context?)`. **Consumers: S42, S08, S04 (stored secrets).**
- Events (outbox → topic keyed by `userId`, envelope per FR-094): `identity.user_registered` v1 `{userId, role}`; `identity.registration_duplicate_attempted` v1 `{userId}`; `identity.password_changed` v1 `{userId}`; single-consumer message `identity.password_reset_requested` v1 `{userId, resetToken, expiresAt}`. **Consumer: S28 (sends welcome, "someone tried to register", reset and password-changed mails; resolves the address with `UserDirectoryService`; must never log `resetToken`).**
- Realtime topics registered by `IdentityTopicsModule` (unchanged).
- Rate-limit policies named in FR-017/AS-22 (declared in the policy registry of S50).

**Requires**:

- **S50 (rate limiter)**: named policies `auth.register.ip`, `auth.login.ip`, `auth.login.account` (counts failures only, key = normalized submitted address, resettable on success), `auth.refresh.ip`, `auth.reset.ip`, `auth.reset.account`, all fail-closed; the guard answers `429` problem+json with `Retry-After`.
- **S54 (platform toolkit)**: global problem+json filter with a `code` extension and `requestId`; trusted-proxy configuration for client IP; request-ID header; config schema validation at startup (master key, hash concurrency); metrics registry; JSON-body-only parser with a 16 KB limit for `/auth/*`; `Idempotency-Key` is not used by S01.
- **S49 (job scheduler)**: a single-run, replica-safe daily schedule with handler registration (`auth.rotate-signing-keys`).
- **S53 (events/outbox)**: `outbox.append(event)` callable inside the domain's own transaction (IX.6); a single-consumer (non-fan-out) message delivery path for `identity.password_reset_requested`.
- **S02 (MFA/OIDC)**: provides `isSecondFactorEnrolled(userId): Promise<boolean>` (consulted at login, FR-015) and the endpoints `/auth/mfa/*`, `/auth/oidc/*`; it creates sessions only through `SessionIssuer.issue` and links accounts only when the provider says the address is verified and, for accounts created by password registration (never e-mail-verified), by invalidating the existing password and sessions at link time.
- **S48 (BFF)**: serializes refresh per session (single flight) because reuse is fatal; stores tokens server-side and issues its own session cookie; forwards the user's access token only to services whose `aud` is `marketplace-api`.
- **S28 (notifications)**: consumes the events above; delivery of mails is its responsibility.
- **W01 (web)**: uses `delivery: "cookie"` only when the browser calls the API directly; otherwise goes through S48.

Cross-domain data used by S01: none. Identity depends on no other domain (domain-map §2). The only cross-owner write is the outbox append (IX.6).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A member can register and then log in in under 30 seconds, and 100 % of registration responses for existing and new addresses are indistinguishable by status, body and headers.
- **SC-002**: 100 % of the token mutations in AS-23 (forged, confused, expired, wrong audience/type/key) are rejected, with zero accepted outside the 5-second tolerance.
- **SC-003**: A stolen refresh token is useless after the first reuse: 100 % of sessions whose spent token is replayed are revoked within the same request.
- **SC-004**: After "log out everywhere", 100 % of sensitive actions with older tokens are refused immediately, and ordinary actions stop working within 5 minutes.
- **SC-005**: Token verification by services and the edge needs zero calls to the identity service per request; key rotation causes zero rejected valid tokens.
- **SC-006**: Under a login storm of 2,000 logins per second across the fleet, 99 % of valid logins complete in under 300 ms, 99 % of refreshes in under 50 ms, and excess load is shed with a retry hint rather than degraded silently.
- **SC-007**: Guessing passwords against one account is limited to 5 attempts per 15 minutes and against one network address to 20 per minute, regardless of forged forwarding headers.
- **SC-008**: Zero browser-readable storage ever holds an access or refresh token in the cookie flow, and 100 % of cookie-authenticated state changes without a valid CSRF proof are refused.
- **SC-009**: Zero queries from other domains touch identity-owned tables (ownership check reports 0 findings for `User`, `FederatedIdentity`, `SigningKey`).
- **SC-010**: No log line or error response in the S01 flows contains a password, token, hash, stack trace or query text.

## Assumptions

- Decisions marked `[BREAKING]`/`[CONTRACT]`/`[LOCAL]` are listed one per line in `questions.md`; this spec adopts each default stated there.
- Registration returns no session (uniform response); clients log in afterwards (the web client does so automatically).
- E-mail ownership is not verified at registration; the address is only a login name until S02 links identities. Consumers must not treat an address as verified.
- There is no CAPTCHA and no per-device lockout. Per-address throttling means an attacker who deliberately fails 5 logins can block that address's owner for up to 15 minutes; this is an accepted trade-off, bounded by the 15-minute window and by the per-IP limit on the attacker.
- Role changes propagate at the next refresh (≤ 300 s); immediate effect requires revoking the user's sessions.
- "Sensitive" routes are those marked by the owning capability (for example payouts S15, API keys S42); S01 marks `logout-all`, `DELETE /auth/sessions/:id` and password reset confirm.
- Session lists are not paginated: a user has at most 20 active sessions (III.10 offset/keyset rule concerns unbounded tables).
- Service identity (`caller`) is the deployment's configured service name; trust rests on custody of the signing keys. Workload-identity/mTLS in the infrastructure is an additional, ops-owned layer.
- Breached-password corpus access uses a k-anonymity range API behind a port; tests use a fake.
- Email delivery, templates and the "someone tried to register" message belong to S28.
- Data stores for sessions and refresh tokens are chosen by the plan (key-value with TTL and conditional writes); this spec constrains behaviour only.
