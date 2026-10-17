# Data model: S06 — Collaborative listing drafts

All tables are `domain:catalog` in `db/ownership.ts` (already registered). Ids are UUID (v7 for new rows). No foreign key to another domain's table.

## Postgres

### `ListingDraft` (altered)

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| shopId | uuid NOT NULL | plain id (FK to `Shop` dropped) |
| productId | uuid NULL | plain id (FK to `Product` dropped) |
| baseProductVersion | integer NULL | **new**; version of the product when the draft started |
| title | varchar(120) NOT NULL | label, not the document title |
| status | varchar CHECK in (`DRAFT`,`PUBLISHING`,`PUBLISHED`,`ARCHIVED`) | `PUBLISHING` **new** |
| createdBy | uuid NOT NULL | plain id (FK to `User` dropped) |
| publishLeaseId | uuid NULL | **new**; set on claim, cleared on release/finish |
| publishLeaseExpiresAt | timestamptz NULL | **new**; claim time + 60 s |
| publishedAt | timestamptz NULL | |
| snapshotKey / snapshotSeq | existing | pointer, moves forward only |
| createdAt, updatedAt | timestamptz | |

Indexes: `(shopId, updatedAt DESC, id DESC)` for the keyset list; partial `(shopId) WHERE status IN ('DRAFT','PUBLISHING')` for the cap count; partial `(publishLeaseExpiresAt) WHERE status='PUBLISHING'` for the stale job.

State machine (pure, `domain/draft-status.ts`): `DRAFT → PUBLISHING` (claim), `PUBLISHING → PUBLISHED` (finish, needs lease id), `PUBLISHING → DRAFT` (failure/expiry), `DRAFT → ARCHIVED`. Everything else is `invalid_transition` (`PUBLISHING` archive → `publish_in_progress`). Every transition is `UPDATE … WHERE id AND shopId AND status = :from [AND publishLeaseId = :lease]` and asserts 1 row.

### `ListingDraftVersion` (altered)

`id`, `draftId` (plain id, same-table FK kept), `shopId` (**new**, denormalised for the predicate), `name` varchar(80), `kind` (`named`|`published`, **new**, default `named`), `snapshotKey`, `createdBy`, `createdAt`. Index `(draftId, createdAt DESC, id DESC)`. Count ≤ 200 per draft enforced in the insert statement.

### Migrations (expand/contract, `lock_timeout`)

1. `…-catalog-s06-expand`: add columns, widen status CHECK, add `kind`/`shopId`, create indexes (`CONCURRENTLY` outside a transaction block).
2. `…-catalog-s06-contract`: drop the three foreign keys (`ListingDraft.shopId/productId/createdBy`) and the one on `ListingDraftVersion.createdBy` if present. No data migration (no production data; document key `price` is not migrated).

## DynamoDB `DocUpdates` (owned by `catalog`)

Partition `draftId`, sort `seq` (number), attribute `bytes` (binary, ≤ 300 KB). A pointer item `seq = 0` holds `snapshotKey`, `snapshotSeq`. Writes are conditional (`attribute_not_exists(seq)`). Superseded snapshot keys are listed in `superseded` items with `eligibleAt`.

## Object store

`drafts/<draftId>/snap-<seq>` snapshots; `versions/<versionId>` frozen version content (encoded Yjs state). Referenced by the rows above; unreferenced objects older than 1 h are removed by the daily job.

## Redis

`collab:ring` (instance hash, heartbeat TTL 15 s), `collab:ticket:<jti>` (NX, 60 s), `collab:revoke` (pub/sub channel), rate-limit and idempotency keys from their facilities.

## Draft document (Yjs, not a row)

`title` Y.Text, `description` Y.Text, `fields` Y.Map (`priceMinor` integer, `brand`, `category`, `quantity` integer), `specs` Y.Map (text → text). Reading it (`listing-doc.ts`) is total: wrong types become `undefined` and are reported by publish validation, not thrown.

## Events

`catalog.draft_published` v1, topic `drafts.events`, key `draftId`; payload `{draftId, shopId, productId, productVersion, versionId, publishedBy}` (see `contracts/events-services.md`).
