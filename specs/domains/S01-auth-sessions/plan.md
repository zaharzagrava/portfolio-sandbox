# Implementation Plan: S01 — Registration, Login, Sessions, Refresh Rotation, JWKS, Service Tokens

**Branch**: `S01-auth-sessions` | **Date**: 2026-10-10 | **Spec**: [spec.md](spec.md)

**Input**: `spec.md`, `test-plan.md`, `gaps.md`, `questions.md` (defaults accepted as written), constitution, and the three follow-ups left by built specs (S49 admin routes, S50 `Firewall` throttle removal / `definePolicies` / failures-only, S50 `@RateLimit` is metadata only).

## Summary

Rebuild the `identity` domain (`packages/backend/libs/domains/identity/`) into the shape the spec fixes: one session path (delete `AuthService.register/login`, the legacy RS256 path and `issueTokensFor`), ports in `domain/` with adapters in `infra/` (D-6), a pure `TokenVerifier` (principal from claims only), uniform registration, failure-counting login throttling on the S50 toolkit, atomic refresh rotation in the existing DynamoDB `Auth` table, cookie delivery with signed CSRF, ES256-only JWKS with a scheduled single-run rotation job (S49), service-to-service tokens, password reset, `UserDirectoryService` / `SessionRevocationService` / `SessionIssuer` as R1 exports, and the ADMIN-only operator routes over `JobsAdminService`. Technical choices are in [research.md](research.md); entities in [data-model.md](data-model.md); interfaces in [contracts/](contracts/).

## Technical Context

**Language/Version**: TypeScript (strict), Node 22, NestJS 11, Express.

**Primary Dependencies**: `argon2`, `bcrypt` (legacy verify only), `jose`-style verification implemented on `node:crypto` ES256 (already used by `KeyStore`), `@aws-sdk/lib-dynamodb`, `ioredis` via `RedisService`, `sequelize-typescript`, `zod` (`packages/contracts`), S49 `JobsService`/`JobsAdminService`, S50 `RateLimitModule`/`RateLimiterService`, S53 `OutboxService`, S54 `TransactionRunner`/`Transactional`, `CLOCK`, `RequestContext.clientIp`, `MetricsRegistry`, problem-details catalog.

**Storage**: PostgreSQL (`User`, `FederatedIdentity`, `SigningKey`, new `PasswordResetToken`; outbox rows); DynamoDB `Auth` table (sessions, refresh-token digests; existing single-table design, new attributes only); Redis (session-revoked markers, key-reload cooldown is in-process). No new store.

**Testing**: Jest. API e2e through `/opt/sdd/repo/scripts/sdd/test-spec.sh <file>` from `packages/backend`; unit specs beside pure code; Playwright journey AS-86 belongs to W01 (not built here).

**Target Platform**: Linux containers; apps `core` (HTTP), `worker` (rotation job), `sse-gateway` and `public-api` (token verification only).

**Project Type**: Backend domain module in the monorepo (no new deployable app, I.6).

**Performance Goals**: verification zero I/O; 99 % of valid logins < 300 ms and refreshes < 50 ms at 2,000 logins/s fleet-wide (SC-006: not proven here → UNVERIFIED).

**Constraints**: hash concurrency 4 / queue 64 ≤ `UV_THREADPOOL_SIZE − 1` (startup check); JWKS `max-age=300`; no network I/O in a DB transaction (III.3); no direct `sequelize.transaction` (S54).

**Scale/Scope**: ≤ 20 active sessions per user; user directory batch ≤ 500; 86 acceptance scenarios, 11 e2e files + 8 unit specs + 1 admin e2e (see below).

## Constitution Check

*GATE: passes before research; re-checked after design (still passes, no justified violations).*

| Rule | Status | How |
|---|---|---|
| I.1/I.2 layering, D-6 | Pass (debt paid) | `domain/` ports (`UserRepository`, `SessionRepository`, `SigningKeyRepository`, `PasswordHasherPort`, `SecretSealerPort`, `BreachCheckerPort`, `ResetTokenRepository`) injected by token; adapters in `infra/`; `api/` and `application/` import no `infra/` path |
| I.3 clock | Pass | `CLOCK` injected in application/infra; domain functions take `now`; session store and rotation job lose `Date.now()` |
| I.4/IX.3 ownership | Pass | `PasswordResetToken` added to `db/ownership.ts` in the same PR; DynamoDB `Auth` stays identity's |
| II.2 pipeline | Pass | guards authenticate, `@RateLimit` interceptor throttles, global pipe validates (AS-30); content-type check in a guard before the pipe |
| III.2/III.3 transactions | Pass | `TransactionRunner.run` / `@Transactional`; reset request/confirm, registration and rotation write outbox rows in the same transaction; no HTTP/Redis/Dynamo call inside |
| III.4 principal in predicate | Pass | `revokeSession(userId, sessionId)` and `DELETE /auth/sessions/:id` filter by user in the key condition; 404 for others |
| III.6 invariants in the store | Pass | unique `lower(email)` index, single ACTIVE key partial index, Dynamo conditional/transactional rotation, reset-token spend by conditional update |
| III.9 caches | Pass | key cache is a bounded in-process cache with TTL and reload cooldown; Redis markers carry TTL |
| III.11 migrations | Pass | expand-only: add table + indexes, no renames/drops of live columns; `lock_timeout` set |
| IV.1/IV.7 | Pass | other domains use only exported R1 services; headers `X-User-Id` never read; `aud`-bound tokens |
| IV.3/IV.4 | Pass | events via outbox; reset message is a single-consumer task (`appendTask`) |
| V.1–V.4 | Pass | explicit DTOs; contracts schemas; problem+json via global filter; uniform enumeration responses |
| V.6 | n/a | no order/payment creation |
| VI.2 | Pass (server side) | opt-in cookie delivery, HttpOnly, signed double-submit, origin checks |
| VII | Pass | test-plan table; e2e per endpoint; fallbacks forced (breach fail-open, revocation-store down → fail closed) |
| VIII.1 | Pass | audit lines carry no PII/secrets; log-capture test AS-83 |
| VIII.5 | Pass | config rules registered with `ConfigRules` (master key, hash concurrency, origins, audiences) |
| VIII.6 | Pass | rotation is an S49 schedule, idempotent, no boot-time rotate |
| VIII.7 | Pass | Argon2id; ES256 pinned, `exp/iss/aud/typ/nbf` checked |
| IX.4/IX.7 | Pass (debt paid for identity side) | `UserModel`, `FederatedIdentityModel`, `SigningKeyModel` leave the barrel after consumers move (see Work packages WP-12) |
| X.4/X.5 | Pass | barrel lists R1 exports; infra libs do not import identity |

**Complexity Tracking**: none. New deployable app: none. The seventh rate-limit policy `auth.reset.confirm.ip` is additive to the six named in AS-22 (see research R-05).

## Project Structure

### Documentation (this feature)

```text
specs/domains/S01-auth-sessions/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/
│   ├── auth-http.md            # public + operator HTTP routes, headers, cookies, error codes
│   ├── identity-services.md    # R1 exports, ports, guards, principals
│   └── events.md               # outbox events and the reset message
└── tasks.md                    # /speckit-tasks (not created here)
```

### Source Code (repository root)

```text
packages/backend/libs/domains/identity/
├── identity.module files: auth.module.ts, auth-api.module.ts, auth-worker.module.ts,
│   identity-ops.module.ts (new: operator routes), realtime-topics.module.ts
├── api/
│   ├── auth.controller.ts            # register, login, refresh, logout, logout-all, me, password-reset/*
│   ├── sessions.controller.ts        # GET /auth/sessions, DELETE /auth/sessions/:id (new, split out)
│   ├── jobs-admin.controller.ts      # ADMIN operator routes over JobsAdminService (new)
│   ├── well-known.controller.ts      # JWKS, ETag/304
│   ├── auth.dto.ts, sessions.dto.ts, jobs-admin.dto.ts
│   ├── decorators/firewall.decorator.ts   # { anonymous?, roles?, sensitive? }; no throttle options
│   ├── guards/ (auth, optional, roles, sensitive-session, csrf, origin, json-only, service-auth)
│   └── request-with-user.ts          # AuthenticatedUser
├── application/
│   ├── registration.service.ts  login.service.ts  refresh.service.ts  session-admin.service.ts
│   ├── password-reset.service.ts  session-issuer.service.ts  session-revocation.service.ts
│   ├── user-directory.service.ts  service-token.service.ts  audit.service.ts
│   └── mfa/totp.service.ts (S02, re-wired onto SessionIssuer only)
├── domain/
│   ├── token-verifier.ts  csrf-token.ts  key-rotation-policy.ts  key-cache-policy.ts
│   ├── service-token-policy.ts  service-token-cache.ts  bounded-concurrency.ts  auth-rate-policies.ts
│   ├── password-policy.ts  authenticated-user.ts  events.ts  errors.ts
│   └── ports (user, session, signing-key, reset-token repositories; hasher; sealer; breach checker)
└── infra/
    ├── crypto/ (password-hasher.ts, secret-box.ts)   ├── keys/ (key-store, key-rotation.jobs)
    ├── sessions/ (dynamo session repository)        ├── models/ (user, federated-identity, signing-key, password-reset-token)
    ├── breach/ (k-anonymity range client)            └── oidc/ (S02, re-wired)
packages/contracts/src/auth/  authSessionSchema, mfaChallengeSchema, sessionListItemSchema, jwksSchema,
                              passwordResetSchema, jobsAdminSchemas
packages/backend/db/migrations/  one expand migration (PasswordResetToken, indexes) + ownership.ts entry
packages/backend/test/seeds, test/fakes  session fixture over SessionIssuer; fake breach client
```

**Structure Decision**: single backend domain module following I.1; operator routes live in a small `IdentityOpsModule` so that apps hosting only verification (`sse-gateway`, `public-api`) do not pull admin routes. Edge worker (`packages/edge-be`, gap A46) is outside identity: tracked as a sibling follow-up.

## Work packages (cover every gaps.md item and the three built-spec follow-ups)

| WP | Scope | Gaps / follow-ups | Scenarios |
|---|---|---|---|
| WP-01 | Pure units: verifier, CSRF token, rotation policy, key-cache policy, service-token policy/cache, bounded concurrency, auth rate policies, hasher matrix, secret box | A12, A13, A21, A42, A45 | AS-17, 18, 22, 23, 53, 62, 65, 67, 71, 72 |
| WP-02 | Ports/adapters (D-6), clock injection, delete legacy `AuthService` paths, `AuthenticatedUser`, D-17 | A2, A19, A20, A30, B:D-6, D-17 | AS-23–29 |
| WP-03 | Rate-limit policies via `definePolicies`/`forFeature`; remove `throttle`/`skipThrottle` from `Firewall`; failures-only + `resetOnSuccess`; `req.clientIp` only; `RateLimitModule.forRoot()` in the three HTTP apps and in every identity e2e app | A7, A9, A10, A37, F-S50-1, F-S50-2 | AS-09, 12–15, 22, 38, 78 |
| WP-04 | Registration: uniform 202, outbox, equal hashing, password policy, breach port, role whitelist | A1, A3–A6, A8 | AS-01–09 |
| WP-05 | Login, rehash, tokens (`at+jwt`, claims, 300 s), MFA challenge `mfa+jwt`, no-store, session-after-sign ordering | A11, A14–A18 | AS-10–21, 57, 85 |
| WP-06 | Token verification path, `Firewall({sensitive})`, legacy channel removal, optional guard debug log, role staleness | A19–A26 | AS-23–30 |
| WP-07 | Refresh/session store: atomic transactional rotation, absolute cap, reuse revoke, session list/delete/logout-all, durable-then-marker revocation, single error | A27–A29, A31–A37 | AS-31–45 |
| WP-08 | Cookie delivery, signed CSRF, origin/fetch-metadata, JSON-only, `__Host-access` | A38–A40 | AS-46–56 |
| WP-09 | Keys/JWKS: ES256 only, ETag, rotation job under S49 (no boot-time run), lazy race-safe bootstrap, narrow catch, migrate the `// S54 T037 audit` site to `TransactionRunner` | A41–A44 | AS-58–66 |
| WP-10 | Service tokens: mint, exchange, `ServiceAuthGuard`, `@AllowedCallers`, cache | A47 | AS-68–72 |
| WP-11 | Password reset: table, token store, outbox task, throttles, session revocation | A48 | AS-73–78 |
| WP-12 | R1 services (`UserDirectoryService`, `SessionRevocationService`, `SessionIssuer`), barrel change, D-7/D-8/D-12, section C migration of consumers (their capabilities adopt via Sibling-spec follow-ups) | A49, B:D-7, D-8, D-12, C | AS-45, 79–81 |
| WP-13 | Audit/metrics, log redaction, stable codes, contracts schemas, problem catalog | A50, A51 | AS-82–84 |
| WP-14 | Operator routes (ADMIN only) over `JobsAdminService` | F-S49-1 | OPS-01–OPS-07 (see test strategy) |
| WP-15 | Cleanup of out-of-scope code in identity: remove `AdminModule`/`admin.*`, empty users controller/service, Firebase/Stripe/AWS imports in `UsersModule` | gaps "Out of scope but present" | — |
| WP-16 | Split and rewrite e2e (delete grace/legacy/bcrypt-import tests); other domains' specs move off `issueTokensFor` to the fixture; record green run | A52 | all |

## Test strategy additions

The operator routes have no scenarios in `spec.md` (it predates the S49 follow-up). Their tests get IDs `OPS-01…07` in `test-plan.md`-style rows inside `quickstart.md` and file `auth-jobs-admin.e2e-spec.ts`: 401 without token; 403 for `USER`/`SELLER`/`MODERATOR`; `GET /admin/jobs` filters + cursor + clamped limit + `InvalidCursorError`→400; stats; retry dead (200 / 409 conflict / 404, audit line with actor); cancel; list/enable/disable schedules; response DTOs never carry a payload. `spec.md` is not edited (rule 3 of workflow); a sibling note is recorded in `gaps.md`.

## Hot spots to verify early (risk order)

1. DynamoDB `TransactWrite` condition set for rotation (AS-33) against the local Dynamo used in `docker-compose.test.yaml`.
2. Failures-only interceptor behaviour on login with a `mfaRequired` 200 and on 429 ordering (AS-12/13).
3. `auth.reset.account` semantics (research R-04: enforced by code call, because the request always answers 2xx).
4. `UV_THREADPOOL_SIZE` startup check in the e2e environment.
