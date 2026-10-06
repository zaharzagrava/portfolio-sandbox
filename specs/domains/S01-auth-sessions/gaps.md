# Gaps: current `identity` code versus the S01 spec

Implementation to-do list. Paths are relative to `packages/backend/libs/domains/identity/` unless stated. "→ AS-nn / FR-nn" names the spec item the change satisfies. The code is a draft; the spec and the Interview-Prep notes win.

> **Caveat on the ownership report.** `pnpm --dir packages/backend check:table-ownership` could not be run in this unattended session (the command needed interactive approval), and the spec task forbids code changes. Section C is therefore reconstructed by searching the code for imports and queries of identity's models and tables (`UserModel`, `FederatedIdentityModel`, `SigningKeyModel`, `"User"` in SQL, `@InjectModel(User)`, `@ForeignKey(() => User)`). **Run the check first and reconcile this section with its `MODEL`/`SQL` rows for `identity`** before starting work.

## A. Behaviour the code gets wrong or lacks

### Registration

| # | Gap | Where | Fix (spec) |
|---|---|---|---|
| A1 | Duplicate address returns `409 Email is already registered`: enumerates members. Success returns `201` with a session. | `application/auth-session.service.ts:63`, `application/auth.service.ts:65`, `api/auth.controller.ts:36` | Uniform `202 {"status":"accepted"}`, no session, duplicate event (FR-001, FR-003, AS-01–AS-03). |
| A2 | Two parallel service implementations: `AuthService.register/login` (bcrypt, RS256, no sessions) and `AuthSessionService`. `AuthService.register`/`login` are dead. | `application/auth.service.ts:51–86` | Delete; keep one path. |
| A3 | No outbox events; user write and events not atomic. | `application/auth-session.service.ts:56` | Append `identity.user_registered` / `registration_duplicate_attempted` through the outbox service inside the user-creating transaction (IX.6) (FR-003). |
| A4 | Password policy 8–72 chars (bcrypt limit); no breached-password check; `MaxLength(72)` on login rejects valid long passwords. | `api/auth.dto.ts:25–26`, `:43` | 12–128, breach port with 800 ms fail-open, login only caps at 128 (FR-005, FR-006, FR-017, AS-05–AS-07, AS-21). |
| A5 | New and duplicate paths do different work (hash before insert vs. `409`). | `application/auth-session.service.ts:56–64` | Hash exactly once on both paths (FR-007, AS-08). |
| A6 | Unique email is a column `unique` plus the `lower(email)` index created by migration; DTO lower-cases but the store rule is not tested. Verify the expression index is unique and used (`EXPLAIN`). | `infra/models/user.model.ts:57`, migration `20261001130000-auth-keys-federation-mfa` | Make the store reject case-variant duplicates (FR-002, AS-03); P0305. |
| A7 | No `registration` rate limit. | `api/auth.controller.ts:35` (reuses `auth.login.ip`) | New policy `auth.register.ip` 10/hour (FR-008, AS-09). |
| A8 | DTO validation by `@IsIn` returns plain 400; no `forbidNonWhitelisted` assertion; no per-field error list contract. | `api/auth.dto.ts` | Confirm global pipe options; assert `validation_failed` shape (AS-04, AS-05). |

### Login, hashing, throttling

| # | Gap | Where | Fix |
|---|---|---|---|
| A9 | Client IP read from `cf-connecting-ip` sent by any client: rate-limit bypass. | `api/auth.controller.ts:145` | Use the trusted-proxy-resolved IP only (FR-014, AS-15). Needs S54 trust-proxy config. |
| A10 | Account throttle counts every attempt and has no reset on success; policy key `body.email` is not normalized the same as the DTO. | `libs/infrastructure/rate-limit/rate-limit.types.ts:39` (S50) | Failure-only counting keyed by normalized address, reset on success (FR-011, AS-12, AS-13). |
| A11 | Rehash update is unconditional (`user.update`) → can overwrite a password changed in between. | `application/auth-session.service.ts:76` | Conditional update on the old hash (LOCAL). |
| A12 | Hashing runs unbounded on the libuv pool; no concurrency/queue limit, no `503`. | `infra/crypto/password-hasher.ts` | Bounded semaphore + startup check against `UV_THREADPOOL_SIZE` (FR-013, AS-18); document env in Dockerfile (P0202). |
| A13 | Bcrypt cost-10 dummy and legacy support: dummy for unknown user is Argon2 (good) but `verify` on malformed hash may throw. | `infra/crypto/password-hasher.ts:25–35` | Return `{false,false}` for malformed hashes (AS-17). |
| A14 | Login does not set `Cache-Control: no-store`. | `api/auth.controller.ts:44–48` | FR-028, AS-57. |
| A15 | `mfaToken` has `purpose: 'mfa'` claim but no `typ`; accepted-as-access protection relies on `purpose` check only in `AuthService.userAuthentication`. | `application/auth-session.service.ts:79` | `typ: mfa+jwt` and verifier-level `typ` check (FR-027, AS-23). |
| A16 | No `amr`, `nbf`, `jti`, `aud`, `typ` in access tokens; lifetime default 600 s. | `application/auth-session.service.ts:155`, `infra/keys/key-store.service.ts:44–53`, `libs/common/config/api-config.service.ts:303` | FR-021; lifetime default 300 s. |
| A17 | Every login creates a session without a per-user cap. | `infra/sessions/session-store.service.ts:41–78` | FR-036, AS-44. |
| A18 | A failure after session creation (token signing) leaves the session behind. | `application/auth-session.service.ts:140–150` | Sign first or revoke on failure (FR-039, AS-85). |

### Token verification and principal

| # | Gap | Where | Fix |
|---|---|---|---|
| A19 | Legacy RS256 no-`kid` path with a static key file/config (`jwt_private_key`) and `issueTokensFor`. | `application/auth.service.ts:93–175` | Delete (FR-022, FR-027); replace test usage with a fixture over `SessionIssuer`. |
| A20 | Verification loads the user (cached 60 s) on every request; principal is the user row, not claims. | `application/auth.service.ts:119–134` | Principal from claims only (FR-023); introduce `AuthenticatedUser`. Callers needing e-mail use `UserDirectoryService`. |
| A21 | No `aud`/`typ`/`nbf`/clock tolerance checks; `kid` not format-checked; unknown `kid` forces a DB reload on every miss (kid-spray = DB DoS). | `application/auth.service.ts:104–112`, `infra/keys/key-store.service.ts:56–59` | Pure `TokenVerifier`, key-cache cooldown 30 s (FR-022, FR-064, AS-23, AS-65). |
| A22 | Legacy credential channels: `x-auth-token` header and cookie. The cookie is ambient authentication without CSRF. | `api/guards/extract-auth-token.ts:16–21` | Remove (FR-024, AS-26). |
| A23 | `UserAuthOptionalGuard` swallows all errors silently. | `api/guards/user-auth-optional.guard.ts` | Keep behaviour, log at debug with reason; add test (no scenario needed beyond AS-24 semantics). |
| A24 | `@UseGuards(SessionNotRevokedGuard)` must precede `@Firewall()`; easy to get wrong; no fail-closed definition. | `api/auth.controller.ts:73,86,93`, `api/guards/session-not-revoked.guard.ts` | `Firewall({sensitive:true})`, fail closed on store errors (FR-025, AS-27). |
| A25 | `RolesGuard` role from DB-cached user; becomes token role (stale ≤ 300 s). | `api/guards/roles.guard.ts` | AS-28. |
| A26 | Identity headers: no explicit test that `X-User-Id` is ignored. | — | AS-25. |

### Refresh and sessions

| # | Gap | Where | Fix |
|---|---|---|---|
| A27 | 10 s reuse grace by default (`auth_refresh_reuse_grace_ms ?? 10_000`). | `application/auth-session.service.ts:106`, `libs/common/config/api-config.service.ts:135` | Remove (FR-031, AS-32, AS-33). Existing e2e `a replay within the grace window…` is deleted. |
| A28 | `rotate` is Get → conditional Update (`usedAt`) → Put: three steps; a crash after the Update strands the session; session revocation is checked before, not within, the write. | `infra/sessions/session-store.service.ts:84–127` | One transactional write: mark used + put successor + assert session not revoked (FR-030, AS-33). |
| A29 | Each rotation extends expiry by the full TTL with no absolute cap. | `infra/sessions/session-store.service.ts:118` | Store `absoluteExpiry`; successor expiry = min(now+30 d, absolute) (FR-034, AS-35, AS-36). |
| A30 | Time read with `Date.now()`/`new Date()` inside the store (clock not injectable; breaks frozen-clock tests; also I.3 spirit). | `infra/sessions/session-store.service.ts:43–45,102,118,152`, `infra/keys/key-rotation.jobs.ts:44–59` | Inject a clock. |
| A31 | `GET /auth/sessions` returns the raw stored item (PK/SK/GSI keys, `userId`, `familyId`, `expiresAtEpoch`). | `api/auth.controller.ts:83` | Explicit DTO + contracts schema (FR-036, AS-39); V.1. |
| A32 | No `DELETE /auth/sessions/:id`; no `lastUsedAt`; no reason on eviction. | — | FR-037, AS-40, AS-41. |
| A33 | `logout-all` returns 201; revokes with `Promise.all` of N writes then N Redis sets (N unbounded → capped at 20 by FR-036). | `api/auth.controller.ts:76–80` | 200 `{revokedSessions}` (AS-43). |
| A34 | Revocation writes Dynamo then Redis non-atomically; no retry on marker failure. | `infra/sessions/session-store.service.ts:144–156` | Durable write first, marker second, error → 5xx, safe to retry (idempotent) (FR-037). |
| A35 | `refresh` failure messages distinguish reuse. | `application/auth-session.service.ts:108` | Single `invalid_refresh_token` (FR-033). |
| A36 | `logout` unauthenticated-credentials path: needs a valid access token; no cookie-mode handling. | `api/auth.controller.ts:66–71` | AS-42, AS-55. |
| A37 | No refresh rate limit policy. | `api/auth.controller.ts:58` | `auth.refresh.ip` (FR-035, AS-38). |

### Cookies and CSRF

| # | Gap | Where | Fix |
|---|---|---|---|
| A38 | Refresh token returned in body **and** cookie; `__Host-` cookie set on every login without opt-in; `SameSite=Strict`. | `api/auth.controller.ts:128–136` | Opt-in `delivery:"cookie"`, no token in body, `Lax` (FR-050, AS-46). |
| A39 | CSRF is naive double-submit with a random value (`randomBytes(16)` unrelated to the session); guard skips when a body token is present or no refresh cookie. No Origin/Sec-Fetch-Site check; no login CSRF defence; no content-type enforcement. | `api/guards/csrf.guard.ts:15–31`, `api/auth.controller.ts:133` | Signed double-submit bound to `sid`, applied to every cookie-authenticated unsafe request, Origin/Fetch-Metadata checks, JSON-only (FR-051–FR-053, AS-47–AS-53). |
| A40 | No `__Host-access` cookie flow; cookie auth only for refresh. | — | FR-050, AS-46. |

### Keys, JWKS, secrets

| # | Gap | Where | Fix |
|---|---|---|---|
| A41 | Rotation runs on every instance boot (`onApplicationBootstrap` → `rotate({})`) racing across replicas; schedule upsert at boot. | `infra/keys/key-rotation.jobs.ts:34–37` | Scheduled single-run job via S49; only race-safe lazy bootstrap in `KeyStore` (FR-062, FR-063, AS-60, AS-64). |
| A42 | Retired retention hard-coded 2 days; NEXT lead 1 day; promote age 7 days are hard-coded and untested. | `infra/keys/key-rotation.jobs.ts:25,54,59` | Pure `decideRotation(keys, now, cfg)` (FR-062, AS-62). |
| A43 | Concurrent bootstrap swallows all errors: `createKey('ACTIVE').catch(() => undefined)` may hide real failures. | `infra/keys/key-store.service.ts:41` | Catch only the unique-violation. |
| A44 | JWKS: `alg: 'RS256'` still allowed in model type; no `ETag`/304; content type generic. | `api/well-known.controller.ts`, `infra/models/signing-key.model.ts:12` | ES256 only; ETag (FR-061, AS-58). |
| A45 | `SecretBox` has no context binding, no previous-key fallback, deterministic dev KEK fallback allowed outside production (fine) but not tested. | `infra/crypto/secret-box.ts` | FR-066, AS-67. |
| A46 | Edge worker accepts `ES256` and `RS256`, `issuer` only, no `aud`/`typ`. | `packages/edge-be/src/index.ts:115` | [CONTRACT] pin ES256, `aud`, `typ` (FR-022). Outside identity; tracked for the edge owner. |

### Missing capabilities

| # | Gap | Fix |
|---|---|---|
| A47 | Service-to-service tokens do not exist. | `ServiceTokenService`, `ServiceAuthGuard`, `@AllowedCallers`, token cache (FR-070–FR-072, AS-68–AS-72). |
| A48 | Password reset does not exist. | FR-080–FR-084, AS-73–AS-78; reset-token store, outbox message, throttles. |
| A49 | No `UserDirectoryService`, `SessionRevocationService`, `SessionIssuer`. | FR-038, FR-090, AS-45, AS-79, AS-80. |
| A50 | No audit log/metrics for security events; no log-redaction test. | FR-095, AS-82, AS-83. |
| A51 | No stable error codes; no contracts schemas for auth responses. | FR-100, AS-84; add schemas in `packages/contracts`. |
| A52 | Existing e2e (`auth.e2e-spec.ts`, 170 lines, 9 tests) is one file with `bcrypt` import, legacy-token test, grace-window test and `expect(201)` on `logout-all`. | Split into the files named in `test-plan.md`; delete the legacy RS256 and grace tests; update status codes. Other domains' e2e specs using `issueTokensFor` (`orders/cart.e2e-spec.ts`, `orders/checkout.e2e-spec.ts`, `launch-events/launch-events.e2e-spec.ts`, `chat/chat.e2e-spec.ts`, `apps/sse-gateway/.../topic-stream.e2e-spec.ts`) switch to the fixture. |

### Out of scope but present

- `api/admin.controller.ts`, `application/admin.service.ts`, `admin.module.ts` (local-only external DB sync tool), `api/users.controller.ts` (empty), `application/users.service.ts` (empty), `users.module.ts` importing `FirebaseModule`, `StripeModule`, `AWSApiModule` etc. for nothing: remove or move to scripts; they are not capability S01 and drag infrastructure imports into identity (I.1/X.3 hygiene).
- TOTP and OIDC code (`application/mfa/totp.service.ts`, `infra/oidc/oidc.service.ts`, the `mfa/*` and `oidc/*` routes, `FederatedIdentity`) belongs to S02: keep working, re-wire onto `SessionIssuer`, do not extend here.

## B. Open debt-register rows naming `identity` or S01

(`docs/architecture/debt-register.md`; rows D-1…D-5, D-9, D-13 are resolved and not listed.)

| ID | Rule | What applies to S01 | Resolution | IX.7 mechanism |
|---|---|---|---|---|
| D-6 | I.2 | `api/` and `application/` import `infra/` directly: `AuthController` injects `SessionStore`, `OidcService`; `AuthSessionService` injects `UserModel`, `FederatedIdentity`, `PasswordHasher`, `KeyStore`, `SessionStore`; `AuthService` injects `KeyStore`/`UserModel`; guards import `SessionStore`. | Ports in `domain/` (`UserRepository`, `SessionRepository`, `SigningKeyRepository`, `PasswordHasherPort`, `SecretSealerPort`, `BreachCheckerPort`, `Clock`), adapters in `infra/`, injected by tokens. | n/a (internal layering) |
| D-7 | IX.4 | Other domains import `UserModel` (and via the barrel `FederatedIdentityModel`, `SigningKeyModel`) to query or associate. | Remove the three model exports from `index.ts`; consumers move to `UserDirectoryService` (see C). | **R1** |
| D-12 | IX.4 | Raw SQL on `"User"` in other domains (see C). | Replace with R1 calls; no joins. | **R1** (lookups), **R3** only if a consumer must filter/sort by user fields (none today) |
| D-17 | X.5 / I.2 | `application/user-utils.service.ts` imports `UserRawDto` from `api/users.dto` (application → api). | Move `AuthenticatedUser` type to `domain/`; `RequestWithUser` stays in `api/`. | n/a |
| D-8 | X.4 | Barrel exports infrastructure internals: `SecretBox`, `KeyStore`, `OidcService`. | `SecretBox` stays as a documented R1 export (FR-066); `KeyStore` and `OidcService` leave the barrel; apps import `AuthWorkerModule` for the rotation job. | R1 (`SecretBox`) |
| D-11, D-15, D-16, D-10, D-14 | — | Do not name identity. | — | — |

## C. `check:table-ownership` — identity's lines (reconstructed, see caveat)

Findings where another domain touches identity-owned objects (`User`, `FederatedIdentity`, `SigningKey`), with the replacement:

| Where | Kind | What | Replacement |
|---|---|---|---|
| `libs/domains/tenancy/application/shop.service.ts:10,27` | MODEL | `@InjectModel(User)`; `userModel` used for lookups (invites, members) | R1 `UserDirectoryService.findByEmail`, `getUsersByIds` |
| `libs/domains/tenancy/application/shop.service.ts:71` | SQL | `SELECT … FROM "ShopMembership" m JOIN "User" u ON u.id = m."userId"` | Query `ShopMembership` only; resolve e-mails with R1 `getUsersByIds(userIds)` (batch) |
| `libs/domains/tenancy/tenancy.module.ts:8,31` | MODEL | `SequelizeModule.forFeature([…, User])`, imports `UserModel` | Drop `User` from `forFeature`; import `AuthModule` only |
| `libs/domains/notifications/application/preferences.service.ts:128` | SQL | `FROM "User" u LEFT JOIN "NotificationSettings" s ON s."userId" = u.id` | Read `NotificationSettings` only; recipient contact via R1 `getUsersByIds` (owner: S28) |
| `libs/domains/chat/infra/chat-offline.ts:88` | SQL | `JOIN "User" u ON u.id = :authorId` (chat-sync) | R1 `getUsersByIds([authorId])` (owner: S24) |
| `libs/domains/chat/infra/models/chat-channel-member.model.ts:15,99`, `chat-channel.model.ts:15,85`, `chat-message.model.ts:14,91` | MODEL (association) | `@ForeignKey(() => User)` / associations | Plain `userId` UUID column, no association (IX.4) |
| `libs/domains/catalog/infra/models/product.model.ts:14,74` | MODEL (association) | `@ForeignKey(() => User)` | Plain ID column (owner: S05) |
| `libs/domains/orders/infra/models/bis-order.model.ts:18` | MODEL (association) | `User` association | Plain ID column (owner: S10) |
| `libs/domains/payments/infra/models/ledger-entry.model.ts:18`, `payments/ledger.module.ts:3` | MODEL | `UserModel` association; module imports `UserModel` | Plain ID column; existence checks through R1 (owner: S14) |
| `libs/domains/seller-onboarding/onboarding.e2e-spec.ts:81` | SQL (test) | `UPDATE "User" SET role` | Seed helper in `test/seeds` (allowed for test code, IX.6) |
| `test/seeds/*.ts`, `auctions/…e2e-spec.ts`, `payments/payment.e2e-spec.ts` | MODEL (test) | seed/clean helpers and specs import `UserModel` | Allowed only in seed/clean helpers (IX.6); specs use the fixture |

Identity's own side: `AuthApiModule`/`AuthModule` register `SequelizeModule.forFeature([User, FederatedIdentity])`/`[User, SigningKey]` — all owned by identity (registry `User: 'domain:identity'`); no gap. Verify `SigningKey` and `FederatedIdentity` have registry entries in `db/ownership.ts`, and add registry entries for any new table (reset tokens) in the same PR (IX.3). New session and refresh-token records live in the key-value store and the cache, outside the Postgres registry.

After the work: `pnpm --dir packages/backend check:table-ownership --strict` must report **0** findings naming `User`, `FederatedIdentity` or `SigningKey`; `pnpm check:boundaries` must show no identity-related error; `pnpm check:module-graph` stays 9/9.

## D. Order of work

1. Pure units first (verifier, CSRF token, rotation policy, key-cache policy, service-token policy/cache, hasher matrix, bounded concurrency, secret box): `test-plan.md` Unit column.
2. Ports and adapters (D-6) with a clock; remove legacy token path; new principal.
3. Registration (uniform response + events), login/throttling, refresh/session store atomicity, session endpoints.
4. Cookie delivery and CSRF; JWKS/rotation job; service tokens; password reset.
5. Public barrel change + R1 services; migrate the consumers in section C in their capabilities' PRs (S03, S05, S10, S14, S24, S28), then drop the model exports.
6. Split and rewrite e2e files; contracts schemas; record the green run (VII.9).
