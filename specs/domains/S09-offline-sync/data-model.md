# Data Model: S09 (domain `catalog-sync`, tables owned by `domain:catalog-sync`)

All tables are in `packages/backend/db/ownership.ts`; the only new one (`SyncConflict`) is added there. No table below references a catalog or tenancy table at database level (FR-038, AS-53). Every lookup includes `shopId` (III.4). Migrations are expand/contract with `lock_timeout` (R-16).

## SyncOperation (reshaped)

| Column | Type | Notes |
|---|---|---|
| `shopId` | uuid NOT NULL | part of the key |
| `opId` | uuid NOT NULL | client UUIDv7; **unique `(shopId, opId)`**; old single-column primary key dropped in the contract step |
| `deviceId` | text | `X-Device-Id` |
| `userId` | uuid | authenticated user at push time (FR-009) |
| `type` | text | `stock.adjust` \| `stock.count` \| `product.update` |
| `productId` | uuid | plain column, no FK |
| `hlc` | text | operation clock |
| `fingerprint` | char(64) | SHA-256 of canonical `{type, productId, hlc, payload}` (R-02) |
| `content` | jsonb | payload needed to complete the operation without the client |
| `status` | text | `pending` \| `applied` \| `merged` \| `conflict` \| `rejected` (`retry` is never stored) |
| `code` | text null | stable code for non-`applied` |
| `detail` | jsonb null | `applied[]`, `superseded[]`, `delta`, conflict numbers; no product text |
| `quantityAfter`, `productVersion` | int null | original values returned on replay |
| `claimedAt` | timestamptz | lease start (60 s) / takeover token |
| `createdAt`, `completedAt` | timestamptz | `completedAt` null while pending |

Indexes: unique `(shopId, opId)`; `(status, claimedAt) WHERE status = 'pending'` (recovery job); `(createdAt)` (purge).
Legacy columns kept during expand: old `result` (mirrors `status`), `appliedAt`.

**State transitions**: `pending → applied|merged|conflict|rejected` (conditional on `status = 'pending'`); takeover rewrites `claimedAt` only if it still equals the value read. Terminal rows are immutable (a replay returns them). Retention: 90 days from `createdAt`, except rows with an open conflict (FR-009, FR-037).

## SyncConflict (new)

| Column | Type | Notes |
|---|---|---|
| `shopId`, `opId` | uuid | unique `(shopId, opId)`; one conflict per operation |
| `deviceId`, `productId` | text/uuid | copied from the operation |
| `kind` | text | `oversold` \| `quantity_limit` |
| `requested`, `applied`, `shortfall`, `quantityAfter` | int | the numbers of FR-030 |
| `status` | text | `open` \| `dismissed` |
| `createdAt` | timestamptz | list order `(createdAt DESC, opId DESC)` |
| `dismissedAt`, `dismissedBy` | timestamptz/uuid null | set by the conditional `open → dismissed` update |

Index `(shopId, status, createdAt DESC, opId DESC)`. Transition `open → dismissed` is one `UPDATE … WHERE status = 'open'` (second caller affects 0 rows → `409 conflict_not_open`). Dismissed rows are removed with their operation (90 d). Distinct from S08's `StockConflict`.

## ShopChangeLog (feed entry, reshaped)

`shopId`, `seq` bigint (PK `(shopId, seq)`), `entity` ('product'), `entityId` uuid, **`version` int**, **`deleted` bool**, `data` jsonb (`title, description, priceMinor, currency, quantity, status`; null for tombstones), `occurredAt`, `createdAt`.
Unique `(shopId, entityId, version)` (duplicate guard); index `(shopId, entityId, version DESC)` (out-of-order guard, bootstrap `DISTINCT ON`). Feed trigger and function dropped in the contract step.
**Invariant**: for a shop, committed `seq` values are exactly `1…lastSeq` (writers serialise on the `ShopSyncState` row).
**Compaction**: delete entries older than 30 d for which a newer entry of the same product exists; keep the newest entry per product and tombstones younger than 30 d; set `horizonSeq` to the highest removed `seq`.

## ShopSyncState (reshaped)

`shopId` PK, `lastSeq` bigint, **`generation` int** (new feed generation on rebuild/backfill; bound into cursors), **`horizonSeq` bigint** default 0, **`horizonAt`** timestamptz null, `updatedAt`. Row created on first event/first backfill; locked `FOR UPDATE` by every feed writer (R-05).

## ProductFieldClock (reshaped)

`shopId` uuid NOT NULL (new), `productId` uuid, `field` ('title'|'description'|'priceMinor'), `hlc` text, `updatedAt`. PK `(shopId, productId, field)`. **Foreign key to the product table and its cascade are dropped.** Legacy field name `price` rows are renamed to `priceMinor` in the expand step. Rows removed on `catalog.product_deleted` and `tenancy.shop_deleted`. Rows whose shop cannot be derived are deleted in the data step (rebuilt by the next edit; documented loss of an LWW clock only).

## Value objects (no table)

- **Hybrid clock** `<15-digit ms>-<5-digit counter>-<node>`; string comparison = order. Server node `server-<instance>`.
- **Cursor** `v1.<shopId>.<generation>.<seq>` + HMAC, base64url (R-06).
- **Operation outcome** `applied | merged | conflict | rejected | retry` + `replayed` + closed `code` list (FR-006).

## Relationships and ownership

Operations → conflicts (same `(shopId, opId)`, application-level, no FK). Feed, clocks, state keyed by `(shopId, productId)` as plain IDs. Products are reached only through `ProductStockService`, `ProductQueryService.getProductsByIds`, `ProductCommandService.update|listByShop`, and events `catalog.product_*`.
