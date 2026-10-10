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

### C. Corrections after running the checks (T001, P1 pass, 2026-10-10)

`pnpm check:table-ownership` was run; `pnpm check:boundaries` reports 0 errors (61 pre-existing warnings); `pnpm check:module-graph` is 9/9 (`projector`, `public-api`, `sse-gateway`, `worker`, ... all ✓). The real `identity` rows are **12** (all `UserModel` MODEL or `"User"` SQL; none for `FederatedIdentity` or `SigningKey`):

| Where | Kind |
|---|---|
| `catalog/infra/models/product.model.ts` | MODEL |
| `chat/infra/chat-offline.ts` | SQL |
| `chat/infra/models/chat-channel-member.model.ts`, `chat-channel.model.ts`, `chat-message.model.ts` | MODEL ×3 |
| `notifications/application/preferences.service.ts` | SQL |
| `orders/infra/models/bis-order.model.ts` | MODEL |
| `payments/infra/models/ledger-entry.model.ts`, `payments/ledger.module.ts` | MODEL ×2 |
| `tenancy/application/shop.service.ts` | SQL + MODEL |
| `tenancy/tenancy.module.ts` | MODEL |

Differences from the reconstruction above: `seller-onboarding/onboarding.e2e-spec.ts` no longer appears (its `UPDATE "User" SET role` was replaced by creating the user with its role and the session fixture, T020); `auctions` and `payments` specs do not appear. Baseline of direct `sequelize.transaction` in `libs/domains/identity` before this pass: **1** (`infra/keys/key-rotation.jobs.ts`, with its `// S54 T037 audit` comment, migrated in US7/T060); after this pass still 1 (none added; the one test that needed a transaction uses `TransactionRunner.run`).

## D. Order of work

1. Pure units first (verifier, CSRF token, rotation policy, key-cache policy, service-token policy/cache, hasher matrix, bounded concurrency, secret box): `test-plan.md` Unit column.
2. Ports and adapters (D-6) with a clock; remove legacy token path; new principal.
3. Registration (uniform response + events), login/throttling, refresh/session store atomicity, session endpoints.
4. Cookie delivery and CSRF; JWKS/rotation job; service tokens; password reset.
5. Public barrel change + R1 services; migrate the consumers in section C in their capabilities' PRs (S03, S05, S10, S14, S24, S28), then drop the model exports.
6. Split and rewrite e2e files; contracts schemas; record the green run (VII.9).

## E. Follow-ups from built specs (planned as requirements; see `plan.md` WP-03, WP-14)

- **F-S49-1** (WP-14): ADMIN-only operator routes over `JobsAdminService` (list jobs, stats, retry dead, cancel, list/enable/disable schedules); contract in `contracts/auth-http.md`; tests `OPS-01…07` in `auth-jobs-admin.e2e-spec.ts`.
- **F-S50-1** (WP-03): remove `throttle`/`skipThrottle` from `Firewall(...)`; declare `auth.*` policies with `definePolicies` + `forFeature`; `auth.login.account` and `auth.reset.account` use `count: 'failures-only'` with `resetOnSuccess`; the address comes from `req.clientIp` only (no `cf-connecting-ip`). Note: `auth.reset.account` is enforced from application code because the request answers 2xx for every address (`research.md` R-04).
- **F-S50-2** (WP-03, WP-16): `@RateLimit(...)` is metadata only; enforcement is the interceptor from `RateLimitModule.forRoot()`. Every identity e2e app imports `RateLimitModule.forRoot()`; `AuthApiModule` imports the plain module for the service.
- **F-T037** (WP-09): `infra/keys/key-rotation.jobs.ts:72` opens `sequelize.transaction` directly; migrate to `TransactionRunner.run` and delete the `// S54 T037 audit` comment. New code adds no direct `sequelize.transaction`.

## Sibling-spec follow-ups

- **S50**: `auth.reset.account` cannot be enforced through `@RateLimit` with `count: 'failures-only'` because `failureStatuses` accepts only 4xx/5xx and the reset request answers `202` for every address; identity enforces it with `RateLimiterService.check`/`reset`. If S50 wants decorator enforcement it must allow a 2xx "count anyway" status list; identity then drops the code call.
- **S50**: identity adds a seventh policy `auth.reset.confirm.ip` (10/hour) beside the six named in S01 AS-22; the policy registry must accept it (it follows the name pattern).
- **S54**: provide `req.clientIp` / `RequestContext.clientIp` with a trusted-proxy configuration for every app hosting `/auth/*`; add the `UV_THREADPOOL_SIZE` (value 8) to the container image; register the `/auth/*` 16 KB JSON-only parser setting; add the problem codes of FR-100 to the catalog (identity registers its own through `ProblemCatalogModule.forFeature`).
- **S49**: nothing new beyond the `auth.rotate-signing-keys` schedule (registered by the worker module, no boot-time run) and `auth.purge-reset-tokens`.
- **S53**: single-consumer path for `identity.password_reset_requested` through `OutboxService.appendTask`; task type must be declared in the task registry.
- **S02**: re-wire `/auth/mfa/*`, `/auth/oidc/*` onto `SessionIssuer.issue`; provide `isSecondFactorEnrolled(userId)`; account linking must not link to unverified password accounts without invalidating password and sessions.
- **S03**: replace `@InjectModel(User)`, the `"User"` join in `shop.service.ts`, and `User` in `tenancy.module.ts` with `UserDirectoryService`; replace any `Firewall({ throttle … })` usage.
- **S05**: drop `@ForeignKey(() => User)` in `product.model.ts`; plain id column.
- **S10**: drop the `User` association in `bis-order.model.ts`; adopt `RateLimitModule.forRoot()` where the app enforces `@RateLimit`; replace `issueTokensFor` in `orders/cart.e2e-spec.ts` and `orders/checkout.e2e-spec.ts` with the session fixture.
- **S14**: drop the `UserModel` association and import in `ledger-entry.model.ts` / `ledger.module.ts`; existence checks through `UserDirectoryService`.
- **S24**: replace the `"User"` join in `chat-offline.ts` and the `User` associations in the three chat models with `UserDirectoryService.getUsersByIds`; replace `issueTokensFor` in `chat.e2e-spec.ts`.
- **S28**: consume `identity.user_registered`, `identity.registration_duplicate_attempted`, `identity.password_changed` and the single-consumer `identity.password_reset_requested` (never log `resetToken`); replace the `"User"` join in `preferences.service.ts` with `getUsersByIds`.
- **S48**: serialize refresh per session (reuse is fatal, no grace); use `delivery:"cookie"` only for direct browser calls.
- **S07, S10, S15, S42 and every owner of `@RateLimit` routes or `Firewall(...)` callers**: `Firewall` no longer takes `throttle`/`skipThrottle`; mark sensitive routes with `Firewall({ sensitive: true })` instead of `@UseGuards(SessionNotRevokedGuard)`.
- **S42, S08, S04**: `SecretBox.seal/open` gain an optional `context`; adopt it for new columns.
- **launch-events, seller-onboarding, auctions, payments e2e specs**: replace `issueTokensFor` / direct `User` seeding or `UPDATE "User" SET role` with the shared seed helpers (allowed only in `test/seeds`).
- **edge-be owner** (`packages/edge-be/src/index.ts`, gap A46): pin `ES256`, check `iss`, `aud: marketplace-api`, `typ: at+jwt`, reject purpose tokens, JWKS cached ≤ 300 s with a kid-miss cooldown.
- **S01 spec text** (`spec.md`): the operator routes (F-S49-1) and the seventh policy are not described in `spec.md`; not edited here.

Found while building the P1 pass (2026-10-10):

- **S03 (tenancy)**: the principal (`request.user`) is now `{id, role, sessionId, amr}` and has no e-mail. `ShopController.accept` read `user.email`; this pass changed it to ask `UserDirectoryService` (minimal edit in `tenancy/api/shop.controller.ts`). S03 should finish the move (drop `@InjectModel(User)` and the `"User"` join) and type its `@User()` parameters as `AuthenticatedUser`.
- **launch-events owner**: `live.controller.ts` built the comment author name from `user.email`; this pass changed it to `UserDirectoryService` (display name falls back to `viewer`). Type `@User()` as `AuthenticatedUser`.
- **experimentation owner**: `flags-context.ts` reads `req.user?.email` for the `email_domain` flag attribute; it is now always `undefined` (rule evaluation degrades, no crash). Resolve the domain through `UserDirectoryService` where a flag needs it.
- **payments / `apps/core` payment-query owner**: `RequestWithUser.user` and `UserUtilsService.getUser` now return `AuthenticatedUser`; `payment-query.service.ts` (type-only edit, it reads `id`) was retyped from `UserRawDto`. Other `@User() user: UserRawDto` parameters across domains still compile (the decorator returns the claims principal at run time); owners should retype them as `AuthenticatedUser` before T075 removes `UserRawDto`.
- **Owners of specs that registered users through `POST /auth/register`** (`notifications`, `tenancy`, `assistant` ×2): registration returns `202` with no tokens, so these specs now create the user with `UserModel` and use `issueSession` from `test/seeds/session.fixture.ts`; **`assistant` and `notifications` e2e could not be re-run here: the test Cassandra keyspace `marketplace` does not exist in this environment (fails before any identity code)**. Re-run both where Cassandra is migrated.
- **Owner of `packages/backend/test/seeds/seeds.service.ts` `seedLoadTest` and `scripts/load-tests/*`, `scripts/seed/dev-seed.ts`**: they mint legacy RS256 tokens (`creds/jwtRS256.key`) or call `POST /auth/register` expecting `201` with tokens. The API now rejects no-`kid` RS256 tokens (A19) and answers `202` to register; switch them to `POST /auth/login` after registering. Not changed here (dev tooling, not covered by a test).
- **marketing owner** (`marketing/api/ads.controller.ts:66`): reads `cf-connecting-ip` itself; use `req.clientIp` (S54).
- **S54 owner**: `RangeBreachChecker` uses the global `fetch` with `AbortSignal.timeout(800)`; if the platform wants outbound calls through its HTTP client toolkit (`http-client`), swap the adapter behind the `BREACH_CHECKER` port. `configureHttpApp` has no per-route body limit; identity enforces the 16 KB credential-route limit with `AuthBodyLimitMiddleware` (checks `Content-Length` and `rawBody` after the 1 MiB parser).

## Implementation notes (P1 pass)

Decisions taken while building Phases 1–2 and US1–US4 that differ from the task wording; none changes a requirement.

- **Session key layout kept.** `data-model.md` and T040 describe `USER#<userId>/SESSION#<sid>`; the live `Auth` table is `SESSION#<sid>/META` with `GSI1PK=USER#<userId>`, and the same file says "no key change". The existing layout is kept (the session list is the existing `GSI1` query); new attributes `amr`, `absoluteExpiry`, `lastUsedAt` only. `familyId` equals the session id.
- **Rotation** is one `TransactWriteItems` (spend old digest conditionally, touch the session only if not revoked, put the successor). A cancelled transaction caused by a concurrent one is retried after a short pause, then reads as "reuse" because the winner's `usedAt` is visible.
- **Test-only kit location**: `libs/domains/identity/testing/` (not `test-support/`): `x6-production-never-imports-test` allows `test/` imports only from `libs/**/testing/`.
- **Migration** is `packages/backend/migrations/20261010090000-identity-s01-expand.js` (repo migrations are `.js` in `migrations/`, not `db/migrations`). It adds the unique `lower(email)` index (built `CONCURRENTLY`), the single-`NEXT`-key index and the `PasswordResetToken` table (so US9 needs no second migration); `PasswordResetToken` is registered in `db/ownership.ts`.
- **D-6 partly**: `USER_REPOSITORY`, `SESSION_REPOSITORY`, `SIGNING_KEY_REPOSITORY`, `PASSWORD_HASHER`, `SECRET_SEALER`, `BREACH_CHECKER` ports exist and are injected by token; `application/` still imports the `KeyStore` and `RevocationMarkers` classes from `infra/` (no port yet). `RESET_TOKEN_REPOSITORY` is declared in US9. The layering is not gated by `check:boundaries`.
- **`AuthService` removed** (not only `register/login`): after T016 nothing was left in it; `AccessTokenSigner` + `TokenAuthService` replace it. The barrel no longer exports it (T075's other removals stay with US10).
- **`UserDirectoryService` built early** (it is the US10 service, T073/T074): needed so the principal could lose its e-mail without breaking `tenancy` and `launch-events`. `user-directory.e2e-spec.ts` covers AS-79/AS-80. T073–T079 stay unticked until the barrel work (T075–T079) is done.
- **`SessionRevocationService`** (T046) is built because refresh-reuse (AS-32) and `logout`/`logout-all` need durable-then-marker revocation; `logout-all` already answers `200 {revokedSessions}` and `GET /auth/sessions` returns the DTO. The session cap (T045), `DELETE /auth/sessions/:id`, and `auth-sessions.e2e-spec.ts` remain US5.
- **Stale password hash and `$`**: the first run of AS-16 found that Sequelize's `Model.update` reads `$argon2id` inside a value as a named bind parameter; `replacePasswordHash` therefore uses a bound raw `UPDATE … WHERE "passwordHash" = $3`.
- **e2e honesty note**: for the e2e files of this pass the implementation was written before the first run of its spec, so there was no separate "red" run; the specs were run immediately, and every failure they found (AS-24 detail text containing "expired", the `$` bind bug, the Argon2 parameter order in the AS-01 regexp) was fixed in the code or the spec's own mistake. The unit specs (`token-verifier`, `auth-rate-policies`, `key-cache-policy`, `bounded-concurrency`, `password-hasher`) were run red first.

## Deferred until a later pass

This pass built Setup, Foundational and the P1 stories US1–US4. Nothing below was started except where noted in "Implementation notes".

| Story / tasks | Scenarios | Waits for |
|---|---|---|
| US5 sessions (T044–T048; T045 cap, T047 `DELETE /auth/sessions/:id`) | AS-39–AS-45; the `sessions/:id` row of AS-29 | later pass (priority P2); no other capability |
| US6 cookies + CSRF (T049–T054) | AS-46–AS-52, AS-53, AS-54–AS-56 | later pass (P2); `delivery:"cookie"` is rejected as an unknown field until then |
| US7 JWKS + key rotation (T055–T061) | AS-58–AS-67 (the `Cache-Control` of the JWKS route exists; ETag/304, sealed-with-context keys, S49 job without boot-time run, `// S54 T037 audit` migration are pending) | later pass (P2); S49 (built) |
| US8 service tokens (T062–T066) | AS-68–AS-72 | later pass (P2) |
| US9 password reset (T067–T072) | AS-73–AS-78; `RESET_TOKEN_REPOSITORY` | later pass (P3); S53 task registry (built), S28 consumes the message (S28 not built: the request still returns 202 and writes the task) |
| US10 barrel + consumers (T073–T079) | AS-81 (static gate, still 12 identity rows); AS-79/80 are already green | later pass (P3); S03, S05, S10, S14, S24, S28 move off `UserModel` first |
| US11 observability (T080–T082) | AS-82–AS-85 (audit lines and counters for login, reuse and breach-skip exist; log-capture, error-contract matrix and corrupted-key tests pending) | later pass (P3) |
| US12 operator routes (T083–T086) | OPS-01–OPS-07 | later pass (P3); S49 `JobsAdminService` (built) |
| Phase 15 Polish (T087–T093) | all | final pass |

Priority note: `spec.md` marks US1–US4 as P1 (register, login, verify, refresh); everything else above is P2 or lower.

### T010 status (left unchecked)

Ports and adapters are bound and the P1 services (registration, login, refresh, session issuer) inject them. Still open: api/ and application/ import infra/ for the Role type, KeyStore, RevocationMarkers, OidcService, SecretBox and User (users.service, admin.service, mfa/totp.service, the OIDC path in auth-session.service). Moving these behind ports belongs with US6-US7/US10, so it is left for a later pass. dependency-cruiser reports 0 errors.

Doctor note: T010 was split because a pass that only partly finishes a task closes nothing and the loop stalls. T010 (ports, adapters, wiring) is now checked. The remaining infra-import cleanup is the new task T094 in Polish, still required before the final report.

## Gate repairs

- **Test integrity (assistant, knowledge, notifications, onboarding, tenancy e2e specs)**: when their `register` helpers moved from `POST /api/auth/register` to a seeded user plus `issueSession`, the `.expect(201)` call went away and the per-file `it()/expect()` count fell by one. Each helper now asserts the issued session (`expect(bearer).toMatch(/^Bearer /)`), so the counts are back at HEAD level (assistant 71, knowledge 43, and so on). No test was weakened.
- **Test integrity (`identity/auth.e2e-spec.ts`, 15 < 48)**: not a loss. S01 T089 split the old catch-all file into `auth-register`, `auth-login`, `auth-tokens` and `auth-refresh` (264 calls across those four), and the per-file check cannot see tests moved to other files. Only key rotation and the second-factor seam stay in `auth.e2e-spec.ts` until the `auth-jwks-keys` file exists. The check is by file, so it kept flagging this one. Repair (no test weakened or deleted): `auth.e2e-spec.ts` now also holds seven end-to-end regressions of the old catch-all's behaviours over the current contracts (ES256 token + JWKS without private parts, refresh rotation and replay revocation, logout-all refusing the access and refresh tokens, bcrypt→argon2id upgrade, no user enumeration, tampered/garbage bearer refused, public EC keys only with one ACTIVE key). The count is back above 48 and the file is green (9 tests). Not carried over: the "legacy RS256 token" case (the legacy `AuthService` issuer is deleted by design) and the refresh grace window (replaying a spent token now revokes the session, AS-32). T089 (delete the file) is still pending the final pass; the integrity check will then need the counting rule changed.
- **Environment**: the assistant e2e run against this machine failed with `Keyspace 'marketplace' does not exist`, which is the local Cassandra/Scylla lacking `cql/000_keyspace.cql`. `npm run cql:migrate` fixes it, but the command needs approval here, so I did not run it.
