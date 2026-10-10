# Data Model: S03

Owner of everything below: `tenancy` (`db/ownership.ts`: `Shop`, `ShopMembership`, `ShopInvite`, `ShopDirectory`, `ShopSsoConfig` already `domain:tenancy`; `ShopStatusHistory` added in the same change, IX.3). All tables live in the pooled control-plane database. No foreign key leaves the domain (FR-054). Migrations: `<ts>-tenancy-s03-expand.js` (columns, tables, indexes, RLS, `lock_timeout`), `<ts>-tenancy-s03-contract-fks.js` (drop FKs); both reversible.

## Shop (existing, extended)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `slug` | text not null unique | 3–40 chars `[a-z0-9-]`; immutable; tombstone `deleted-<id>` |
| `name` | text not null | 2–80; tombstone `[deleted]` |
| `plan` | text not null check in (`STARTER`,`PRO`,`ENTERPRISE`) default `STARTER` | |
| `planVersion` | bigint not null default 0 | **new**; version guard for `billing.subscription_plan_changed` |
| `status` | text not null check in (`ACTIVE`,`SUSPENDED`,`DELETING`,`DELETED`) default `ACTIVE` | `DELETED` **new** |
| `purgeAt` | timestamptz null | **new**; set while `DELETING` |
| `verificationStatus` | text not null check in (`UNVERIFIED`,`PENDING`,`VERIFIED`,`REJECTED`) default `UNVERIFIED` | |
| `payoutsEnabled` | boolean not null default false | true iff `VERIFIED` |
| `region` | text not null | from directory default; changes only through the admin move |
| `sandboxOf` | uuid null unique | **new/modelled**; same-table reference, no FK to other owners; `isSandbox = sandboxOf IS NOT NULL` |
| `shopVersion` | bigint not null default 1 | **new**; +1 on every write; carried by events (IX.8) |
| `stripeAccountId` | text null | **deprecated in tenancy**: not exposed by any DTO; column dropped by a later contract step after S14/S15 move the value (Sibling follow-up) |
| `createdAt`, `updatedAt` | timestamptz not null | |

Indexes: PK, unique `slug`, unique partial `sandboxOf`, `(status, purgeAt) WHERE status='DELETING'` (purge job).

Status machine (AS-64): `ACTIVE→SUSPENDED`, `SUSPENDED→ACTIVE`, `ACTIVE→DELETING`, `SUSPENDED→DELETING`, `DELETING→ACTIVE`, `DELETING→DELETED`; others `invalid_transition`. Every move: conditional `UPDATE … WHERE status = :from` (one row asserted), `shopVersion + 1`, a `ShopStatusHistory` row and an outbox event in one transaction.

Verification machine (AS-71): `UNVERIFIED→PENDING` (submitted), `PENDING→VERIFIED` (verified), `PENDING→REJECTED` (rejected), `REJECTED→PENDING` (submitted); `VERIFIED` ignores all; any other pair is a no-op for consumers (counted), never an error.

## ShopMembership (existing, extended)

| Column | Type | Notes |
|---|---|---|
| `shopId` | uuid not null | part of PK; same-domain reference to `Shop` |
| `userId` | uuid not null | part of PK; **no FK to identity's `User`** (dropped by the contract migration) |
| `role` | text not null check in (`OWNER`,`ADMIN`,`STAFF`,`VIEWER`) | |
| `source` | text not null check in (`owner`,`invite`,`sso`,`provisioned`) default `provisioned` | **new**; existing rows become `provisioned`, owner rows of shops created by the old code stay `provisioned` |
| `createdAt` | timestamptz not null | |

PK `(shopId, userId)`; index `(userId, createdAt, shopId)` for `mine`; index `(shopId, createdAt, userId)` for the members page. **RLS** (new): `USING/WITH CHECK` = bypass setting OR `shopId = app.shop_id` OR (read only) `userId = app.user_id`.

## ShopInvite (existing, extended)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `shopId` | uuid not null | |
| `email` | text not null | lower-cased, trimmed, ≤ 254; removed at purge |
| `role` | text not null check in (`ADMIN`,`STAFF`,`VIEWER`) | `OWNER` refused (FR-034) |
| `tokenDigest` | text not null unique | sha256 hex; never returned or logged |
| `invitedBy` | uuid not null | plain id |
| `expiresAt` | timestamptz not null | `createdAt + 7 d`; refreshed by resend |
| `acceptedAt`, `acceptedBy` | timestamptz / uuid null | **`acceptedBy` new** |
| `revokedAt` | timestamptz null | **new** |
| `createdAt` | timestamptz not null | |

Derived status: `accepted` if `acceptedAt`, else `revoked` if `revokedAt`, else `expired` if `expiresAt <= now`, else `pending`. Indexes: `(shopId, createdAt DESC, id)`, unique partial `(shopId, lower(email)) WHERE acceptedAt IS NULL AND revokedAt IS NULL` (**new**; migration pre-checks duplicates and revokes older ones, noted in the migration), `(expiresAt)` for the purge job. **RLS** unchanged (shop only; accept runs under `crossTenant('invite.accept')`).

## ShopDirectory (existing, extended)

`shopId` uuid PK, `cell` text not null default `pooled`, `region` text not null, `version` bigint not null default 1 (**new**), `updatedAt`. Conditional update on `version`. No RLS (routing data read before a tenant is known).

## ShopSsoConfig (existing, extended)

`shopId` uuid PK, `issuer` text not null (https), `clientId` text not null, `secretSealed` text not null (`SecretBox`, context `shop-sso:<shopId>`; rows sealed without context are re-sealed once), `defaultRole` text not null check in (`STAFF`,`VIEWER`) default `VIEWER` (**new**), `enabled` boolean not null default true, `updatedAt`. Disable = row deleted. **RLS** unchanged.

## ShopStatusHistory (new)

`id` uuid PK, `shopId` uuid not null, `from` text, `to` text not null, `actor` text not null (user id or `system`), `reason` text null, `at` timestamptz not null. Index `(shopId, at DESC)`. Append-only; kept after purge (no personal data: the actor id of an admin is not a shop member).

## Inbox use

Consumers record `(consumer, eventId)` in the platform inbox table in the transaction of the effect; retention ≥ 30 days.

## Redis (not a store of truth)

`authz:{shopId}:{userId}` → `{role, status}` or `null`, TTL 15 s / 10 s; per-shop index set for batch deletion; failures fall back to the database. Cell cache is in-process, 5 min, keyed by `shopId`, dropped on move.

## Events

Defined in `domain/events.ts` with `defineEvent`, aggregate `tenancy`, key `shopId`; see [contracts/events.md](contracts/events.md).

## Migration notes

Up, down, up must pass (AS-61). The expand migration adds nullable-then-backfilled columns inside batches (`UPDATE … WHERE id IN (… LIMIT 1000)`), creates indexes `CONCURRENTLY` in a separate non-transactional migration step, and sets `lock_timeout = '3s'`. The contract migration drops `ShopMembership_userId_fkey` and is listed as a separate deploy step after the new code runs; `Product.shopId` and `ChatChannel.shopId` FKs are dropped by S05 and the chat domain (gaps.md follow-ups), not here.
