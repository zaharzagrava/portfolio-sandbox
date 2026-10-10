# Data Model: S01

Owner of everything below: `identity` (registry entries `User`, `FederatedIdentity`, `SigningKey`, new `PasswordResetToken` → `domain:identity`; DynamoDB `Auth` table and its Redis keys are identity's too).

## PostgreSQL

### User (existing, `infra/models/user.model.ts`)

`id` uuidv7 PK · `email` text, stored trimmed + lower-cased, nullable (social-only accounts) · `passwordHash` text nullable (Argon2id; legacy bcrypt until next login) · `role` enum `USER|SELLER|MODERATOR|ADMIN` · second-factor fields (S02, unchanged) · `createdAt/updatedAt/deletedAt` (soft delete).

- **Constraint to verify/add** (expand migration, `lock_timeout` set): `CREATE UNIQUE INDEX CONCURRENTLY … ON "User" (lower(email)) WHERE email IS NOT NULL`; `EXPLAIN` test proves lookups use it (gap A6).
- Rehash: `UPDATE … SET passwordHash = :new WHERE id = :id AND passwordHash = :old`.
- No e-mail or hash ever appears in tokens, events or logs.

### SigningKey (existing)

`kid` (well-formed identifier) · `alg` always `ES256` (type narrowed; `RS256` removed from the model type) · `publicKey` JWK · `privateKeySealed` (SecretBox, context `signing-key:<kid>`) · `status NEXT|ACTIVE|RETIRED` · `activatedAt`, `retiredAt`, `createdAt`.

- Partial unique indexes: one `ACTIVE`, one `NEXT` (add the NEXT one if absent).
- State machine: `NEXT → ACTIVE → RETIRED → (deleted)`; transitions are conditional updates in one transaction (promote: retire ACTIVE and activate NEXT together). Timings: NEXT ≥ 24 h before promotion, ACTIVE ≥ 7 d, RETIRED purged ≥ 24 h after `retiredAt`.

### PasswordResetToken (new)

| Column | Type | Notes |
|---|---|---|
| `id` | uuidv7 PK | |
| `userId` | uuid not null | plain column, same-domain FK to `User` allowed |
| `digest` | text not null UNIQUE | base64url SHA-256 of a 256-bit token; the raw token is never stored |
| `expiresAt` | timestamptz not null | `createdAt + 30 min` |
| `usedAt` | timestamptz null | set once, conditional update |
| `createdAt` | timestamptz not null | |

Index `(userId)`. A new request marks the user's open tokens used (`usedAt = now`) in the same transaction as the insert. Purge of old rows: a daily S49 job `auth.purge-reset-tokens` deletes rows with `expiresAt < now − 1 day` (bounded batch).

### FederatedIdentity (existing, S02): unchanged.

### Outbox rows (written through `OutboxService`, owned by S53)

Events and the reset task, see [contracts/events.md](contracts/events.md).

## DynamoDB `Auth` table (single-table; new attributes only, no key change)

| Item | PK / SK | Attributes |
|---|---|---|
| Session | `USER#<userId>` / `SESSION#<sid>` (GSI by `sid` as today) | `sid, userId, familyId, device(≤200), ip, createdAt, lastUsedAt, absoluteExpiry (epoch s), revokedAt?, revokeReason?` |
| Refresh token | `RT#<sha256 base64url>` / `RT` | `sid, userId, familyId, expiresAtEpoch (TTL attr, ≤ min(now+30 d, absoluteExpiry)), usedAt?` |

Rules: the TTL attribute is cleanup only; expiry is checked at use (FR-034). Rotation = one `TransactWriteItems` (R-01). Session list = query by user partition, filter `revokedAt` absent and not expired, newest first, ≤ 20 items. Session cap: on login, if 20 active, revoke the oldest (`session_limit`) in the same issue operation.

State of a session: `ACTIVE → REVOKED(reason)`; reasons: `logout`, `logout_all`, `session_revoked_by_user`, `session_limit`, `refresh_token_reuse`, `password_reset`, `user_deleted`, or the caller-given reason of `revokeAllForUser`.

## Redis

| Key | Value | TTL |
|---|---|---|
| `auth:revoked:<sid>` | reason | access-token lifetime + 60 s (token can no longer be valid after that) |
| rate-limit keys | owned by S50 | per policy |

No cache of user rows (principal comes from claims). `JWKS` cache and key-reload cooldown are in-process.

## In-memory

Key set per process (TTL 300 s, forced reload ≤ 1 per 30 s); service-token cache keyed `(caller, audience)` reusing a token until 80 % of its 60 s lifetime; hash concurrency semaphore.

## Principals (not persisted)

`AuthenticatedUser {id, role, sessionId, amr[]}`; `ServicePrincipal {kind:'service', caller, onBehalfOf?{userId, sessionId}}`.

## Validation rules (from the spec)

Email ≤ 254 chars, trimmed, lower-cased, valid address; password 12–128 for registration/reset (login: ≤ 128 only), not equal to the address, not breached; `role` ∈ {USER, SELLER}; unknown fields rejected; refresh token ≤ 256 chars; body ≤ 16 KB; JSON only.
