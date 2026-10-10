# Data Model: S02

Owner of everything below: `identity`. Registry (`packages/backend/db/ownership.ts`) gains `SecondFactor`, `MfaRecoveryCode`, `MfaChallengeState` → `domain:identity` in the same change (IX.3); `FederatedIdentity` is already `domain:identity`. No other domain reads, joins or imports any of them (AS-63). All migrations are expand-only, set `lock_timeout`, create indexes `CONCURRENTLY` outside the transaction block (III.11).

## PostgreSQL

### SecondFactor (new, one row per user)

| Column | Type | Notes |
|---|---|---|
| `userId` | uuid PK | same-domain reference to `User`; no row = state `none` |
| `state` | text not null, check in (`pending`,`enabled`) | `none` is the absence of a row; `pending` past `pendingExpiresAt` reads as `none` |
| `secretSealed` | text not null | `SecretBox` value; `v2` with context `mfa:<userId>` once re-sealed |
| `sealVersion` | smallint not null default 0 | 0 = sealed without context (migrated), 1 = bound to the user |
| `pendingExpiresAt` | timestamptz null | `now + 15 min` while `pending` |
| `enabledAt` | timestamptz null | set by confirm |
| `lastStep` | bigint null | highest accepted TOTP time step; only ever increased (conditional update) |
| `createdAt`, `updatedAt` | timestamptz not null | |

State machine (FR-001), every move a conditional `UPDATE … WHERE state = :from`: `none → pending` (insert), `pending → pending` (re-enrol, new secret, new expiry), `pending → enabled` (confirm, asserts one row), `enabled → none` (disable, linking wipe: row deleted), `pending → none` (lazy expiry; the row is overwritten by the next enrol or removed by the purge job). Any other transition is `409`. `nextState()` lives in `domain/second-factor-state.ts` and ends in `assertNever`.

Index: the PK. A daily S49 job removes `pending` rows expired for more than one day (bounded batch).

### MfaRecoveryCode (new)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK default `uuidv7()` | |
| `userId` | uuid not null | |
| `digest` | text not null | `SecretBox.keyedDigest('mfa-recovery', normalisedCode)` (HMAC-SHA-256, base64url) |
| `usedAt` | timestamptz null | set once by `UPDATE … SET usedAt = :now WHERE userId = :u AND digest = :d AND usedAt IS NULL RETURNING id` (atomic spend, FR-022) |
| `createdAt` | timestamptz not null | |

Indexes: `UNIQUE (userId, digest)`, `(userId) WHERE usedAt IS NULL` (remaining count). A set is 10 rows inserted with the confirm/regenerate transaction; regeneration deletes the user's rows and inserts the new ones in that same transaction (`enabled` is asserted by the same transaction's conditional step update). Remaining = `count(*) WHERE usedAt IS NULL`. Rows are removed on disable and on the linking wipe.

### MfaChallengeState (new, lazy)

| Column | Type | Notes |
|---|---|---|
| `jti` | uuid PK | the challenge token's `jti` |
| `userId` | uuid not null | |
| `attempts` | smallint not null | wrong-or-right attempts reserved so far (≤ 3) |
| `spentAt` | timestamptz null | set by the winning success |
| `expiresAt` | timestamptz not null | token expiry (5 min) |

Row created by the first attempt, never at login time. Daily S49 job deletes rows with `expiresAt < now() - 1 h` (bounded batch). Attempt reserve and spend are the conditional statements of research R-04.

### FederatedIdentity (existing; expand)

Columns today: `id`, `userId`, `provider`, `subject`, `email` (hint), `createdAt`. Changes:

- `UNIQUE (userId, provider)` (new, `CREATE UNIQUE INDEX CONCURRENTLY`). The migration first runs a duplicate check (`GROUP BY userId, provider HAVING count(*) > 1`) and **aborts with the offending pairs in the message** instead of deleting anything; a human resolves duplicates, then re-runs.
- `wipePending boolean not null default false` (research R-11).
- Existing `UNIQUE (provider, subject)` stays. `email` stays a hint (null for subject-only providers' unverified claims is allowed; the model comment says so).
- `provider` shape: `google` or `shop:<uuid>`; any other value is refused by the repository before insert (check constraint is deferred to a later contract step because old rows are unverified).

### User (S01-owned, touched by S02 through repository methods only)

- `passwordHash` set to NULL by `UserRepository.clearPassword(id)` in the linking transaction (new port method; S01 owns the model).
- `mfaSecretEnc`, `mfaEnabledAt`, `mfaRecoveryCodes` become dead columns after the cut-over; their removal is a later contract migration (deferred task), after `identity.reseal-mfa-secrets` has completed in every environment. The new code never reads or writes them.

### Migration `20261010120000-identity-s02-expand.js` (name to be confirmed against the migrations directory at implementation time)

1. In a transaction with `SET LOCAL lock_timeout = '5s'`: create the three tables; add `wipePending`; copy users with `mfaEnabledAt IS NOT NULL AND mfaSecretEnc IS NOT NULL` into `SecondFactor` (`state = 'enabled'`, `sealVersion = 0`, `lastStep = NULL`). Pending enrolments (secret set, `mfaEnabledAt` null) are **not** copied: they become `none`, the user enrols again. Legacy recovery codes are not copied (research R-05).
2. Outside the transaction: `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "FederatedIdentity_user_provider_uq" ON "FederatedIdentity" ("userId","provider")` after the duplicate check.
3. `down` drops the new tables and index only.

## Redis (ephemeral, never the source of truth for a durable fact)

| Key | Value | TTL | Notes |
|---|---|---|---|
| `oidc:flow:<sha256(state)>` | JSON `{provider, purpose, userId?, verifier, nonce, returnPath, cookieDigest}` | 600 s | consumed with `GETDEL` |
| `oidc:disc:<providerId>` | in-process cache, not Redis | 1 h | discovery + key set; reload on unknown `kid` ≤ 1 per 30 s |
| rate-limit keys | S50's | per policy | `auth.mfa.ip`, `auth.mfa.account`, `auth.oidc.ip` |

The old `mfa:last-step:<userId>` and `oidc:state:<state>` keys are no longer written; they expire by their own TTL.

## Outbox rows (written through `OutboxService`, owned by S53)

Events listed in [contracts/events.md](contracts/events.md); each appended inside the transaction that changes the state (FR-090).

## Not stored

Provider access/refresh/ID tokens, `code`, `state`, `nonce`, verifier outside the 10-minute flow record, plain TOTP secrets, plain recovery codes, Google profile data other than the subject and the e-mail hint.
