# Data model: S31 (domain `asset-library`)

All tables are owned by `domain:asset-library`; every new one is registered in `packages/backend/db/ownership.ts` and `docs/work/architecture/domain-map.md` in the same change (IX.3). IDs are `uuidv7()`, times are `timestamptz` written from the platform clock (FR-049), no foreign key leaves the domain (IX.4, AS-79). Every migration is expand/contract with `lock_timeout` (III.11); new migration files are dated after `20261003090000`.

## Existing tables, changes (gaps B1–B3, B5, B6)

| Table | Change |
|---|---|
| `Asset` | drop FK `shopId → Shop`; add `status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK IN ('ACTIVE','DELETED','PURGED')` (backfilled from `deleted`, then `deleted` dropped in the contract step), `deletedAt timestamptz NULL`, `createdAt`; unique `(shopId, path) WHERE status = 'ACTIVE'`; keyset index `(shopId, path, id) WHERE status = 'ACTIVE'`; index `(status, deletedAt) WHERE status = 'DELETED'` for purge |
| `AssetVersion` | rename `size → sizeBytes`; keep `chunks TEXT[]` (ordered); index `(assetId, version DESC)` |
| `AssetChunk` | add `storedAt timestamptz NULL` (confirmed in storage), `protectedUntil timestamptz`, `deleting boolean DEFAULT false`, `reserved boolean`; keep `unreferencedSince`; GC index `(protectedUntil) WHERE "refCount" = 0` |
| `AssetSyncState` | add `minSeq BIGINT NOT NULL DEFAULT 0` (retention floor) |
| `AssetChange` | index `(at)` for the purge by age |
| `AssetShareLink` | add `id UUID`, `shopId`, `createdBy`, `createdAt`, `revokedAt`; PK moves to `id`, `tokenHash` becomes a unique index; drop FK to `Asset` cascade (purge removes links explicitly, FR-029) |
| `DigitalProduct` | drop FK `productId → Product` (the cascade is replaced by the `catalog.product_deleted` consumer); add `shopId`, `linkedAt` |

## New tables (gap B4, B6, B7)

| Table | Columns (key in bold) | Notes |
|---|---|---|
| `AssetVersionChunk` | **assetId, version, hash**, shopId, occurrences INT | per distinct hash of a version; index `(shopId, hash)`; sum of `occurrences` per `(shopId, hash)` equals `AssetChunk.refCount` (AS-44) |
| `AssetShopUsage` | **shopId**, storedBytes BIGINT, reservedBytes BIGINT, `CHECK (storedBytes >= 0 AND reservedBytes >= 0)` | quota by conditional update (D5) |
| `AssetEntitlement` | **id**, orderId, productId, shopId, buyerId, assetId, title, status ('ACTIVE','REVOKED'), revokedReason ('refunded','shop_deleted'), grantedAt, revokedAt, downloadCount INT, lastDownloadAt | unique `(orderId, productId)`; keyset index `(buyerId, grantedAt DESC, id) WHERE status = 'ACTIVE'`; lookup `(buyerId, productId) WHERE status = 'ACTIVE'`; index `(productId)` for sold-product guard, `(assetId)` for `asset_in_use` |
| `AssetDownloadGrant` | **tokenHash CHAR(64)**, kind ('share','purchase'), shopId, assetId, version, shareLinkId NULL, entitlementId NULL, buyerId NULL, expiresAt, createdAt | purge job removes expired rows (`assets.purge-download-grants`); index `(expiresAt)` |
| `AssetOrderRevocation` | **orderId**, orderVersion, revokedAt | D8 |
| `AssetCommitReceipt` | none: idempotency uses the S54 facility's table | — |

State machines: `Asset: ACTIVE → DELETED → PURGED` (delete, undelete, purge are conditional `UPDATE … WHERE status = $from`); `AssetEntitlement: ACTIVE → REVOKED` (terminal); share-link status is derived (`REVOKED` if `revokedAt`, else `EXPIRED` if `expiresAt <= now`, else `EXHAUSTED` if `downloads >= maxDownloads`, else `ACTIVE`). A `models/` page for the asset and entitlement status machines goes with the living-spec page.

## Invariants (each has an e2e assertion)

1. `AssetChunk.refCount = SUM(AssetVersionChunk.occurrences)` per `(shopId, hash)`, never negative (AS-40, AS-44).
2. Every chunk of every non-purged version has `storedAt IS NOT NULL` and an existing storage object (AS-43, SC-005).
3. `AssetChange.seq` per shop is `minSeq+1 … lastSeq` without gaps (AS-29).
4. `AssetShopUsage.storedBytes + reservedBytes <= quota` (AS-15) and equals the sum of `AssetChunk.size` of held rows.
5. One entitlement per `(orderId, productId)`; a revoked order has none `ACTIVE` (AS-62, AS-65).
6. A share link's `downloads <= maxDownloads` (AS-50).
