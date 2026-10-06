# Test Plan: S01 — Auth, Sessions, Tokens (domain `identity`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md), each proven at the lowest layer that can prove it. A dash means the layer does not test that scenario.

- API e2e files live in `packages/backend/libs/domains/identity/`. Each file's top-level `describe` is named after its feature (VII.8). They boot the real `AuthApiModule`/`AuthModule` with the production pipe, filter, prefix and interceptors, against real Postgres, Redis and the session key-value store (docker-compose.test.yaml), freeze time with the shared clock helper, reset state in `beforeEach`, seed through `@app/test/seeds`, parse every response with the `packages/contracts` schema (VII.6), and assert persisted state (rows, session/refresh records, outbox rows, Redis markers) next to the body (VII.2).
- Only system-edge dependencies are faked: breached-password corpus client, outbound mail/message transport, clock. The project's own repositories, stores, key store and hasher are real (a pass-through spy on the hasher counts work; it does not stub it).
- Unit specs sit beside the code under `domain/`/pure helpers, are table-driven (`it.each`), and exist only for pure logic (VII.5).
- UI journey: `packages/web/tests/auth.spec.ts` (Playwright, W01). One happy path; no edge case is re-tested there.
- Static gates (VII.1) that belong to this capability: `tsc --noEmit` and ESLint for `packages/backend`; `pnpm check:boundaries`; `pnpm check:table-ownership --strict` (identity lines must be 0) — see AS-81.

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 register new account → uniform 202, user, event | `auth-register.e2e-spec.ts` | — | — |
| AS-02 duplicate address (case/whitespace) → identical response, duplicate event | `auth-register.e2e-spec.ts` | — | — |
| AS-03 concurrent same-address registration (`Promise.all`), store-level uniqueness | `auth-register.e2e-spec.ts` | — | — |
| AS-04 role whitelist and mass assignment | `auth-register.e2e-spec.ts` | — | — |
| AS-05 validation failure classes, no secret echoed | `auth-register.e2e-spec.ts` | — | — |
| AS-06 breached password → 422 (new and existing address) | `auth-register.e2e-spec.ts` | — | — |
| AS-07 breach corpus timeout → fail open + counter | `auth-register.e2e-spec.ts` | — | — |
| AS-08 equal hashing work for new vs existing address | `auth-register.e2e-spec.ts` (hasher pass-through spy) | — | — |
| AS-09 registration rate limit 429 | `auth-register.e2e-spec.ts` | — | — |
| AS-10 successful body-delivery login (token profile, no-store, session persisted, digest only) | `auth-login.e2e-spec.ts` | — | — |
| AS-11 identical 401, one verification either way | `auth-login.e2e-spec.ts` (hasher pass-through spy) | — | — |
| AS-12 per-address throttle (incl. unknown address) | `auth-login.e2e-spec.ts` | — | — |
| AS-13 success resets failure counter | `auth-login.e2e-spec.ts` | — | — |
| AS-14 per-IP throttle | `auth-login.e2e-spec.ts` | — | — |
| AS-15 spoofed forwarding headers ignored | `auth-login.e2e-spec.ts` | — | — |
| AS-16 bcrypt / old-Argon2 rehash on login; wrong password leaves hash | `auth-login.e2e-spec.ts` | — | — |
| AS-17 verifier result matrix (`valid`, `needsRehash`, null, malformed) | — | — | `infra/crypto/password-hasher.spec.ts` |
| AS-18 hash concurrency/queue bound; startup check vs worker-pool size | — | — | `domain/bounded-concurrency.spec.ts` |
| AS-19 enrolled second factor → challenge, no session | `auth-login.e2e-spec.ts` | — | — |
| AS-20 new session ID on every login | `auth-login.e2e-spec.ts` | — | — |
| AS-21 login input limits (128, 5-char wrong password, 16 KB body, missing fields) | `auth-login.e2e-spec.ts` | — | — |
| AS-22 policy table fail-closed and limits | — | — | `domain/auth-rate-policies.spec.ts` |
| AS-23 verifier rejection/acceptance matrix | — | — | `domain/token-verifier.spec.ts` |
| AS-24 guard maps failures to identical 401 | `auth-tokens.e2e-spec.ts` | — | — |
| AS-25 client identity headers ignored | `auth-tokens.e2e-spec.ts` | — | — |
| AS-26 legacy credential channels rejected | `auth-tokens.e2e-spec.ts` | — | — |
| AS-27 revoked session: sensitive 401 now, ordinary until exp | `auth-tokens.e2e-spec.ts` | — | — |
| AS-28 role change visible only after refresh | `auth-tokens.e2e-spec.ts` | — | — |
| AS-29 401 without credentials on every protected route (`it.each`) | `auth-tokens.e2e-spec.ts` | — | — |
| AS-30 auth and throttling before validation | `auth-tokens.e2e-spec.ts` | — | — |
| AS-31 refresh rotation happy path | `auth-refresh.e2e-spec.ts` | — | — |
| AS-32 reuse detection revokes session, audit + counter | `auth-refresh.e2e-spec.ts` | — | — |
| AS-33 concurrent refresh of one token (`Promise.all`), one successor stored | `auth-refresh.e2e-spec.ts` | — | — |
| AS-34 unknown/garbage/oversized refresh values | `auth-refresh.e2e-spec.ts` | — | — |
| AS-35 idle expiry boundary (frozen clock) | `auth-refresh.e2e-spec.ts` | — | — |
| AS-36 absolute session lifetime cap | `auth-refresh.e2e-spec.ts` | — | — |
| AS-37 refresh after logout-all / user deleted | `auth-refresh.e2e-spec.ts` | — | — |
| AS-38 refresh rate limit, token not consumed | `auth-refresh.e2e-spec.ts` | — | — |
| AS-39 list own sessions, DTO shape, no leakage | `auth-sessions.e2e-spec.ts` | — | — |
| AS-40 cross-user session delete → 404 (IDOR) | `auth-sessions.e2e-spec.ts` | — | — |
| AS-41 revoke own other session / current session | `auth-sessions.e2e-spec.ts` | — | — |
| AS-42 idempotent logout | `auth-sessions.e2e-spec.ts` | — | — |
| AS-43 logout-all, idempotent, scoped to caller | `auth-sessions.e2e-spec.ts` | — | — |
| AS-44 session cap evicts oldest | `auth-sessions.e2e-spec.ts` | — | — |
| AS-45 `SessionRevocationService.revokeAllForUser` (service-level, real stores) | `auth-sessions.e2e-spec.ts` | — | — |
| AS-46 cookie-delivery login: cookies, attributes, no token in body | `auth-cookies-csrf.e2e-spec.ts` | — | — |
| AS-47 cookie request without CSRF header → 403, state unchanged | `auth-cookies-csrf.e2e-spec.ts` | — | — |
| AS-48 valid CSRF accepted; token of another session rejected | `auth-cookies-csrf.e2e-spec.ts` | — | — |
| AS-49 Bearer requests exempt from CSRF | `auth-cookies-csrf.e2e-spec.ts` | — | — |
| AS-50 Origin / Sec-Fetch-Site checks | `auth-cookies-csrf.e2e-spec.ts` | — | — |
| AS-51 login CSRF (disallowed Origin, cookie delivery) | `auth-cookies-csrf.e2e-spec.ts` | — | — |
| AS-52 form content types → 415 | `auth-cookies-csrf.e2e-spec.ts` | — | — |
| AS-53 CSRF token verification matrix (tamper, truncation, constant time) | — | — | `domain/csrf-token.spec.ts` |
| AS-54 cookie-mode refresh; rejected CSRF does not consume token | `auth-cookies-csrf.e2e-spec.ts` | — | — |
| AS-55 cookie-mode logout clears cookies | `auth-cookies-csrf.e2e-spec.ts` | — | — |
| AS-56 GET never changes state | `auth-cookies-csrf.e2e-spec.ts` | — | — |
| AS-57 `no-store` on credential responses | `auth-tokens.e2e-spec.ts` | — | — |
| AS-58 JWKS document, headers, ETag/304, no private members | `auth-jwks-keys.e2e-spec.ts` | — | — |
| AS-59 third-party JOSE verification from JWKS only | `auth-jwks-keys.e2e-spec.ts` | — | — |
| AS-60 first-use bootstrap race → one ACTIVE | `auth-jwks-keys.e2e-spec.ts` | — | — |
| AS-61 rotation promotes NEXT, old tokens still valid | `auth-jwks-keys.e2e-spec.ts` | — | — |
| AS-62 rotation decision matrix (frozen clock) | — | — | `domain/key-rotation-policy.spec.ts` |
| AS-63 retired key purge; tokens rejected after | `auth-jwks-keys.e2e-spec.ts` | — | — |
| AS-64 concurrent and repeated rotation runs | `auth-jwks-keys.e2e-spec.ts` | — | — |
| AS-65 unknown-kid reload cooldown | — | — | `domain/key-cache-policy.spec.ts` |
| AS-66 private key sealed at rest | `auth-jwks-keys.e2e-spec.ts` | — | — |
| AS-67 secret sealing matrix (tamper, context, previous key, production start) | — | — | `infra/crypto/secret-box.spec.ts` |
| AS-68 service token mint profile | `service-tokens.e2e-spec.ts` | — | — |
| AS-69 internal endpoint matrix (probe controller with the real guard) | `service-tokens.e2e-spec.ts` | — | — |
| AS-70 on-behalf-of exchange, revoked session refused | `service-tokens.e2e-spec.ts` | — | — |
| AS-71 mint policy (allowlist, TTL bounds) | — | — | `domain/service-token-policy.spec.ts` |
| AS-72 minted-token reuse until 80 % of lifetime | — | — | `domain/service-token-cache.spec.ts` |
| AS-73 reset request uniform for existing/passwordless/unknown, one message | `auth-password-reset.e2e-spec.ts` | — | — |
| AS-74 newer reset token invalidates older | `auth-password-reset.e2e-spec.ts` | — | — |
| AS-75 confirm: password replaced, sessions revoked, event | `auth-password-reset.e2e-spec.ts` | — | — |
| AS-76 invalid/spent/expired token uniform 400; weak password keeps token | `auth-password-reset.e2e-spec.ts` | — | — |
| AS-77 concurrent confirm (`Promise.all`) → one winner | `auth-password-reset.e2e-spec.ts` | — | — |
| AS-78 reset rate limits uniform | `auth-password-reset.e2e-spec.ts` | — | — |
| AS-79 `getUsersByIds` batch, DTO shape, limit | `user-directory.e2e-spec.ts` | — | — |
| AS-80 `findByEmail` normalization | `user-directory.e2e-spec.ts` | — | — |
| AS-81 ownership and boundary gates (0 identity findings) | — (static gate: `pnpm check:table-ownership --strict`, `pnpm check:boundaries`) | — | — |
| AS-82 audit lines and metrics for security events | `auth-observability.e2e-spec.ts` (log + metric capture) | — | — |
| AS-83 no secret in logs across the full flow | `auth-observability.e2e-spec.ts` (log capture) | — | — |
| AS-84 error contract: problem+json, stable codes, requestId | `auth-observability.e2e-spec.ts` (`it.each` over error classes) | — | — |
| AS-85 corrupted signing key → generic 500, no usable session | `auth-observability.e2e-spec.ts` | — | — |
| AS-86 register → login → account → sessions → log out other device → logout, no token in script-readable storage | — | `packages/web/tests/auth.spec.ts` (W01) | — |

## Mandatory case coverage per endpoint (VII.3)

| Endpoint | Happy | Validation classes | 401 | IDOR / cross-user | Rate limit 429 | Concurrency | State guard |
|---|---|---|---|---|---|---|---|
| `POST /auth/register` | AS-01 | AS-04, AS-05, AS-06 | n/a (public) | n/a | AS-09 | AS-03 | n/a |
| `POST /auth/login` | AS-10 | AS-21 | AS-11 | n/a | AS-12, AS-14 | n/a | AS-19 |
| `POST /auth/refresh` | AS-31 | AS-34 | AS-34 | n/a | AS-38 | AS-33 | AS-32, AS-35, AS-36 |
| `POST /auth/logout` | AS-42 | n/a | AS-29 | own session only (no ID accepted) | n/a | n/a | idempotent AS-42 |
| `POST /auth/logout-all` | AS-43 | n/a | AS-29 | AS-43 (other user untouched) | n/a | n/a | idempotent AS-43 |
| `GET /auth/sessions` | AS-39 | n/a | AS-29 | AS-39 | n/a | n/a | n/a |
| `DELETE /auth/sessions/:id` | AS-41 | n/a | AS-29 | AS-40 | n/a | n/a | n/a |
| `GET /auth/me` | AS-24 | n/a | AS-29 | n/a | n/a | n/a | n/a |
| `POST /auth/password-reset/request` | AS-73 | AS-73 | n/a (public) | n/a | AS-78 | n/a | AS-74 |
| `POST /auth/password-reset/confirm` | AS-75 | AS-76 | n/a (public) | n/a | AS-78 | AS-77 | AS-76 |
| `GET /.well-known/jwks.json` | AS-58 | n/a | n/a (public) | n/a | n/a | AS-60 | n/a |

Async consumers (VII.4): identity consumes no events, so there is no consumer test here. Duplicate-delivery and poison-message tests for the events it emits belong to the consuming capability (S28) and the outbox (S53).
