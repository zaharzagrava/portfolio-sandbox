# Research: S03 design decisions

No `NEEDS CLARIFICATION` remains: `questions.md` defaults are accepted and decide product behaviour (none of its lines was edited by a human). This file records the technical choices the plan adds. Format: Decision / Rationale / Alternatives. Paths are relative to `packages/backend/libs/` unless stated.

## State of the platform that S03 builds on (read from the code, not the spec)

| Seam | State in the repo | Consequence for S03 |
|---|---|---|
| `TransactionRunner.run`, `@Transactional` | Built (`infrastructure/context`). The only direct `sequelize.transaction` in tenancy is `infra/tenancy-backfill.jobs.ts:47` (baseline 1). | All new units of work use the runner; the backfill file is deleted (WP-10). |
| `OutboxService.append`, `defineEvent`, `TopicRegistration` | Built. Identity declares `IDENTITY_AGGREGATE` with retention `full-history`. | Tenancy declares `TENANCY_AGGREGATE` (`aggregateType: 'tenancy'`, key `shopId`). |
| Consumers | `Projector` (`infrastructure/projections/projector.ts`): `name`, `topics`, `idempotency: 'inbox'|'versionGuard'|'natural'`, `handles`, `project`. Validation, upcast, DLQ by the runner. | Three projectors; no hand-rolled Kafka code. |
| `OidcProviderRegistry` | Has `list()` and `resolve()` for `google` only; `registerResolver` / `invalidate` are **not** in the file, and `tenancy/application/shop-sso.service.ts:4,17` still injects `OidcService` (checked 2026-10-10), although the follow-up note says S02 already rewired it. | WP-0 re-checks. If still absent, WP-7 adds the two additive methods to `OidcProviderRegistry` (a minimal code edit, no spec edit) and lists it under Sibling-spec follow-ups for S02 so its tests adopt them; if S02 landed them meanwhile, tenancy only adopts them. `OidcService` is not used by tenancy after WP-7. |
| `UserDirectoryService` | `getUsersByIds(≤500)`, `findByEmail` built. | Members list, accept, export use them. |
| `SessionRevocationService.revokeAllForUser(userId, reason)` | Built. | Called after commit for `source: 'sso'`. |
| `SecretBox` | S02 added the optional `context` (confirmed by S02 plan R-05). | Seal/open with `shop-sso:<shopId>`. |
| Rate limits | `definePolicies('<domain>', {...})` + `RateLimitModule.forFeature`; `@RateLimit` is metadata; `auth.*` policy shape in `identity/domain/auth-rate-policies.ts`. | `tenancyRatePolicies`; accept-failure budget enforced from code (failures only), like S02's MFA budget. |
| Jobs (S49) | `declareJobType({name, contract})` beside the `JobPayloads` augmentation; `@JobHandler`; `upsertSchedule`. | Two jobs; backfill job type removed with its augmentation. |
| Current guard | `api/shop.guard.ts` applies `Firewall()` and `MembershipService`; cache has an in-process `hot` layer. | Rewritten, not patched. |

## R-01 Where the rules live

- **Decision**: authorization and lifecycle rules are pure functions in `domain/` (`permissions`, `role-policy`, `shop-status`, `verification-status`, `seat-policy`, `slug-policy`); services orchestrate, repositories decide only by SQL predicates.
- **Rationale**: the spec's table-driven scenarios (AS-16–18, 64, 71) become unit specs with no database; `assertNever` makes a new status a compile error (III.7).
- **Alternatives**: rules in SQL only (untestable in isolation, hides the matrix); a policy library (CASL) for four roles × twenty permissions is more machinery than the table.

## R-02 Authorization cache

- **Decision**: `AuthzCache` port with a Redis adapter (`authz:{shopId}:{userId}` → `{role}|null`, 15 s positive, 10 s negative, namespaced via the cache module); no in-process layer. Writers delete the key after commit (`afterCommit` hook of the runner). Sensitive permissions (FR-015 set) skip the cache and read `ShopMembership` by PK. A Redis error is caught, counted (`tenancy_authz_cache_fallback_total`) and served from the database.
- **Rationale**: the delete-then-repopulate race leaves a stale entry for at most 15 s on non-sensitive routes (AS-13); destructive routes never rely on it. Removing the in-process layer removes the multi-instance staleness of today's 60 s `hot` layer.
- **Alternatives**: versioned keys (a per-shop epoch bumped on writes) would remove even the 15 s window but adds a second read per request; negative caching disabled (makes enumeration probes hit the database: kept at 10 s).

## R-03 Status gate placement

- **Decision**: the guard computes the answer in the spec order: 401 (Firewall), shop resolution and membership (404), permission (403 `permission_denied`), then the status gate from a `permission → allowed statuses` table in `domain/shop-status.ts`. Status comes from the same row as the role (one query `shop JOIN membership` on the cache miss; cached together as `{role, status}` for non-sensitive use with the same 15 s bound, read fresh for sensitive).
- **Rationale**: one read for both, and a suspend takes effect within 15 s on non-sensitive routes, immediately on sensitive ones. The status change deletes the cache keys of the shop's members in a batch scan by shop (`authz:{shopId}:*` via a per-shop index set) after commit, so normal propagation is immediate.
- **Alternatives**: status in a separate key (two reads); status never cached (one extra read on every request).

## R-04 Concurrency primitives per invariant

| Invariant | Mechanism | Why |
|---|---|---|
| Slug unique | unique index; map `23505` on the slug index to `slug_taken` | store decides; AS-03 |
| 10 shops per user | `pg_advisory_xact_lock(hashtextextended('shop-limit:'||userId,0))`, count owner memberships, insert | AS-04; no lock on identity's row |
| Seats (members + unexpired pending) | `SELECT … FROM "Shop" WHERE id=:id FOR UPDATE` (per-shop row lock), count, insert | AS-31; also serialises provisioning |
| Last owner | `SERIALIZABLE` transaction, count owners after change; retry on `40001` ×3 with full jitter; exhausted → `503 serialization_failure` + `Retry-After: 1` | AS-22–24; P0310 |
| Invite single use | `UPDATE "ShopInvite" SET "acceptedAt"=…, "acceptedBy"=… WHERE "tokenDigest"=:d AND "acceptedAt" IS NULL AND "revokedAt" IS NULL AND "expiresAt">:now RETURNING …` — zero rows → uniform 404 | AS-34 |
| Status transitions | `UPDATE … SET status=:to, "shopVersion"="shopVersion"+1 WHERE id=:id AND status=:from` asserting one row; zero rows → re-read, `409 invalid_transition` | AS-65 race |
| Directory move | `UPDATE … WHERE "shopId"=:id AND version=:expected` | AS-52 |
| Pending invite per address | partial unique index `(shopId, lower(email)) WHERE acceptedAt IS NULL AND revokedAt IS NULL`; an expired pending row is revoked in the same transaction before the insert | AS-30 |
- **Alternatives**: serializable for everything (retries on unrelated writes); optimistic version column on `Shop` for seats (retry storms on invite bursts).

## R-05 Why serializable only for the owner invariant

- **Decision**: role change / removal / self-leave run `SERIALIZABLE`; the invite and provisioning paths use the row lock. A role change that cannot reduce the owner count (target is not an `OWNER`, new role is `OWNER`) still runs through the same code path (simplicity) but cannot conflict meaningfully.
- **Rationale**: write skew exists only when two transactions each read "another owner exists" and remove different owners; snapshot isolation misses it, serializable detects it. Row locks on owner rows (`SELECT … FOR UPDATE` over all owner rows of the shop) would also work; serializable was chosen because the spec asks for it (FR-022) and the test injects `40001`.
- **Alternatives**: `FOR UPDATE` on all owner rows (deterministic, no retry) — recorded as the fallback if serializable proves flaky in the AS-23 repetition run.

## R-06 Invite token and acceptance

- **Decision**: token = 24 random bytes (`crypto.randomBytes`), base64url, 32 characters; stored `sha256` hex digest; compare by digest lookup (the index lookup is on a hash of a high-entropy value, so timing leaks nothing usable). The token appears only in the `tenancy.invite_requested` outbox message and is never logged (log redaction list gets `token`). Accept: rate check by IP and by failed-attempt budget → length check (400) → address from `UserDirectoryService.getUsersByIds([userId])` → conditional update inside `crossTenant('invite.accept')` → membership insert `ON CONFLICT DO NOTHING` → `alreadyMember` branch. All failure paths return the same body.
- **Rationale**: FR-030–FR-033; notes 05/02.
- **Alternatives**: signed JWT invite (no stored digest, but cannot be revoked or counted as pending); HMAC of token with a server key (extra secret to rotate for no gain at 192 bits).

## R-07 SSO discovery and the resolver

- **Decision**: `OidcDiscoveryPort.fetch(issuer)` implemented with `safeRequest` (HTTPS only, SSRF guard, `timeoutMs: 3000`, no retry, response ≤ 64 KB), validating `issuer` equality and the presence of the endpoints S02 needs. Called before any transaction. The resolver reads the config through the repository inside `inShop(shopId)`, checks `enabled` and shop `ACTIVE`, opens the secret with context `shop-sso:<shopId>` (falls back to the context-less open for rows not yet re-sealed), and returns `{issuer, clientId, clientSecret, scope?}`. Configure, disable, status change and purge call `registry.invalidate('shop:<id>')` after commit.
- **Rationale**: matches S02's Provides and FR-040–FR-045; SSRF classification mapped: scheme/host class → `sso_issuer_invalid`, document mismatch → `sso_issuer_mismatch`, timeout/error → `sso_issuer_unreachable`.
- **Alternatives**: `openid-client` discovery in tenancy (duplicates S02's protocol code and bypasses `safeRequest`).

## R-08 Provisioning consumer

- **Decision**: projector `tenancy-sso-provisioning` on `identity.events`, handling `identity.federated_identity_linked` v1 (and tolerating `identity.user_registered` by ignoring it — the first shop-IdP login emits the linked event per S02). Idempotency `inbox` (`recordOnce('tenancy-sso-provisioning', eventId)` in the transaction of the effect, retention ≥ 30 days via the inbox purge setting), plus `ON CONFLICT (shopId,userId) DO NOTHING` as the second guard. Outcomes: `provisioned`, `existing`, `ignored` (non-`shop:` provider, unknown or non-active shop, SSO disabled), `denied` (no seat; audit line). Invalid payloads throw `PermanentError`.
- **Rationale**: FR-042, AS-47–AS-49; the inbox row survives member removal so redelivery cannot re-add.
- **Alternatives**: membership uniqueness only (re-adds a removed member on redelivery — rejected by AS-49).

## R-09 Verification and plan consumers

- **Decision**: `tenancy-verification` (inbox) applies `nextVerification(status, event)` from the pure machine; `VERIFIED` ignores everything, so a late `submitted` after `verified` is a no-op, and `payoutsEnabled = status === 'VERIFIED'`. `tenancy-plan` (`versionGuard`) applies `UPDATE "Shop" SET plan=…, "planVersion"=:v WHERE id=:id AND "planVersion"<:v`; zero rows = stale/duplicate. Both write the outbox event in the same transaction only when the row changed.
- **Rationale**: FR-008, AS-71–AS-73.
- **Alternatives**: last-write-wins on plan (breaks P0610 out-of-order); timestamp guard (clock skew between emitters).

## R-10 Cells

- **Decision**: `TenantConnectionResolver` builds one Sequelize pool per configured cell at boot from validated config (`TENANCY_CELLS` JSON: name → URL, pool max, acquire 2000 ms), never from `process.env` at call time. `connectionFor(shopId)` → `ShopCellService.cellOf` (cache-aside, 5 min, entry dropped on move) → pool or `CellUnavailableError` (`503 cell_unavailable`, `Retry-After: 1`). Pool acquire timeout is mapped to the same error. Tenancy tables stay on the pooled control plane (Assumptions).
- **Rationale**: FR-051, AS-53–AS-55; bulkhead by construction (separate pools).
- **Alternatives**: one pool with per-cell semaphores (a hung connection still starves shared sockets); a proxy (PgBouncer routing) — an ops choice, not needed by the application contract.

## R-11 Row-level security

- **Decision**: policies on `ShopInvite`, `ShopSsoConfig`, `ShopMembership`: `USING (rls_bypass() OR "shopId" = current_setting('app.shop_id', true)::uuid [OR "userId" = current_setting('app.user_id', true)::uuid for membership])` with the same expression as `WITH CHECK`; `FORCE ROW LEVEL SECURITY`. `ShopTransactionRunner.inShop(shopId, fn, {userId?})` sets the settings with `set_config(..., true)`; `crossTenant(reason, fn)` throws `UnknownBypassReasonError` before any query unless `reason ∈ CrossTenantReason`, increments `tenancy_rls_bypass_total{reason}` and logs. A startup check (`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user`) fails boot in production, warns in test.
- **Rationale**: FR-053, AS-57–AS-60; `Shop` and `ShopDirectory` are not shop-private (public/batch reads, routing) so they carry no policy.
- **Alternatives**: policies on `Shop` (breaks anonymous batch read and slug lookup without bypass).

## R-12 Cursor pagination

- **Decision**: cursor = base64url JSON `{k: [sortKey, tiebreaker]}` signed with an HMAC of the route name (tamper → `400 validation_failed`); order `(createdAt, shopId)` for `mine`, `(createdAt, userId)` for members, `(createdAt DESC, id)` for invites; keyset predicate `(a,b) > (:a,:b)`; fetch `limit+1`.
- **Rationale**: FR-005; opaque and tamper-evident, no offset scans.
- **Alternatives**: plain base64 (tampering allowed, only a 400 on shape); offset (unstable under inserts).

## R-13 Offboarding and purge

- **Decision**: start = conditional `ACTIVE|SUSPENDED → DELETING` with `purgeAt = now + 30 d` and history row; cancel = `DELETING → ACTIVE` clearing `purgeAt`. Purge job selects due shops (`status='DELETING' AND purgeAt <= now`, `FOR UPDATE SKIP LOCKED`, ≤ 50), one `TransactionRunner.run` per shop: delete memberships, invites, SSO config, directory row; tombstone the shop (`status DELETED`, `name '[deleted]'`, `slug 'deleted-<id>'`, `sandboxOf` kept null); append `tenancy.shop_deleted` and one `member_removed{reason:'shop_deleted'}` per member; after commit revoke SSO members' sessions and invalidate the registry and caches. A failure is caught per shop and counted.
- **Rationale**: FR-060–FR-062, AS-69.
- **Alternatives**: soft-delete of children (leaves addresses, violates SC-008).

## R-14 Test strategy decisions

- Fixtures `createShop` / `addMember` / `clockAt` live in `packages/backend/test/` and may touch every table (IX.6); old `tenancy.e2e-spec.ts` cases are migrated into the new files and the file is removed in WP-12.
- Fault injection: a trigger raising `40001` on `ShopMembership` updates and a trigger failing inserts into the outbox, both created and dropped by the test.
- Query counting for AS-55, AS-75, AS-76 uses the Sequelize `logging` hook in the test connection.
- AS-23 and SC-003: the e2e uses 20 repetitions; the 200-pair run is an ops artifact (quickstart).
