# Data Model: S32 — Product Search

Ownership: everything here is owned by `domain:discovery` (IX.3). Table and model names follow the repository's existing convention (PascalCase model, quoted table); the implementation checks the key format against `db/ownership.ts` and `check:table-ownership`. Cross-domain references (`shopId`, `productId`) are plain UUID columns with no foreign key (IX.4).

## 1. Postgres tables (new, expand-only, each migration sets `lock_timeout`)

### SearchShopProduct (shop product search row, P0308)

| Column | Type | Notes |
|---|---|---|
| `productId` | uuid PK | |
| `shopId` | uuid NOT NULL | tenant predicate in every query |
| `title` | text NOT NULL | |
| `brand` | text NULL | |
| `status` | text NOT NULL | `ACTIVE` \| `ARCHIVED` (CHECK) |
| `priceMinor` | bigint NOT NULL | CHECK ≥ 0 |
| `currency` | char(3) NOT NULL | |
| `quantity` | integer NOT NULL | |
| `isSandbox` | boolean NOT NULL | informational; the route is shop-scoped |
| `productVersion` | bigint NOT NULL | version guard |
| `deletedAt` | timestamptz NULL | tombstone; purged after 30 days |
| `updatedAt` | timestamptz NOT NULL | |
| `searchVector` | tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(title,'') \|\| ' ' \|\| coalesce(brand,''))) STORED | |

Indexes: PK; GIN `searchVector`; GIN `lower(title) gin_trgm_ops`; btree `(shopId, status)` partial `WHERE deletedAt IS NULL`; btree `(deletedAt)` partial `WHERE deletedAt IS NOT NULL` (purge).

Write rule (version guard, one statement): `INSERT … ON CONFLICT (productId) DO UPDATE SET … WHERE SearchShopProduct.productVersion <= EXCLUDED.productVersion AND (SearchShopProduct.deletedAt IS NULL OR EXCLUDED.kind = 'created' AND EXCLUDED.productVersion > SearchShopProduct.productVersion)`; the decision matrix is the pure `projection-guard` (AS-81), the SQL is its backstop. Delete: `deletedAt = occurredAt`, product columns kept minimal.

### SearchShopState (copy of tenancy data, IX.8)

`shopId` uuid PK; `status` text (`ACTIVE|SUSPENDED|DELETING|DELETED`); `plan` text NULL (`STARTER|PRO|ENTERPRISE`); `shopVersion` bigint NULL; `offboarding` boolean NOT NULL default false; `lastEventAt` timestamptz NOT NULL; `statusVersion`/`planVersion` follow `shopVersion` where present, else `lastEventAt` decides. A missing row means `ACTIVE`, tier neutral.

### SearchReindexRun

| Column | Type | Notes |
|---|---|---|
| `runId` | uuid PK | |
| `kind` | text | `REINDEX` \| `ROLLBACK` |
| `status` | text | `QUEUED, BUILDING, CATCHING_UP, COMPLETED, FAILED, CANCELLED` (CHECK) |
| `mappingVersion` | int | |
| `embeddingModelVersion` | text | |
| `index` | text NULL | target index |
| `previousIndex` | text NULL | |
| `previousRetiresAt` | timestamptz NULL | switch time + 24 h |
| `replayPosition` | jsonb | `{topic: {partition: offset}}` + watermark; mirror of the run's consumer group |
| `documents` | bigint NOT NULL default 0 | |
| `ledger` | jsonb | event accounting counters for the gate |
| `failureReason` | text NULL | `verification_failed`, `engine_unavailable`, … |
| `switchingAt` | timestamptz NULL | claim that arbitrates switch vs cancel |
| `requestedBy` | uuid | admin actor |
| `startedAt`, `finishedAt`, `createdAt` | timestamptz | |

Indexes: partial unique index `ON ((true)) WHERE status IN ('QUEUED','BUILDING','CATCHING_UP')` (single active run, III.6); `(createdAt DESC, runId DESC)` for the keyset run list.

Transitions (pure `reindex-run-status.ts`, AS-82): `QUEUED→BUILDING|CANCELLED`, `BUILDING→CATCHING_UP|FAILED|CANCELLED`, `CATCHING_UP→COMPLETED|FAILED|CANCELLED`; terminal: `COMPLETED`, `FAILED`, `CANCELLED`. Every transition: `UPDATE … SET status = :to … WHERE runId = :id AND status = :from` asserting one row, plus a `SearchReindexRunHistory` row in the same transaction. A `ROLLBACK` run uses the same legal edges (`QUEUED → BUILDING → CATCHING_UP → COMPLETED`): `BUILDING` does no build work (its target is the retained index), `CATCHING_UP` checks lag, then the switch.

### SearchReindexRunHistory

`historyId` bigint identity PK; `runId` uuid; `fromStatus` text NULL; `toStatus` text; `at` timestamptz; `detail` jsonb. Index `(runId, historyId)`.

### SearchSynonymSet (single row, `id = 1`)

`id` smallint PK CHECK = 1; `version` int NOT NULL; `rules` text[] NOT NULL; `updatedBy` uuid NULL; `updatedAt` timestamptz; `pendingVersion` int NULL; `pendingRules` text[] NULL; `pendingAt` timestamptz NULL. Seeded at version 1 from the old code defaults by migration data step.

### SearchSynonymVersion

`version` int PK; `rules` text[]; `updatedBy` uuid; `createdAt` timestamptz. Pruned to 20 rows and 90 days (never below the current version).

## 2. Public index document (`products_m<mapping>_<ts>`, `_id = productId`)

| Field | Mapping | Written by (guard) |
|---|---|---|
| `productId` | keyword | product (tie-break sort) |
| `shopId` | keyword | product |
| `title` | text (+ `title.autocomplete` edge n-gram, S33; search analyzer with `synonyms_set`) , `title.raw` keyword | product (`productVersion`) |
| `brand` | text + keyword | product |
| `description`, `tags` | text / keyword | product |
| `category` | keyword | product |
| `priceMinor` | long | product |
| `currency` | keyword | product |
| `rating` | float | product |
| `inStock` | boolean | product (derived from `quantity > 0`) |
| `status` | keyword (`ACTIVE`) | product |
| `createdAt` | date | product |
| `productVersion` | long | product guard value |
| `hasProduct` | boolean | product (false for signal-only docs) |
| `deleted`, `deletedAt` | boolean, date | product (tombstone) |
| `embedding` | dense_vector 64, cosine, indexed | product (only when text fields changed) / backfill |
| `embeddingPending` | boolean | product / backfill |
| `shopStatus`, `shopHidden`, `shopTier`, `shopStateVersion` | keyword, boolean, keyword, long | shop-state (`shopStateVersion`/`lastEventAt`) |
| `imageUrl`, `galleryVersion` | keyword (not indexed), long | media (`galleryVersion`) |
| `sponsored`, `sponsorshipVersion` | boolean, long | sponsorship (`sponsorshipVersion`) |
| `popularityBucket`, `popularityAt` | byte, date | popularity job (`popularityAt`) |
| `browseScore` | double | recomputed by whichever source changed one of its inputs |

Index `_meta`: `{mappingVersion, embeddingModelVersion, createdByRun}`. Settings: 24 shards, 2 replicas, `refresh_interval: 5s` (R-13; test profile overrides to 1 shard, 0 replicas).

Visibility filter (all queries): `hasProduct:true AND deleted:false AND status:ACTIVE AND shopHidden:false`.

## 3. Alias and index registry

Alias `products` → exactly one index. Derived (not stored): write set = alias target ∪ active run index ∪ retained previous index (from `SearchReindexRun`). `previousIndex` / `previousRetiresAt` live on the latest `COMPLETED` run.

## 4. Analytics (ClickHouse, existing)

`search_queries` (add `searchId`, `mode`, `degraded`, `surface`, `filters` columns if absent; TTL 90 d on event time), `search_clicks` (searchId, query, productId, position; TTL 90 d; deduplication by `searchId + productId + position + eventId`). Rows are written by the two projectors; invalid payloads go to the DLQ.

## 5. Events

| Event | Direction | Key | Notes |
|---|---|---|---|
| `catalog.product_created|updated|archived|restored|deleted` | consumed (`products.events`) | `productId` | `aggregateVersion = productVersion` |
| `tenancy.shop_status_changed|shop_plan_changed` | consumed (`shop.events`) | `shopId` | `shopVersion` |
| `tenancy.shop_offboarding_started|cancelled`, `shop_deleted` | consumed | `shopId` | no version → `occurredAt` |
| `media.gallery_changed` | consumed (schema owned locally until S29) | `productId` | `galleryVersion` |
| `marketing.product_sponsorship_changed` | consumed (schema owned locally until S36) | `productId` | `sponsorshipVersion` |
| `search.performed`, `search.result_clicked` | produced, direct | `searchId` | AS-76 |
| `search.reindex_completed` | produced, outbox | `runId` | `{runId, kind, index, previousIndex, documents, mappingVersion, finishedAt}` |

## 6. State summary

- Product in the public index: absent → present (ACTIVE visible) ↔ present hidden (archived or shop hidden) → tombstone (30 d) → absent.
- Run: see section 1. Synonym set: `version n` → (claim) pending `n+1` → commit `n+1` or clear.
- Cursor (opaque, base64url): `{sv, id, fp}`; no physical index name inside.
