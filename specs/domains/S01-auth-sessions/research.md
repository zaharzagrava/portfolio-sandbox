# Research: S01 design decisions

No `NEEDS CLARIFICATION` remains: `questions.md` defaults are accepted and decide product behaviour. This file records the technical choices the plan adds. Format: Decision / Rationale / Alternatives.

## R-01 Session and refresh-token store

- **Decision**: keep the existing DynamoDB `Auth` single table (`dynamodb/Auth.json`). Session item gains `absoluteExpiry`, `lastUsedAt`, `revokedAt`, `revokeReason`; refresh-token items keyed by SHA-256 digest keep `usedAt`. Rotation is one `TransactWriteItems`: condition `usedAt attribute_not_exists AND expiry > now` on the old token, condition `session.revokedAt attribute_not_exists` on the session, put the successor, update `lastUsedAt`. A cancelled transaction maps to "spent/revoked", then the reuse path revokes the session.
- **Rationale**: the spec says "key-value with TTL and conditional writes"; the table exists and is identity's; one transactional write removes the three-step strand (A28) and gives exactly one winner (AS-33).
- **Alternatives**: Postgres rows with `FOR UPDATE` (extra load on the hot refresh path, hot rows); Redis Lua (not durable enough for revocation record).

## R-02 Revocation order

- **Decision**: durable write (session `revokedAt`/reason) first, Redis marker second; marker failure → 5xx, the operation is idempotent so a retry completes it. Sensitive routes check the Redis marker and fail closed when Redis errors; if the marker is missing they fall back to the durable record only when the marker store errored (fail closed means reject).
- **Rationale**: FR-025/FR-037; a revocation never exists only in a cache.
- **Alternatives**: marker first (loses durability), both in parallel (non-atomic either way).

## R-03 Client IP

- **Decision**: all throttling and session metadata read `RequestContext.clientIp` / `req.clientIp` (S54 trusted-proxy result). `cf-connecting-ip`, `x-forwarded-for`, `x-real-ip` are never read in identity.
- **Rationale**: FR-014, AS-15, S50 follow-up. **Alternatives**: none acceptable.

## R-04 `auth.reset.account` with a request that always answers 202

- **Problem**: the S50 follow-up requires `count: 'failures-only'` + `resetOnSuccess` for `auth.reset.account`, but the request endpoint answers `202` for every address, so the interceptor would refund every slot (2xx) and the limit of 3/hour/address could never trip. `failureStatuses` only accepts 4xx/5xx.
- **Decision**: declare the policy as directed (failures-only, resetOnSuccess, `key: 'body.email'`, 3 per 3 600 000 ms, fail-closed) but enforce it **from the application** with `RateLimiterService.check('auth.reset.account', emailSubject(email))`, not through `@RateLimit` on the route. A `check` reserves a slot that is never refunded by the request path, so every request counts; a successful confirm for that user calls `reset(...)` with the same subject, which is the failures-only/`resetOnSuccess` semantics ("a completed reset clears the counter"). A denied check raises `Domain_RateLimitedError` → the standard 429. The check runs for unknown addresses with the same subject derivation, so the answer is uniform (AS-78).
- **Rationale**: honours the follow-up (declaration shape) and the spec (AS-78). `emailSubject` normalises like the DTO (trim + lower-case), fixing the A10 key mismatch.
- **Alternatives**: a plain (non failures-only) policy via `@RateLimit` (simpler, but contradicts the follow-up); a fixed `failureStatuses` hack (rejected by policy validation). If S50 is later extended to accept `2xx` as failure statuses, switch to the decorator and delete the code call.

## R-05 Reset limits per IP

- **Decision**: `auth.reset.ip` 5/hour on `password-reset/request`; new `auth.reset.confirm.ip` 10/hour on `confirm`. Both sliding window, `key: 'ip'`, fail-closed.
- **Rationale**: AS-78 gives different limits for request and confirm; one policy cannot hold two limits. **Alternatives**: `cost` weighting on one policy (confirm and request would share a budget, surprising). AS-22's unit spec iterates all declared `auth.*` policies, so the extra name is covered.

## R-06 Token format and verification

- **Decision**: access tokens are compact JWS, ES256, header `{alg, typ:'at+jwt', kid}`; the pure `TokenVerifier(keys, now, config)` has no store dependency. Verification is implemented with `node:crypto` (already used by `KeyStore`) and a strict parser: three segments, size cap 8 KB, `kid` regex `^[A-Za-z0-9_-]{1,64}$`, algorithm taken from the key record (never the header), `crypto.verify('sha256', ..., {dsaEncoding:'ieee-p1363'})`. Claims: `iss`, `aud`, `typ`, `sub` (UUID), `sid`, `nbf`/`exp` with 5 s tolerance, `jti`, `amr`.
- **Rationale**: AS-23 needs the exact reject matrix without library messages; token types `mfa+jwt`, `svc+jwt`, `at+jwt` share one verifier parametrised by expected `typ`/`aud`. **Alternatives**: `jose` library (extra dependency; error messages must be wrapped anyway).

## R-07 Key set cache and rotation

- **Decision**: `KeyCachePolicy` (pure) allows a forced reload on unknown `kid` at most once per 30 s and a normal refresh every 300 s; `decideRotation(keys, now, cfg)` is pure and returns `create ACTIVE | create NEXT | promote | purge | keep | none`. The S49 handler `auth.rotate-signing-keys` calls it inside one `TransactionRunner.run` with `SELECT … FOR UPDATE` on the ACTIVE row so two concurrent runs serialise; the partial unique indexes (one ACTIVE, one NEXT) are the safety net. A schedule is registered through `declareJobType` + cron on the worker module (not at boot). The lazy bootstrap in `KeyStore` catches only a unique-violation (A43).
- **Alternatives**: advisory lock only (works but the unique indexes are still required, III.6).

## R-08 Password hashing concurrency

- **Decision**: `BoundedConcurrency` (pure semaphore: limit 4, queue 64, `Overloaded` error → `503` + `Retry-After: 1` through the problem catalog). Startup rule in `ConfigRules`: `limit ≤ UV_THREADPOOL_SIZE − 1` (parsing `process.env.UV_THREADPOOL_SIZE`, default 4); the Dockerfile sets `UV_THREADPOOL_SIZE=8` (P0202; ops note in quickstart). Registration hashes once on both paths (hash first, then insert-or-duplicate); the hash is discarded on duplicate.
- **Alternatives**: worker threads (more moving parts).

## R-09 Registration uniqueness and events

- **Decision**: inside one `TransactionRunner.run`: `INSERT … ON CONFLICT (lower(email)) DO NOTHING RETURNING id`; on insert append `identity.user_registered`; on conflict select the existing id and append `identity.registration_duplicate_attempted`. Unique index on `lower(email)` (verify it exists and is `UNIQUE`; migration if not). The user model's column-level `unique` stays.
- **Rationale**: AS-03 requires the store to reject case variants and exactly one event per outcome under `Promise.all`.

## R-10 Password reset

- **Decision**: new Postgres table `PasswordResetToken(id, userId, digest UNIQUE, expiresAt, usedAt, createdAt)`; request: in one transaction delete/mark earlier tokens of the user, insert the new digest, `OutboxService.appendTask` (single-consumer `identity.password_reset_requested`). Confirm: validate password policy first (token not consumed on failure), then in one transaction `UPDATE … SET usedAt = now WHERE digest = $1 AND usedAt IS NULL AND expiresAt > now RETURNING userId` (one winner), update the hash, append `identity.password_changed`; after commit revoke all sessions (reason `password_reset`) through `SessionRevocationService` (Dynamo + Redis are network I/O, III.3).
- **Alternatives**: Dynamo item with TTL (no transactional link to the password update).

## R-11 CSRF token

- **Decision**: `base64url(random16) + '.' + base64url(HMAC-SHA256(secret, sid + '.' + random))`; secret from config (`auth_csrf_secret`, ≥ 32 bytes, validated at startup, distinct from other secrets via `distinctSecrets`). Verified with `timingSafeEqual` after length checks; header must equal the cookie. Issued at cookie login/refresh bound to the `sid`.

## R-12 Content-type and body limit

- **Decision**: `JsonOnlyGuard` on the state-changing auth routes (before the pipe, after `@RateLimit`? — guards run before interceptors, so the guard answers `415` before throttling; accepted because it consumes no hashing work). The 16 KB limit is the S54 JSON parser setting for `/auth/*` (S54 contract); the identity e2e app uses `configureHttpApp` so AS-21 (413) is proven end to end.

## R-13 Operator routes (S49 follow-up)

- **Decision**: `JobsAdminController` under `/api/admin/jobs` and `/api/admin/job-schedules`, `Firewall({ roles: ['ADMIN'], sensitive: true })` on mutating routes and plain ADMIN on reads; thin: one `JobsAdminService` call each, DTO mapping to contracts schemas; `actorId` for `retryDead` is `request.user.id`; `InvalidCursorError` maps to `400 validation_failed` via the problem catalog. Hosted by `IdentityOpsModule`, imported by `core` only, which imports `JobsModule`.
- **Alternatives**: mount in the worker app (no public HTTP there).

## R-14 Rate limiting is metadata only (S50 follow-up)

- **Decision**: `@RateLimit(...)` stays on routes as metadata. Enforcement is the global interceptor from `RateLimitModule.forRoot()`; `core`, `sse-gateway`, `public-api` already install it. Identity's `AuthApiModule` imports `RateLimitModule` (service) plus `forFeature(identityRatePolicies)`; every identity e2e app imports `RateLimitModule.forRoot()` so AS-09/12/14/38/78 see enforcement. `Firewall(...)` loses `throttle`/`skipThrottle`; callers that pass them in other domains are listed in `gaps.md` Sibling-spec follow-ups.

## R-15 Dependencies and ports for tests

- **Decision**: only edge fakes: `BreachCheckerPort` fake (`test/fakes`), message transport, clock (`FakeClock`). Hasher pass-through spy via `jest.spyOn` on the real adapter. Session fixture `issueSession(userId, opts)` in `test/seeds` over `SessionIssuer` replaces `issueTokensFor`.
