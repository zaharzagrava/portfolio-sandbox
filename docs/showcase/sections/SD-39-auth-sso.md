# SD-39 — Authentication / SSO Service

Status: ☑ done (typechecked; spec written, not run) — per-shop SSO config lands with SD-02, service-to-service tokens with SD-04 · Phase 1 · Depends on: F-01, SD-28 · Used by: everything; SD-02 (enterprise SSO per shop), SD-04 (BFF sessions), SD-07 (API keys), SD-01 (widget identity)

## Marketplace adaptation
Buyers, sellers and shop staff log in with password, Google (OIDC) or their company IdP (enterprise sellers). Sessions must be revocable instantly ("log out all devices", banned seller), and access-token checks must be free on the hot path (edge + every service verify locally).

## Existing code
`auth/` (register/login, RS256 JWT verified at edge `edge-be` via `jose`), `firebase/` (legacy), `Role` enum, `roles.guard.ts`, WS tickets (#32).

## Patterns showcased
| Pattern | Lesson |
|---|---|
| **Argon2id** password hashing (migrate bcrypt hashes lazily on login — rehash-on-verify) | 05/02 §5 |
| Short-lived access JWT (5 min) + **rotating refresh tokens** with **reuse detection** (token family revoked on reuse) | 05/02 §1–2 |
| **JWKS endpoint + key rotation** (`kid`, publish next key before signing with it); edge and services verify via cached JWKS | 05/02 §2, 10/09 #39 |
| Session store in **Redis** (sessionId → userId, device, family) for instant revocation; access JWT carries `sid`; revocation list checked only for sensitive ops + short TTL bounds the rest | 10/09 #39 |
| **OIDC login (Google)** — Authorization Code + **PKCE**, `state` + `nonce`, ID-token validation | 05/02 §4 |
| **Per-shop enterprise SSO** (OIDC via `openid-client`, config per tenant) | 10/04 #2 |
| **TOTP MFA** (otplib) + recovery codes (hashed) | 05/02 §5 |
| Brute-force protection: rate limit per account + per IP (SD-28), progressive delay, generic error messages (no user enumeration) | 05/02 §5, 05/01 §5 |
| Cookies for browser: `__Host-` prefix, `HttpOnly; Secure; SameSite=Lax`; CSRF double-submit for cookie-authenticated mutations | 05/01 §3 |
| Service-to-service auth: internal JWT (client credentials style, audience-scoped) between `core` ↔ workers | 05/02 §8 |
| Secrets via AWS Secrets Manager (existing `aws-api`) for signing keys; local fallback env | 05/02 §9 |

## Data / storage
- Postgres: `User` (+ `passwordAlgo`, `mfaSecretEnc`), `SigningKey` (kid, publicJwk, privateKeyRef, status ACTIVE/NEXT/RETIRED), `FederatedIdentity` (provider, subject, userId), `ShopSsoConfig`.
- **DynamoDB** `Sessions` (PK `SESSION#<sid>`, GSI `USER#<userId>`), `RefreshTokens` (PK token hash, family, used flag, TTL attribute) — KV access at login/refresh rate, TTL-based expiry, no Postgres load (D24).
- Redis: revoked `sid` set (bloom-ish fast path) with TTL = access token TTL.

## API
`POST /auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/logout-all`, `GET /.well-known/jwks.json`, `GET /auth/oidc/:provider/start`, `/auth/oidc/:provider/callback`, `POST /auth/mfa/enroll|verify`.

## Steps
- [x] Deps: `argon2`, `jose`, `openid-client`, `otplib`.
- [x] Key management service (rotate job via SD-29: weekly, NEXT→ACTIVE→RETIRED), JWKS controller with `Cache-Control: max-age=300`.
- [x] Refresh-token rotation + reuse detection (Dynamo conditional update `attribute_not_exists(usedAt)`).
- [x] Session revocation; `UserAuthGuard` checks `sid` revocation for sensitive routes (`@Sensitive()`).
- [x] OIDC (Google) + per-shop SSO config. → Google + dynamic `OidcService.register()`; per-shop config model/UI in SD-02.
- [x] MFA TOTP.
- [x] Edge worker: verify via JWKS (cached in worker memory/KV) instead of single static public key.
- [x] e2e: refresh rotation + reuse → family revoked; login brute force → 429; JWKS rotation keeps old tokens valid until expiry.

## Scale
- Target: 100k RPS authenticated requests (verification), 2k logins/s, 10k refreshes/s.
- Hot path: JWT verified **locally** (edge + services, cached JWKS) — zero I/O per request. Refresh → 1 Dynamo conditional write. Login → Argon2 (CPU, ~50 ms) on a bounded worker pool so it can't starve the event loop.
- First bottleneck & fix: Argon2 CPU on login storms → `worker_threads` pool (argon2 native is off-thread already; cap concurrency) + login rate limits; Dynamo hot partition → token hash PK spreads evenly.
- Capacity model: 2k logins/s × 50 ms CPU = 100 CPU-seconds/s → ~13 c7g.2xlarge-class cores-equivalents across the auth fleet; verification is free.
- Proof: k6 refresh storm 1/2/4 instances; thresholds p99 refresh < 50 ms; login p99 < 300 ms.

## FE visualisation (phase 2)
Login, MFA enrol, sessions list ("log out other devices").

## Implementation notes (2026-10-01)
- Migration `20261001130000-auth-keys-federation-mfa`: `SigningKey` (partial unique index → one ACTIVE), `FederatedIdentity` UNIQUE(provider, subject), User MFA columns, `lower(email)` expression index (CONCURRENTLY, outside tx).
- `auth/crypto/`: `SecretBox` (AES-256-GCM, versioned format, KEK required in prod), `PasswordHasher` (argon2id OWASP params, bcrypt legacy verify + rehash-on-login, dummy hash timing equalizer). argon2 native build allowed in `pnpm-workspace.yaml`.
- `auth/keys/`: `KeyStore` (ES256 keys, encrypted private keys, JWKS, kid lookup with refresh-on-miss, algorithm pinning, lazy race-safe ACTIVE bootstrap), `KeyRotationJobs` (daily: NEXT published ≥ 1 day before activation, weekly promotion, retired keys kept 2 days) in `apps/worker` via `AuthWorkerModule`.
- `auth/sessions/SessionStore` on DynamoDB single-table `Auth` (`dynamodb/Auth.json` documents key design + access patterns): sessions, hashed opaque refresh tokens, rotation with conditional `usedAt`, **reuse detection → session revoked**, GSI1 for "my sessions", Redis revocation markers.
- `auth/mfa/TotpService` (otplib v13: `epochTolerance`, `afterTimeStep` replay protection; hashed single-use recovery codes). MFA challenge = purpose-scoped JWT (`aud: mfa`) rejected as an access token everywhere (backend + edge).
- `auth/oidc/OidcService` (openid-client v6: discovery, PKCE S256, state + nonce single-use in Redis, ID-token validation); account linking by email **only if `email_verified`**.
- `AuthSessionService` + new endpoints: register/login (MFA challenge), `mfa/verify|enroll|confirm`, `refresh` (body or `__Host-refresh` cookie + double-submit CSRF guard), `logout`, `logout-all`, `sessions`, `oidc/:provider/start|callback` (open-redirect-safe `returnTo`). `SessionNotRevokedGuard` for sensitive routes. `/.well-known/jwks.json` (outside `/api`, cache 5 min).
- `AuthService.userAuthentication`: kid → KeyStore (ES256) else legacy RS256; user row cached 60 s (no DB hit per request); returns `sessionId`.
- Edge worker: `JWKS_URL` → `createRemoteJWKSet` (cached per isolate), legacy SPKI fallback, rejects purpose tokens. Edge typecheck clean.
- `core` now imports `DynamoModule` + `CacheModule`. `DynamoModule` registers a test truncate cleaner.
- Spec `auth/auth.e2e-spec.ts` (ES256+kid, JWKS no private parts, rotation & reuse detection, logout-all + sensitive route, bcrypt→argon2, no enumeration, key rotation compat, MFA + replay + recovery codes, legacy tokens).
