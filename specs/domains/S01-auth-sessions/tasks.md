# Tasks: S01 — Registration, Login, Sessions, Refresh Rotation, JWKS, Service Tokens

**Input**: `plan.md`, `spec.md`, `test-plan.md`, `gaps.md`, `questions.md` (defaults accepted), `research.md`, `data-model.md`, `contracts/`, `quickstart.md`, constitution.
**Tests**: required (VII, test-plan.md). For every test-plan row the failing test task comes **before** the code task that satisfies it.

## Conventions

- `ID/` = `packages/backend/libs/domains/identity/`. Run backend commands from `packages/backend`.
- E2E: `/opt/sdd/repo/scripts/sdd/test-spec.sh <file>` (condensed output; open the full log only if needed). Units: `pnpm jest <path>`. Narrowest test first; the whole capability suite once, in the last phase.
- If the same test still fails after 5 fix attempts: stop, write blocker + what was tried + hypothesis into `questions.md`.
- Undoing work: edit by hand, never `git checkout/restore/reset/stash/clean`.
- Transactions: `TransactionRunner.run` / `@Transactional` only. Never add a direct `sequelize.transaction`; when touching a file with one, migrate it and delete its `// S54 T037 audit` comment.
- Sibling-spec changes are never edited in their spec; they go under `## Sibling-spec follow-ups` in `gaps.md` (already present; extend if new ones appear).
- Every e2e app imports `RateLimitModule.forRoot()` and boots the production pipe, filter, prefix and interceptors (F-S50-2).
- Story labels: US1–US11 are spec.md stories; **US12** = ADMIN operator routes (S49 follow-up F-S49-1, plan WP-14).
- Gap IDs (A1…A52, D-n, C, F-…) refer to `gaps.md`. Every gaps item appears in the coverage table at the end.

## Phase 1: Setup

- [X] T001 Run `pnpm --dir packages/backend check:table-ownership` and `pnpm check:boundaries` once; reconcile `gaps.md` section C with the real `MODEL`/`SQL` rows for `identity` (append corrections under section C; record baseline counts of `sequelize.transaction` in `ID/`)
- [X] T002 [P] Add `FakeClock`-based frozen-time helper use and a `BreachCheckerPort` fake in `packages/backend/test/fakes/breach-checker.fake.ts` (configurable: breached set, timeout/throw mode)
- [X] T003 [P] Create zod schemas in `packages/contracts/src/auth/`: `authSessionSchema`, `mfaChallengeSchema`, `sessionListItemSchema`, `jwksSchema`, `passwordResetSchema`, `jobsAdminSchemas` (JobDto without payload, ScheduleDto, stats) and export from the package index (A51)
- [X] T004 [P] Add `UV_THREADPOOL_SIZE=8` to the container image/Dockerfile and the e2e environment; document the env in the Dockerfile (A12, P0202)
- [X] T005 Write the e2e harness `ID/test-support/auth-app.ts` booting `AuthApiModule`/`AuthModule` + `RateLimitModule.forRoot()` with production pipe/filter/prefix/interceptors, real Postgres/Redis/Dynamo, `beforeEach` reset, frozen clock (F-S50-2); no spec depends on it yet

## Phase 2: Foundational (blocks all stories)

**Ports, clock, principal, rate-limit plumbing, verifier, session issuer.**

- [X] T006 [P] Write failing unit spec `ID/domain/token-verifier.spec.ts` (`it.each` matrix: forged signature, `alg` none/HS256/RS256, wrong `iss`/`aud`/`typ`, expired, `nbf` in future, 5-second clock tolerance, malformed `kid`, purpose tokens `mfa+jwt`/`svc+jwt` rejected as access, missing claims; accepted: valid ES256 `at+jwt`) — AS-23
- [X] T007 Implement pure `ID/domain/token-verifier.ts` returning principal `{id, role, sessionId, amr}` from claims only (ES256 pinned; `exp/iss/aud=marketplace-api/typ=at+jwt/nbf` checked; `kid` format-checked) (A15, A19, A20, A21)
- [X] T008 [P] Define domain ports in `ID/domain/ports/` with injection tokens `USER_REPOSITORY`, `SESSION_REPOSITORY`, `SIGNING_KEY_REPOSITORY`, `RESET_TOKEN_REPOSITORY`, `PASSWORD_HASHER`, `SECRET_SEALER`, `BREACH_CHECKER` (`isBreached(password): Promise<boolean>`) per `contracts/identity-services.md` (D-6)
- [X] T009 [P] Create `ID/domain/authenticated-user.ts` (`AuthenticatedUser {id, role, sessionId, amr[]}`, `ServicePrincipal`); make `ID/api/request-with-user.ts` use it; move `UserRawDto` dependency out of `ID/application/user-utils.service.ts` (D-17, A20)
- [X] T010 Adapt infra to ports: `ID/infra/models/` repositories implementing `USER_REPOSITORY`/`SIGNING_KEY_REPOSITORY`, `ID/infra/crypto/password-hasher.ts` → `PASSWORD_HASHER`, `ID/infra/crypto/secret-box.ts` → `SECRET_SEALER`; wire tokens in `ID/auth.module.ts`/`auth-api.module.ts` (D-6; the rule that `api/` and `application/` import no `infra/` path is closed by T094)
- [X] T011 Inject `CLOCK` in the session store (`ID/infra/sessions/session-store.service.ts` lines using `Date.now()/new Date()`) and `ID/infra/keys/key-rotation.jobs.ts`; domain functions take `now` (A30, I.3); run `pnpm check:no-wallclock`
- [X] T012 [P] Write failing unit spec `ID/domain/auth-rate-policies.spec.ts`: the seven policies exist with exact limits and `failMode: 'closed'` — `auth.register.ip` 10/h; `auth.login.ip` 20/min; `auth.login.account` 5/15 min `count:'failures-only'` + `resetOnSuccess`, `key:'body.email'`; `auth.refresh.ip` 60/min; `auth.reset.ip` 5/h; `auth.reset.confirm.ip` 10/h; `auth.reset.account` 3/h failures-only + resetOnSuccess; key normalisation equals the DTO's trim+lower-case — AS-22
- [X] T013 Implement `ID/domain/auth-rate-policies.ts` with `definePolicies('identity', …)`; register via `forFeature` in `ID/auth-api.module.ts`; delete `ID/rate-limit-policies.ts` (F-S50-1, A7, A10, A37)
- [X] T014 Remove `throttle`/`skipThrottle` from `ID/api/decorators/firewall.decorator.ts` (`Firewall({anonymous?, roles?, sensitive?})`); migrate all callers in `libs/domains/**` that pass them to `@RateLimit` metadata (list any other-owner callers under Sibling-spec follow-ups); `Firewall({sensitive:true})` applies the session-not-revoked guard internally (A24, F-S50-1)
- [X] T015 Resolve client IP only from `req.clientIp` / `RequestContext.clientIp`; delete the `cf-connecting-ip` read in `ID/api/auth.controller.ts` (A9, F-S50-1). Verify `RateLimitModule.forRoot()` is installed in `core`, `sse-gateway`, `public-api` apps (F-S50-2)
- [X] T016 Delete the legacy path: `AuthService.register/login`, RS256 no-`kid` verification, `issueTokensFor`, `jwt_private_key` config use in `ID/application/auth.service.ts` and `libs/common/config/api-config.service.ts` (A2, A19); keep `ID/application/auth-session.service.ts` only until T030/T040 replace it
- [X] T017 [P] Write failing unit spec `ID/domain/key-cache-policy.spec.ts`: forced reload at most once per 30 s for unknown `kid`, set TTL 300 s, malformed `kid` never triggers a reload — AS-65
- [X] T018 Implement `ID/domain/key-cache-policy.ts` and use it in the key store reload path (A21)
- [X] T019 Implement `SessionIssuer` skeleton in `ID/application/session-issuer.service.ts` (`issue({userId, amr, delivery, meta})`, `createChallenge`, `verifyChallenge` — `typ: mfa+jwt`, `aud: mfa`, 5 min): signs tokens first, then persists the session, and revokes on failure (A15, A18, A49); access token claims `iss: marketplace`, `aud: marketplace-api`, `sub`, `sid`, `role`, `amr`, `iat`, `nbf`, `exp = iat+300`, `jti`, header `typ: at+jwt`, `kid`, no e-mail (A16); lifetime default 300 s in `api-config.service.ts`
- [X] T020 Create session fixture `issueSession(userId, opts)` in `packages/backend/test/seeds/session.fixture.ts` over `SessionIssuer`; switch these specs to it and re-run each: `libs/domains/orders/cart.e2e-spec.ts`, `orders/checkout.e2e-spec.ts`, `launch-events/launch-events.e2e-spec.ts`, `chat/chat.e2e-spec.ts`, `apps/sse-gateway/**/topic-stream.e2e-spec.ts` (A52); delete the `UPDATE "User" SET role` in `seller-onboarding/onboarding.e2e-spec.ts` in favour of a seed helper

**Checkpoint**: `tsc --noEmit`, boundaries check, T006/T012/T017 green.

## Phase 3: US1 — Register without revealing membership (P1) 🎯 MVP

**Goal**: uniform `202 {"status":"accepted"}`, outbox events, equal work.
**Independent test**: `auth-register.e2e-spec.ts` green.

- [X] T021 [US1] Write failing `ID/auth-register.e2e-spec.ts` (top-level `describe('Registration')`) covering AS-01 (202, one user, `identity.user_registered` outbox row, no cookies), AS-02 (case/whitespace duplicate → identical body/status/headers, `registration_duplicate_attempted` row with existing id), AS-03 (`Promise.all` same address → one user, store-level `lower(email)` uniqueness), AS-04 (role whitelist `USER|SELLER`, unknown fields rejected, mass assignment), AS-05 (validation classes, `validation_failed` shape, no secret echoed), AS-06 (breached → 422 `weak_password` for new and existing address), AS-07 (breach timeout → fail open + `auth_breach_check_skipped_total`), AS-08 (hasher pass-through spy: exactly one hash on both paths), AS-09 (11th request/hour → 429); parse responses with contracts schema
- [X] T022 [US1] Expand migration `packages/backend/db/migrations/<ts>-identity-s01-expand.ts` (with `lock_timeout`): `CREATE UNIQUE INDEX CONCURRENTLY … ON "User" (lower(email)) WHERE email IS NOT NULL`; partial unique index for one `NEXT` signing key if absent; create `PasswordResetToken` (columns per T068) — expand-only; add `PasswordResetToken: 'domain:identity'` to `packages/backend/db/ownership.ts`; add an `EXPLAIN` assertion in T021 proving lookups use the index (A6)
- [X] T023 [P] [US1] Implement `ID/domain/password-policy.ts`: password 12–128 chars for registration/reset (login: ≤ 128 only), not equal to the address, plus `BREACH_CHECKER` call; email ≤ 254 chars, trimmed, lower-cased, valid address (A4)
- [X] T024 [P] [US1] Implement `ID/infra/breach/` k-anonymity range client adapter for `BREACH_CHECKER`: 800 ms timeout, failure → skip + counter `auth_breach_check_skipped_total` (A4)
- [X] T025 [US1] Implement `ID/application/registration.service.ts` using `TransactionRunner.run`: insert user (or detect duplicate) and append `identity.user_registered` / `identity.registration_duplicate_attempted` through `OutboxService` in the same transaction; hash exactly once on both paths; role whitelist; no network call inside the transaction (A1, A3, A5, A8)
- [X] T026 [US1] Rewrite `POST /auth/register` in `ID/api/auth.controller.ts` + `ID/api/auth.dto.ts` (explicit DTO, `@RateLimit('auth.register.ip')`, `202 {"status":"accepted"}`, `MaxLength` 128 for passwords); confirm global pipe options `whitelist/forbidNonWhitelisted` (A4, A7, A8)
- [X] T027 [US1] Add `identity.user_registered` and `identity.registration_duplicate_attempted` zod contracts to `ID/domain/events.ts` per `contracts/events.md` (envelope, IDs only) and export from the barrel
- [X] T028 [US1] Run `test-spec.sh ID/auth-register.e2e-spec.ts` until green

## Phase 4: US2 — Password login, safely (P1)

**Independent test**: `auth-login.e2e-spec.ts` + `password-hasher.spec.ts` + `bounded-concurrency.spec.ts` green.

- [X] T029 [P] [US2] Write failing unit specs `ID/infra/crypto/password-hasher.spec.ts` (AS-17: `valid`, `needsRehash`, null hash, malformed hash returns `{valid:false, needsRehash:false}` and never throws; bcrypt legacy and old-Argon2 params) and `ID/domain/bounded-concurrency.spec.ts` (AS-18: concurrency 4, queue 64, overflow → rejection mapped to `503 overloaded` + `Retry-After: 1`; startup check fails when concurrency > `UV_THREADPOOL_SIZE − 1`)
- [X] T030 [US2] Implement `ID/domain/bounded-concurrency.ts` and wire it into `ID/infra/crypto/password-hasher.ts` (Argon2id; malformed-hash handling; startup check registered with `ConfigRules`) (A12, A13)
- [X] T031 [US2] Write failing `ID/auth-login.e2e-spec.ts` (`describe('Login')`) covering AS-10 (200 body tokens, claims profile, `no-store`+`Pragma: no-cache`, session persisted with refresh digest only), AS-11 (identical 401 `invalid_credentials` for unknown/wrong, one verification either way via spy), AS-12 (6th failure in 15 min → 429 incl. unknown address), AS-13 (success resets counter), AS-14 (21st/min per IP → 429), AS-15 (spoofed `cf-connecting-ip`/`X-Forwarded-For` from untrusted peer ignored), AS-16 (bcrypt and old-Argon2 rehash; wrong password leaves hash; conditional update on old hash), AS-19 (enrolled second factor → `{mfaRequired:true, mfaToken}` `typ: mfa+jwt`, no session), AS-20 (new `sid` each login), AS-21 (128-char ok, 129 → 400, 5-char wrong password → 401, 16 KB+1 body → 413, missing fields → 400)
- [X] T032 [US2] Implement `ID/application/login.service.ts`: lookup via `USER_REPOSITORY`, dummy-hash verify for unknown address, `rehash` as `UPDATE … SET passwordHash = :new WHERE id = :id AND passwordHash = :old`, MFA branch via `SessionIssuer.createChallenge`, session via `SessionIssuer.issue`; failures-only counting + `resetOnSuccess` through the S50 interceptor (A10, A11, A15, A17-hook)
- [X] T033 [US2] Rewrite `POST /auth/login` in `ID/api/auth.controller.ts` + `auth.dto.ts`: `@RateLimit('auth.login.ip','auth.login.account')`, `Cache-Control: no-store` + `Pragma: no-cache`, body ≤ 16 KB parser setting, login password cap 128 only (A4, A14); delete `ID/application/auth-session.service.ts` once nothing references it
- [X] T034 [US2] Run `test-spec.sh ID/auth-login.e2e-spec.ts` and the two unit specs until green

## Phase 5: US3 — Every service verifies tokens locally and strictly (P1)

**Independent test**: `auth-tokens.e2e-spec.ts` green (verifier unit T006 already).

- [X] T035 [US3] Write failing `ID/auth-tokens.e2e-spec.ts` (`describe('Token authentication')`): AS-24 (every failure class → identical 401 `invalid_token`; optional guard continues anonymous), AS-25 (`X-User-Id`/`X-Role` ignored), AS-26 (`x-auth-token` header and cookie rejected), AS-27 (revoked session: sensitive route 401 immediately, ordinary route until `exp`; revocation store down → sensitive fails closed), AS-28 (role change visible only after refresh), AS-29 (`it.each` over every protected route → 401 without credentials), AS-30 (auth and throttling run before validation), AS-57 (`no-store` on credential responses)
- [X] T036 [US3] Rewrite `ID/api/guards/` : `auth.guard` using `TokenVerifier` (no DB/user lookup), `user-auth-optional.guard.ts` (keep behaviour, debug log with reason, A23), `roles.guard.ts` (role from claims, A25), `sensitive-session.guard` replacing `session-not-revoked.guard.ts` (fail closed on store error, A24); delete `ID/api/guards/extract-auth-token.ts` legacy channels `x-auth-token` header/cookie (A22); keep only `Authorization: Bearer` and `__Host-access`
- [X] T037 [US3] Rewrite `GET /auth/me` to read e-mail via `UserDirectoryService` (T068) — until then through `USER_REPOSITORY`; order pipeline guards → interceptor (throttle) → pipe (AS-30, II.2)
- [X] T038 [US3] Run `test-spec.sh ID/auth-tokens.e2e-spec.ts` until green

## Phase 6: US4 — Stay logged in; stolen refresh token dies on reuse (P1)

**Independent test**: `auth-refresh.e2e-spec.ts` green.

- [X] T039 [US4] Write failing `ID/auth-refresh.e2e-spec.ts` (`describe('Refresh token rotation')`): AS-31 (rotation, successor stored, old spent), AS-32 (replay of spent token revokes session, audit line + counter, no grace), AS-33 (`Promise.all` same token → exactly one 200 and one successor record; loser gets 401 and session revoked), AS-34 (unknown/garbage/oversized > 256 chars → single `invalid_refresh_token`), AS-35 (idle expiry boundary 30 d with frozen clock), AS-36 (absolute cap 90 d: successor expiry = min(now+30 d, absolute)), AS-37 (after logout-all / user deleted → 401), AS-38 (`auth.refresh.ip` 429, token not consumed). Delete the old grace-window test with `auth.e2e-spec.ts` (T089)
- [X] T040 [US4] Implement `SESSION_REPOSITORY` adapter `ID/infra/sessions/dynamo-session.repository.ts`: Session item `USER#<userId>`/`SESSION#<sid>` with `sid, userId, familyId, device(≤200), ip, createdAt, lastUsedAt, absoluteExpiry (epoch s), revokedAt?, revokeReason?`; refresh item `RT#<sha256 base64url>`/`RT` with `sid, userId, familyId, expiresAtEpoch (TTL attr, ≤ min(now+30 d, absoluteExpiry)), usedAt?`; rotation = one `TransactWriteItems` (mark used conditionally + put successor + assert session not revoked); expiry checked at use (TTL is cleanup only); verify the condition set against the local Dynamo first (plan hot spot 1) (A28, A29, A30)
- [X] T041 [US4] Implement `ID/application/refresh.service.ts`: single error `invalid_refresh_token` for all failures, reuse → revoke session (reason `refresh_token_reuse`) + audit + counter, durable write then Redis marker `auth:revoked:<sid>` (TTL access lifetime + 60 s) (A27, A34, A35)
- [X] T042 [US4] Rewrite `POST /auth/refresh` in `ID/api/auth.controller.ts`: `@RateLimit('auth.refresh.ip')`, refresh token ≤ 256 chars, no reuse-grace config (`auth_refresh_reuse_grace_ms` removed from `api-config.service.ts`) (A27, A37)
- [X] T043 [US4] Run `test-spec.sh ID/auth-refresh.e2e-spec.ts` until green

## Phase 7: US5 — See and end my sessions (P2)

**Independent test**: `auth-sessions.e2e-spec.ts` green.

- [ ] T044 [US5] Write failing `ID/auth-sessions.e2e-spec.ts` (`describe('Sessions')`): AS-39 (list own, DTO `[{sessionId, device, ip, createdAt, lastUsedAt, current}]`, parsed by contracts schema, no PK/SK/familyId/userId), AS-40 (DELETE other user's session → 404 `session_not_found`, unchanged), AS-41 (revoke own other session / current session → 204), AS-42 (idempotent logout 204), AS-43 (`logout-all` → 200 `{revokedSessions}`, idempotent, other user untouched), AS-44 (21st login evicts oldest with reason `session_limit`), AS-45 (`SessionRevocationService.revokeAllForUser` with real stores)
- [ ] T045 [US5] Implement `ID/application/session-admin.service.ts` (list ≤ 20 newest first; filter `revokedAt` absent and not expired; `revokeSession(userId, sessionId)` filters by user in the key condition) and session cap eviction inside `SessionIssuer.issue` (A17, A31, A32)
- [ ] T046 [US5] Implement `ID/application/session-revocation.service.ts` (`revokeAllForUser(userId, reason): Promise<number>`, `revokeSession(userId, sessionId, reason): Promise<boolean>`; durable first, marker second, error → 5xx, idempotent) (A33, A34, A49)
- [ ] T047 [US5] Create `ID/api/sessions.controller.ts` (`GET /auth/sessions`, `DELETE /auth/sessions/:sessionId` sensitive) and update `logout` (204) / `logout-all` (200 `{revokedSessions}`, sensitive) in `auth.controller.ts`; DTOs in `ID/api/sessions.dto.ts` (A31–A33, A36)
- [ ] T048 [US5] Run `test-spec.sh ID/auth-sessions.e2e-spec.ts` until green

## Phase 8: US6 — Cookie sessions with CSRF protection (P2)

**Independent test**: `csrf-token.spec.ts` + `auth-cookies-csrf.e2e-spec.ts` green.

- [ ] T049 [P] [US6] Write failing unit spec `ID/domain/csrf-token.spec.ts` (AS-53: valid; tampered MAC; truncated; other `sid`; wrong random part; constant-time compare function used)
- [ ] T050 [US6] Implement `ID/domain/csrf-token.ts`: random part + HMAC bound to `sid` (A39)
- [ ] T051 [US6] Write failing `ID/auth-cookies-csrf.e2e-spec.ts` (`describe('Cookie sessions and CSRF')`): AS-46 (`delivery:"cookie"` login sets `__Host-access`, `__Host-refresh` (`HttpOnly; Secure; SameSite=Lax; Path=/`, no `Domain`, `Max-Age` = lifetime) and `__Host-csrf` (not HttpOnly); no token in body), AS-47 (no `X-CSRF-Token` → 403 `csrf_invalid`, state unchanged), AS-48 (valid accepted; another session's token rejected), AS-49 (Bearer exempt), AS-50 (Origin allow-list; `Sec-Fetch-Site: cross-site` without Origin → 403), AS-51 (login CSRF: disallowed Origin with cookie delivery → 403 `origin_not_allowed`), AS-52 (form content types → 415 `unsupported_media_type`), AS-54 (cookie-mode refresh; rejected CSRF does not consume token), AS-55 (cookie-mode logout clears cookies), AS-56 (GET never changes state; `GET /auth/logout|logout-all|refresh` → 404/405)
- [ ] T052 [US6] Implement guards `ID/api/guards/csrf.guard.ts` (every cookie-authenticated unsafe request), `origin.guard.ts` (Origin / Fetch-Metadata), `json-only.guard.ts` (content-type check before the pipe); register origins with `ConfigRules` (A39, A40)
- [ ] T053 [US6] Cookie delivery in `SessionIssuer.issue` + `auth.controller.ts` (opt-in `delivery:"cookie"`, `__Host-access` accepted by the auth guard, refresh from `__Host-refresh` in refresh/logout) (A38, A40)
- [ ] T054 [US6] Run unit spec and `test-spec.sh ID/auth-cookies-csrf.e2e-spec.ts` until green

## Phase 9: US7 — JWKS and key rotation (P2)

**Independent test**: `key-rotation-policy.spec.ts` + `auth-jwks-keys.e2e-spec.ts` green.

- [ ] T055 [P] [US7] Write failing unit spec `ID/domain/key-rotation-policy.spec.ts` (AS-62, frozen clock matrix for `decideRotation(keys, now, cfg)`: NEXT published ≥ 24 h before promotion, ACTIVE ≥ 7 d, RETIRED purged ≥ 24 h after `retiredAt`, no-op cases, missing NEXT, missing ACTIVE)
- [ ] T056 [US7] Implement `ID/domain/key-rotation-policy.ts` (A42)
- [ ] T057 [US7] Write failing `ID/auth-jwks-keys.e2e-spec.ts` (`describe('JWKS and signing keys')`): AS-58 (JWKS: `Cache-Control: public, max-age=300, stale-while-revalidate=3600`, `ETag`, 304 on `If-None-Match`, no private members, ES256 only), AS-59 (third-party JOSE verifies from JWKS only), AS-60 (first-use bootstrap race → one ACTIVE), AS-61 (rotation promotes NEXT, old tokens still valid), AS-63 (retired key purged; its tokens rejected after), AS-64 (concurrent and repeated rotation runs → one effect), AS-66 (private key sealed at rest with context `signing-key:<kid>`)
- [ ] T058 [P] [US7] Write failing unit spec `ID/infra/crypto/secret-box.spec.ts` (AS-67: seal/open round-trip, tamper → error, wrong `context` → error, previous master key fallback, production start without master key fails, no-context legacy ciphertext still opens)
- [ ] T059 [US7] Extend `ID/infra/crypto/secret-box.ts`: versioned format, optional `context` as AAD, current + previous master key; register master-key rule with `ConfigRules` (A45, FR-066)
- [ ] T060 [US7] Implement keys: `SigningKey` `alg` narrowed to `ES256` in `ID/infra/models/signing-key.model.ts` (`kid` well-formed; `privateKeySealed`; `status NEXT|ACTIVE|RETIRED`; `activatedAt`, `retiredAt`, `createdAt`; promote = retire ACTIVE and activate NEXT in one transaction by conditional updates); `key-store.service.ts` catches only the unique violation on bootstrap (A43); `well-known.controller.ts` with ETag/304 and JWKS content type (A44); rotation as S49 scheduled single-run job `auth.rotate-signing-keys` registered by `AuthWorkerModule`, no boot-time run, using `TransactionRunner.run` and deleting the `// S54 T037 audit` comment at `ID/infra/keys/key-rotation.jobs.ts:72` (A41, F-T037)
- [ ] T061 [US7] Run unit specs and `test-spec.sh ID/auth-jwks-keys.e2e-spec.ts` until green; run `grep -n "sequelize.transaction" ID -r` (must be 0)

## Phase 10: US8 — Service-to-service tokens (P2)

**Independent test**: `service-tokens.e2e-spec.ts` + two unit specs green.

- [ ] T062 [P] [US8] Write failing unit specs `ID/domain/service-token-policy.spec.ts` (AS-71: caller allowlist, default TTL 60 s, max 300 s, below-min rejected) and `ID/domain/service-token-cache.spec.ts` (AS-72: reuse per `(caller, audience)` until 80 % of lifetime, then re-mint; frozen clock)
- [ ] T063 [US8] Implement `ID/domain/service-token-policy.ts` and `service-token-cache.ts` (A47)
- [ ] T064 [US8] Write failing `ID/service-tokens.e2e-spec.ts`: AS-68 (mint profile `svc+jwt`, ES256, `aud`, 60 s), AS-69 (probe controller with real `ServiceAuthGuard` + `@AllowedCallers`: user token → 401, service token for other audience → 401, disallowed caller → 403 `service_caller_not_allowed`), AS-70 (`exchange` on-behalf-of: `act.sub = svc:<caller>`, revoked session refused)
- [ ] T065 [US8] Implement `ID/application/service-token.service.ts` (`mint`, `exchange`), `ID/api/guards/service-auth.guard.ts`, `@AllowedCallers` decorator, audiences from config via `ConfigRules`; export from barrel (A47)
- [ ] T066 [US8] Run `test-spec.sh ID/service-tokens.e2e-spec.ts` until green

## Phase 11: US9 — Password reset (P3)

**Independent test**: `auth-password-reset.e2e-spec.ts` green.

- [ ] T067 [US9] Write failing `ID/auth-password-reset.e2e-spec.ts` (`describe('Password reset')`): AS-73 (request uniform 202 for existing / passwordless / unknown, exactly one `identity.password_reset_requested` task only for existing-with-password; `resetToken` not in logs), AS-74 (newer token invalidates older), AS-75 (confirm → 204, password replaced, all sessions revoked with `password_reset`, `identity.password_changed`), AS-76 (invalid/spent/expired token uniform 400 `invalid_reset_token`; weak password 422 keeps token), AS-77 (`Promise.all` confirm → one winner), AS-78 (`auth.reset.ip` 5/h, `auth.reset.confirm.ip` 10/h, `auth.reset.account` 3/h uniform 429)
- [ ] T068 [US9] Implement `PasswordResetToken` model + `RESET_TOKEN_REPOSITORY` adapter in `ID/infra/models/password-reset-token.model.ts`: `id` uuidv7 PK; `userId` uuid not null (plain column); `digest` text not null UNIQUE (base64url SHA-256 of a 256-bit token, raw never stored); `expiresAt` timestamptz not null (`createdAt + 30 min`); `usedAt` timestamptz null (set once by conditional update); `createdAt` timestamptz not null; index `(userId)`; match migration from T022
- [ ] T069 [US9] Implement `ID/application/password-reset.service.ts`: request marks the user's open tokens used in the same `TransactionRunner.run` as the insert and `OutboxService.appendTask('identity.password_reset_requested', {userId, resetToken, expiresAt})`; declare the task type in the S53 task registry; `auth.reset.account` enforced by `RateLimiterService.check/reset` from code (research R-04); confirm spends token by conditional update, replaces hash, revokes all sessions via `SessionRevocationService`, appends `identity.password_changed`
- [ ] T070 [US9] Add `POST /auth/password-reset/request|confirm` to `ID/api/auth.controller.ts` + `passwordResetSchema` DTOs (`@RateLimit('auth.reset.ip')`, `@RateLimit('auth.reset.confirm.ip')`); events/task schemas in `ID/domain/events.ts`
- [ ] T071 [US9] Add daily S49 job `auth.purge-reset-tokens` in `ID/auth-worker.module.ts` (delete rows with `expiresAt < now − 1 day`, bounded batch, idempotent) plus a short e2e case in `auth-password-reset.e2e-spec.ts`
- [ ] T072 [US9] Run `test-spec.sh ID/auth-password-reset.e2e-spec.ts` until green

## Phase 12: US10 — Other domains use identity without touching its tables (P3)

**Independent test**: `user-directory.e2e-spec.ts` green and AS-81 gates at 0.

- [ ] T073 [US10] Write failing `ID/user-directory.e2e-spec.ts` (`describe('User directory')`): AS-79 (`getUsersByIds` batch, `UserSummaryDto {id,email,role,createdAt}`, ≤ 500 else `TooManyIds`, soft-deleted omitted, one read), AS-80 (`findByEmail` trims + lower-cases, null when unknown)
- [ ] T074 [US10] Implement `ID/application/user-directory.service.ts` over `USER_REPOSITORY` (A49)
- [ ] T075 [US10] Barrel change in `ID/index.ts`: add `UserDirectoryService`, `UserSummaryDto`, `SessionRevocationService`, `SessionIssuer`, `ServiceTokenService`, `ServiceAuthGuard`, `AllowedCallers`, `ServicePrincipal`, `AuthenticatedUser`, event contracts, `IdentityOpsModule`; remove `AuthService`, `KeyStore`, `OidcService`, `UsersModule`, `UsersDtoModule`, `UserUtilsModule`, `AdminModule`, `CreateUserDto`, `UserRawDto`; keep `SecretBox` (D-7 partial, D-8)
- [ ] T076 [US10] Re-wire S02 code (`ID/application/mfa/totp.service.ts`, `ID/infra/oidc/*`, `/auth/mfa/*`, `/auth/oidc/*`) onto `SessionIssuer.issue`; do not extend S02 behaviour; run existing S02 specs
- [ ] T077 [US10] Remove out-of-scope code: `ID/admin.module.ts`, `api/admin.controller.ts`, `api/admin.dto.ts`, `application/admin.service.ts`, empty `api/users.controller.ts` / `application/users.service.ts`, and the Firebase/Stripe/AWS imports in `ID/users.module.ts` (gaps "Out of scope but present", WP-15)
- [ ] T078 [US10] Remove `UserModel`, `FederatedIdentityModel`, `SigningKeyModel` barrel exports **only after** consumers moved; migrate consumers where this repo's owner is S01-adjacent and safe, otherwise add/confirm Sibling-spec follow-ups in `gaps.md` for S03, S05, S10, S14, S24, S28 (section C). Keep `pnpm check:table-ownership --strict` identity lines as the target; record the remaining count and which sibling bullets cover it (D-7, D-12)
- [ ] T079 [US10] Run `test-spec.sh ID/user-directory.e2e-spec.ts`; run `pnpm check:boundaries`, `pnpm check:module-graph` (9/9), `pnpm check:table-ownership --strict` (AS-81)

## Phase 13: US11 — Operators see and trust what happens (P3)

**Independent test**: `auth-observability.e2e-spec.ts` green.

- [ ] T080 [US11] Write failing `ID/auth-observability.e2e-spec.ts` (`describe('Auth observability')`): AS-82 (audit lines + metrics for login success/failure, refresh reuse, revoke, reset, rotation), AS-83 (log capture across full flow: no password, token, hash, reset token, address in clear), AS-84 (`it.each` error classes: problem+json `type,title,status,detail,instance,requestId` + stable `code`; 5xx generic detail, no stack/query), AS-85 (corrupted signing key → generic 500 and no usable session remains)
- [ ] T081 [US11] Implement `ID/application/audit.service.ts` (audit lines with keyed hash of unknown addresses, no PII), `MetricsRegistry` counters, stable error codes in `ID/domain/errors.ts` and register via `ProblemCatalogModule.forFeature` (FR-100 list in `contracts/auth-http.md`) (A50, A51)
- [ ] T082 [US11] Run `test-spec.sh ID/auth-observability.e2e-spec.ts` until green

## Phase 14: US12 — ADMIN operator routes over `JobsAdminService` (S49 follow-up) (P3)

**Independent test**: `auth-jobs-admin.e2e-spec.ts` green.

- [ ] T083 [US12] Write failing `ID/auth-jobs-admin.e2e-spec.ts` (`describe('Operator job routes')`): OPS-01 (401 without token on every route), OPS-02 (403 for USER/SELLER/MODERATOR on every route), OPS-03 (`GET /admin/jobs` filters `status,type,shopId`, cursor, limit clamped 1–100 default 50, tampered cursor → 400 `validation_failed`, never a payload field), OPS-04 (`GET /admin/jobs/stats`), OPS-05 (`POST /admin/jobs/:id/retry`: 200 `{outcome:'RETRIED'}`, 409 `{outcome:'CONFLICT', status}`, 404; audit line has actor), OPS-06 (`POST /admin/jobs/:id/cancel` mapped like retry), OPS-07 (`GET /admin/job-schedules`, `POST /admin/job-schedules/:name/enable|disable` → `{name, enabled}`, unknown name 404); each asserts persisted job/schedule state
- [ ] T084 [US12] Create `ID/api/jobs-admin.controller.ts` + `jobs-admin.dto.ts` (`JobDto {id,type,status,runAt,attempts,maxAttempts,shopId,lastError,createdAt,finishedAt}` — never the payload) with `Firewall({roles:['ADMIN']})`, `sensitive: true` on retry/cancel/enable/disable, calling `JobsAdminService` per `specs/**/S49*/contracts/jobs-admin-service.md` (`listJobs`, `getStats`, `retryDead(id, user.id)`, `cancel`, `listSchedules`, `setScheduleEnabled`); map `InvalidCursorError` → 400
- [ ] T085 [US12] Create `ID/identity-ops.module.ts` importing the S49 admin module; host it in the `core` app only (not `sse-gateway`/`public-api`); export from barrel
- [ ] T086 [US12] Run `test-spec.sh ID/auth-jobs-admin.e2e-spec.ts` until green

## Phase 15: Polish & cross-cutting

- [ ] T087 [P] Edge-be gap A46: do not edit `packages/edge-be`; confirm the edge-be owner bullet exists under Sibling-spec follow-ups in `gaps.md` (already present) and add any new sibling bullet discovered during the work (rule 1), including `Firewall` callers of other owners changed in T014
- [ ] T088 [P] Unverified criteria: confirm `quickstart.md` "Ops artifacts" and `specs/UNVERIFIED.md` rows for SC-001 (timing), SC-005 (edge), SC-006, SC-008 (browser) exist, status `not run`; do not describe them as verified. Check every other SC-nnn (SC-002, 003, 004, 007, 009, 010) maps to a test above or add it
- [ ] T089 Delete `ID/auth.e2e-spec.ts` (legacy RS256, grace-window, `bcrypt` import, `expect(201)` on logout-all) once T021, T031, T035, T039, T044 are green (A52)
- [ ] T094 Finish D-6 (remainder of T010): `api/` and `application/` import no `infra/` path — move `Role` to `ID/domain/`; put `KeyStore`, `RevocationMarkers`, `OidcService`, `SecretBox` and `User` behind ports (importers: users.dto, well-known.controller, auth.controller, firewall.decorator, auth.dto, sensitive-session.guard, roles.guard, session-issuer, mfa/totp.service, registration, users.service, admin.service, account.service, access-token-signer, auth-session.service, user-directory, token-auth, session-revocation); `pnpm check:boundaries` reports none of these imports (D-6)
- [ ] T090 Static gates from `packages/backend`: `pnpm exec tsc --noEmit -p tsconfig.json && pnpm lint`; `pnpm check:boundaries`; `pnpm check:module-graph`; `pnpm check:table-ownership --strict`; `pnpm check:no-wallclock`; grep `sequelize.transaction` and `// S54 T037 audit` in `libs/domains/identity` (0 each) and `grep -rn "cf-connecting-ip\|throttle\|skipThrottle" libs/domains/identity` (empty)
- [ ] T091 Run all pure units: `pnpm jest libs/domains/identity --testPathIgnorePatterns e2e`
- [ ] T092 Run the whole capability suite once: `/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/identity`; re-run the five other-domain specs moved to the fixture (T020); record the green run (VII.9) in `quickstart.md`
- [ ] T093 Final report: list the three built-spec follow-ups (S49 operator routes → US12; S50 `Firewall`/policies/failures-only/`req.clientIp` → T012–T015; S50 `@RateLimit` metadata-only + `RateLimitModule.forRoot()` → T005, T015) and any blocker in `questions.md`

## Dependencies & Order

- Phase 1 → Phase 2 (blocks all). Within Phase 2: T008→T010→T011; T012→T013→T014; T006→T007→T019→T020.
- Story order: US1 (needs T022 migration, T023–T025) → US2 → US3 → US4 → US5 (needs US4 repository) → US6 (needs US2/US4) → US7 → US8 (needs US7 keys) → US9 (needs US5 revocation service) → US10 → US11 → US12 (independent of US1–US11 after Phase 2; can run in parallel with US7+).
- US3 `/auth/me` (T037) is revisited after T074; US9 depends on T046; T078 depends on all consumers' sibling work.
- Test task always precedes its implementation task within a phase.

## Parallel opportunities

- Phase 1: T002, T003, T004. Phase 2: T006, T008, T009, T012, T017.
- Unit specs (T029, T049, T055, T058, T062) are different files and run in parallel with their e2e test-writing.
- US12 (T083–T086) can proceed in parallel with US7–US11.

## Implementation strategy

MVP = Phases 1–2 + US1 + US2 + US3 + US4 (the four P1 stories: register, log in, verify, refresh). Then P2 (US5–US8), P3 (US9–US11), then US12. Run the narrowest test after every task; run the full capability suite only in T092.

## Gaps coverage

| Gap | Task(s) | Gap | Task(s) |
|---|---|---|---|
| A1 | T025 | A27 | T041, T042 |
| A2 | T016 | A28 | T040 |
| A3 | T025 | A29 | T040 |
| A4 | T023, T024, T026, T033 | A30 | T011, T040 |
| A5 | T025 | A31 | T045, T047 |
| A6 | T022 | A32 | T045, T047 |
| A7 | T013, T026 | A33 | T046, T047 |
| A8 | T025, T026 | A34 | T041, T046 |
| A9 | T015 | A35 | T041 |
| A10 | T013, T032 | A36 | T047 |
| A11 | T032 | A37 | T013, T042 |
| A12 | T004, T030 | A38 | T053 |
| A13 | T030 | A39 | T050, T052 |
| A14 | T033 | A40 | T052, T053 |
| A15 | T019, T032 | A41 | T060 |
| A16 | T019 | A42 | T056 |
| A17 | T045 | A43 | T060 |
| A18 | T019 | A44 | T060 |
| A19 | T007, T016 | A45 | T059 |
| A20 | T007, T009 | A46 | T087 (sibling follow-up) |
| A21 | T007, T018 | A47 | T063, T065 |
| A22 | T036 | A48 | T068–T071 |
| A23 | T036 | A49 | T046, T074 |
| A24 | T014, T036 | A50 | T081 |
| A25 | T036 | A51 | T003, T081 |
| A26 | T035 | A52 | T020, T089 |
| D-6 | T008, T010, T094 | D-7 / D-12 / C | T075, T078 |
| D-8 | T075 | D-17 | T009 |
| F-S49-1 | T083–T086 | F-S50-1 | T012–T015 |
| F-S50-2 | T005, T015 | F-T037 | T060 |
| Out of scope but present | T077 | Sibling-spec follow-ups | T014, T078, T087 |

## Phase 16: Convergence

- [ ] T095 Migrate the direct `this.sequelize.transaction(...)` in `packages/backend/libs/domains/identity/infra/keys/key-rotation.jobs.ts` (line ~82, promote/retire in one unit of work) to `TransactionRunner.run` and delete its `// S54 T037 audit` comment (line ~81); the file was touched by T011 (clock injection), so cross-spec rule 4 applies now, not only at T060; re-run `pnpm jest libs/domains/identity --testPathIgnorePatterns e2e` and confirm `grep -rn "sequelize.transaction" libs/domains/identity` is empty per F-T037 (contradicts)
