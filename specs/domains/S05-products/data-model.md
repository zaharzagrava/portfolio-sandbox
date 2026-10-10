# Data Model: S05 — Products (domain `catalog`)

All tables live in `public` and are owned by `domain:catalog` in `packages/backend/db/ownership.ts`. Cross-domain references (`shopId`, `createdBy`, `sellerId`, `actorId`) are plain UUID columns with no foreign key (IX.4). Migrations: expand first (columns, tables, indexes `CONCURRENTLY`, constraints `NOT VALID`), contract later; each step sets `lock_timeout`.

## `Product` (exists; altered)

| Column | Type | Rule |
|---|---|---|
| `id` | UUID PK | `uuidv7()` default (time-ordered), server generated |
| `shopId` | UUID | owning shop for life; nullable until the contract step, then `NOT NULL`; **no FK** (dropped) |
| `createdBy` | UUID NULL | user who created it; plain id; set by the catalog, copied from `sellerId` for legacy rows |
| `sellerId` | UUID NULL | legacy column, no FK (dropped), no longer mapped or serialised; dropped in a later contract once legacy writers are gone |
| `title` | varchar(255) | 1–200 code points after trim |
| `description` | TEXT | 0–4,000 code points (default empty string) |
| `brand`, `category` | varchar(255) | 1–100 code points after trim |
| `priceMinor` | BIGINT NOT NULL | `1 … 10,000,000,000`; trigger mirrors `price` ⇄ `priceMinor` during the transition |
| `price` | BIGINT | legacy name; dropped when its last reader (`gaps.md` section C) has moved |
| `currency` | varchar(3) NOT NULL | the platform currency (`platform_currency` config), default at the application level |
| `rating` | FLOAT NOT NULL default 0 | read-only here |
| `tags` | JSONB NOT NULL default `[]` | ≤ 32 strings of 1–50 code points, trimmed, lower-cased, de-duplicated in order |
| `quantity` | INTEGER NOT NULL | `CHECK ("quantity" >= 0 AND "quantity" <= 1000000000)` (`NOT VALID`, then `VALIDATE` in the contract step) |
| `status` | varchar(16) NOT NULL default `'ACTIVE'` | `CHECK (status IN ('ACTIVE','ARCHIVED'))` |
| `version` | INTEGER NOT NULL default 1 | `CHECK (version >= 1)` (`NOT VALID`); legacy `0` rows are raised to 1 by the migration; bumps by 1 on every committed change **except** a view flush |
| `viewCount` | BIGINT NOT NULL default 0 | written only by the flush job |
| `isSandbox` | BOOLEAN NOT NULL default false | stamped at creation from the shop summary |
| `externalSku` | TEXT NULL (exists) | 1–128 characters; set only by `upsertFromExternal` |
| `embedding`, `searchVector` | JSONB / tsvector | left in place, **unmapped** (S32 owns the decision) |
| `createdAt`, `updatedAt` | timestamptz | `updatedAt` = injected clock on every change except a view flush |

Indexes: PK; unique `("shopId","externalSku") WHERE "externalSku" IS NOT NULL` (exists, `Product_shop_external_sku_uq`); new `("shopId","createdAt" DESC,"id" DESC)` for the list; new `("shopId","status","createdAt" DESC,"id" DESC)` is not added (the status filter is selective enough on the first index for this scale; revisit with measurements).

Dropped constraints (contract migration `…-contract-fks`): `Product_sellerId_fkey` (→ `User`), `Product_shopId_fkey` (→ `Shop`). Added: `NOT NULL` on `shopId` after the backfill (via `CHECK ("shopId" IS NOT NULL) NOT VALID` → `VALIDATE` → `SET NOT NULL` → drop the check; each with `lock_timeout`). The `Product_shopId_not_null` check created by S03's old backfill is dropped in the same step.

Visibility (pure rule, also the SQL predicate): public iff `status = 'ACTIVE' AND NOT isSandbox AND COALESCE(shopState.status,'ACTIVE') = 'ACTIVE'`.

## `ProductStatusHistory` (new)

| Column | Type | Rule |
|---|---|---|
| `id` | UUID PK | `uuidv7()` |
| `productId` | UUID NOT NULL | no FK (the purge deletes history together with the product, in one transaction) |
| `shopId` | UUID NOT NULL | purge and list predicate |
| `fromStatus`, `toStatus` | varchar(16) NOT NULL | the two legal pairs only (`CHECK`) |
| `productVersion` | INTEGER NOT NULL | version after the change |
| `actorId` | UUID NULL | the member; NULL for system actors |
| `at` | timestamptz NOT NULL | injected clock |

Index `("productId","at")`, `("shopId")`. Append-only.

## `ProductStockOperation` (new)

| Column | Type | Rule |
|---|---|---|
| `operationId` | varchar(128) PK | caller's id; **unique**: this is the idempotency key |
| `productId` | UUID NOT NULL | |
| `shopId` | UUID NOT NULL | |
| `delta` | INTEGER NOT NULL | non-zero, `|delta| ≤ 1,000,000` (`CHECK`) |
| `reason` | varchar(64) NOT NULL | `[a-z0-9._-]{1,64}` |
| `quantityAfter` | INTEGER NOT NULL | returned on replay |
| `productVersion` | INTEGER NOT NULL | returned on replay |
| `appliedAt` | timestamptz NOT NULL | purge cut-off (30 days) |

Index `("appliedAt")` for the purge, `("shopId")` for the shop purge. Insert is `ON CONFLICT ("operationId") DO NOTHING RETURNING`; no row back means a replay or a concurrent twin, resolved by reading the stored row and comparing `productId`/`shopId`/`delta` (mismatch → `StockOperationConflictError`).

## `ProductShopState` (new): catalog's copy of the shop facts (IX.8)

| Column | Type | Rule |
|---|---|---|
| `shopId` | UUID PK | |
| `status` | varchar(16) NOT NULL | `ACTIVE | SUSPENDED | DELETING | DELETED` (S03's enum) |
| `shopVersion` | INTEGER NOT NULL | version guard: an event applies only if its `shopVersion` is greater |
| `updatedAt` | timestamptz NOT NULL | |

No row means `ACTIVE`. The row of a purged shop is deleted by the last purge run.

## `ProductViewBatch` (new): applied-chunk markers of the view flush

| Column | Type | Rule |
|---|---|---|
| `batchId` | UUID | the `WriteBehindCounter.claim()` id |
| `chunk` | INTEGER | 0-based chunk index |
| `appliedAt` | timestamptz | purge after 7 days |

PK `(batchId, chunk)`. Written in the same transaction as the chunk's `UPDATE`; a replay finds the marker and skips the statement.

## State machine (domain, pure)

```
ACTIVE --archive--> ARCHIVED --restore--> ACTIVE
```

Every other (status, transition) pair is `invalid_transition`. A transition is a conditional update (`WHERE status = :from AND version = :expected`) plus one `ProductStatusHistory` row and one event, in one transaction. `ARCHIVED` refuses edits (`product_archived`) and negative stock deltas (`unavailable`); positive deltas and external upserts still apply.

## Cache and Redis keys (owned by `catalog`)

| Key | Content | Lifetime |
|---|---|---|
| `product:v2:<id>` | public view + `version`, or a negative marker | 60 s fresh, 300 s stale, negative 10 s, ±10% jitter; ≤ 32 KiB |
| minimum-version key (toolkit-derived from the entry key) | highest invalidated version | 300 s (retention) |
| `counter:{product-views}:pending` and `…:claim:<batchId>` | pending view deltas | until flushed / reclaimed (toolkit) |
| in-process L1 | hot keys only | ≤ 1 s |

No list is ever stored under one key.

## Events

Topic `products.events`, key `productId`, `latest-per-key`. See [contracts/events.md](contracts/events.md).

## Entities in code

`ProductRecord` (repository row, internal), `ProductDto` (R1, includes `quantity`, `status`, `isSandbox`, `externalSku`, `viewCount`), `ProductMemberView`, `ProductPublicView`, `ProductBatchItem` (mappers in `domain/product-view.ts`; no ORM model leaves `infra/`).
