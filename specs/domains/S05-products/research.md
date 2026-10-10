# Research: S05 — Products (domain `catalog`)

No `NEEDS CLARIFICATION` remains. Every decision below was checked against the code and toolkits as they are on branch `sdd/auto` (2026-10-10). Format: Decision, Rationale, Alternatives.

## D-1 One write path, three services, one transaction shape

- **Decision**: `ProductCommandService` (create, update, archive, restore, list, get), `ProductStockService` (`applyStockDelta`), `ProductImportService` (`upsertFromExternal`) each run their change as one `TransactionRunner.run`: conditional `UPDATE` (or `INSERT`) with `RETURNING`, history/operation row, `OutboxService.append` of one full-state event. The HTTP controllers call only `ProductCommandService`.
- **Rationale**: III.2, III.6, III.7, IV.4, FR-033, FR-042; keeps the shape A26 asks to keep.
- **Alternatives**: one big `ProductService` (rejected: the stock and import paths have different locking and result shapes); repository-level `@Transactional` (rejected: transactions belong to `application/`, I.1).

## D-2 Optimistic concurrency by `WHERE version = :expected`, no-op detection before the write

- **Decision**: the update loads nothing first. A single statement `UPDATE "Product" SET …, version = version + 1, "updatedAt" = :now WHERE id = :id AND "shopId" = :shopId AND version = :expected AND status = 'ACTIVE' RETURNING *` asserts one row. On zero rows a second read (same `id`/`shopId` predicate) classifies: absent → `product_not_found`; version differs → `version_conflict{currentVersion}`; archived → `product_archived`. The no-op check (AS-09) needs the current row, so `update` first does `SELECT … WHERE id AND "shopId"` (no lock), compares version (conflict wins over no-op), compares normalised values, and only then issues the conditional `UPDATE`; a concurrent change between the two statements is caught by the `version` predicate.
- **Rationale**: III.6/III.7; exactly one of two simultaneous requests succeeds (AS-11, AS-20) because the loser's `UPDATE` matches zero rows.
- **Alternatives**: `SELECT … FOR UPDATE` then update (rejected: holds a row lock across two round trips, no benefit over the predicate); Sequelize `version: true` (rejected: raises a generic `OptimisticLockError` and bumps on every `save`, including view flushes, which must not bump `version`).

## D-3 Events are full-state, `aggregateVersion = productVersion`, topic `products.events` becomes `latest-per-key`

- **Decision**: five `defineEvent` definitions (`catalog.product_created|updated|archived|restored|deleted`, aggregate type `products`, version 1, `{ carries: 'state' }`). `create(productId, productVersion, payload)` puts the product version in the envelope's `aggregateVersion`; the payload repeats it as `productVersion` (spec contract). `deleted` takes `previous + 1`. `PRODUCTS_AGGREGATE` changes to `retention: 'latest-per-key'`. The `deleted` payload is the tombstone state `{productId, shopId, productVersion}`; on a compacted topic it supersedes the earlier states of the key, which is what compaction needs.
- **Rationale**: S53 follow-up; IX.8 (read models store copies plus version); the registry refuses `latest-per-key` unless every definition of the aggregate carries state, and the legacy `ProductChanged` already does.
- **Alternatives**: keep `full-history` (rejected by the S53 follow-up and by replay needs of S32); `delta` events for stock (rejected: compaction would drop the earlier deltas).

## D-4 The legacy `catalog.product_changed` event and its writers

- **Decision**: keep `ProductChanged`, `productChanged` and the `PRODUCTS_AGGREGATE` export (transitional). Our consumers handle both: the new `product_*` events by version, the legacy event as an unconditional `invalidate` (no minimum recorded). The invalidator runs with `coalesce: false` and coalesces itself per `productVersion` over the new events only, because the framework's `coalesceLatest` keeps the highest `aggregateVersion` and the legacy event stamps `Date.now()` (≈ 1.7·10¹²), which would shadow every real version in the batch.
- **Rationale**: four domains (catalog-sync ×3, developer-platform, community consumer) still import the legacy names and write `Product` with raw SQL; their capabilities are not built yet and spec rule 1 forbids editing their specs. Their raw writes do not bump `version`; the unconditional invalidation keeps the page correct for them.
- **Alternatives**: delete the legacy event now (breaks four domains); make the legacy `aggregateVersion` small (cannot: sibling code).

## D-5 Events through `OutboxService` directly, not behind a domain port

- **Decision**: `application/` services inject `OutboxService` (an infrastructure service) like `tenancy` does. The constitution's D-6 ports (`ProductRepository`, `StockOperationRepository`, `ShopStateRepository`, `ViewBatchRepository`) cover the catalog's own tables; `ProductEventPublisher` from `gaps.md` section B is not created because `OutboxService.append` joining the CLS transaction is already the port.
- **Rationale**: S03's shape; one more indirection adds no seam. The `application → infra` import rule concerns `libs/domains/catalog/infra`, not `libs/infrastructure`.
- **Alternatives**: a `ProductEventPublisher` token (rejected: nothing else would implement it).

## D-6 Visibility is one SQL predicate over catalog-owned tables

- **Decision**: public loader: `SELECT p.* FROM "Product" p LEFT JOIN "ProductShopState" s ON s."shopId" = p."shopId" WHERE p.id = :id AND p.status = 'ACTIVE' AND p."isSandbox" = false AND COALESCE(s.status,'ACTIVE') = 'ACTIVE'`. One statement for one id; the batch loader uses `p.id = ANY(:ids)`. `ProductShopState` is catalog's copy (version-guarded by `shopVersion`), so no read of `Shop`.
- **Rationale**: FR-013; IX.4 (both tables are owned); keeps AS-27 ("one statement") true.
- **Alternatives**: ask `ShopQueryService` on every cold read (rejected: network/DB call to another domain on the hot path, and AS-27 counts statements); copy the shop status into each product row (rejected: a suspension of 50,000 products would be 50,000 updates, AS-76).

## D-7 Cache entry, key and lifetimes

- **Decision**: key `cacheKey('product', 2, id)` = `product:v2:<id>` (the old `product:v1:` entries have another shape and die by TTL). Loader result is the public view; `versionOf: v => v.version`; options `{ ttlMs: 60_000, swrMs: 300_000, negativeTtlMs: 10_000, jitter: 0.1, l1: 'hot', timeoutMs: 250 }`. "Not found" and "invisible" are both `null` (negative entry). Writers call `invalidateIfOlder(key, newVersion)` after commit (deletes the positive or negative entry, raises the minimum, broadcasts the L1 drop) and ignore a failure after logging it; the event consumer calls the same method (duplicate/out-of-order safe). Deleting a product uses plain `invalidate` (AS-47).
- **Rationale**: S52 follow-up; FR-015, FR-023, FR-025; the minimum also protects the writer/slow-reader race (AS-43) before the event arrives.
- **Alternatives**: plain `invalidate` in the writer (leaves the race window open until the event); storing the fresh value on write (rejected by AS-27: "writes delete, they never write").

## D-8 View counter: claim/commit with a marker row per chunk

- **Decision**: counter name `product-views` (pending hash `counter:{product-views}:pending`, S52 note b). The flush does `claim()` → `{batchId, deltas}`; splits ids into chunks of 1,000 (stable order); per chunk one transaction inserts a `ProductViewBatch(batchId, chunk)` marker `ON CONFLICT DO NOTHING RETURNING` and, only if the marker was new, runs `UPDATE "Product" p SET "viewCount" = p."viewCount" + d.delta FROM unnest(:ids::uuid[], :deltas::bigint[]) d(id, delta) WHERE p.id = d.id` (parameters bound as arrays, never string-built). Ids that are not UUIDs are dropped and counted before the statement (a poison member never fails the flush, AS-70 and A14). On a failed chunk: `restore(unappliedDeltas)` then `commit(batchId)` and rethrow; on success `commit(batchId)`. The job starts with `reclaimExpired()`. Markers older than 7 days are purged by the daily purge job.
- **Rationale**: S52 follow-up; AS-67–AS-71. The marker makes a retry of the same `batchId` harmless.
- **Known limit (documented, FR-037)**: a worker crash between the database commit and `commit(batchId)` lets `reclaimExpired` merge the batch back under a new claim, and its views are counted twice once. Counts are approximate by design and never money.
- **Alternatives**: keep `drain/restore` (rejected by the S52 follow-up: a crash after `drain` loses the counts); an `viewCount` column update with `GREATEST` (does not fix double application).

## D-9 Timeouts and the 2 s database deadline

- **Decision**: store calls use the toolkit's 250 ms guard. The cold-path loader runs its statement under a 2 s deadline (`Promise.race` with the clock-free `AbortSignal.timeout(2000)` around the repository call, plus the pool-wide `statement_timeout` as the database-side backstop); a deadline or connection error surfaces as the S54 `503` problem (generic detail, `requestId`). A warm or stale entry is served by the toolkit when the loader fails (`staleIfErrorMs: 300_000`).
- **Rationale**: FR-020, AS-35, AS-84 (cold read answers `503` within 3 s while the table is locked).
- **Alternatives**: a per-request transaction with `SET LOCAL statement_timeout` (rejected: two extra statements per cold read break AS-27's statement count).

## D-10 Rate limiting

- **Decision**: three policies declared in `rate-limit-policies.ts` next to the transitional `search.query` (still used by five other domains; the catalog's own routes stop using it, S32 takes the declaration over): `catalog.product-read.ip` (slidingWindow 600/60 s, key `ip`, `failMode: 'open'`), `catalog.product-write.shop` (slidingWindow 120/60 s, key `shop`, `failMode: 'closed'`), `catalog.batch-read.ip` (slidingWindow 120/60 s, key `ip`, open). The `shop` key source reads `:shopId` from the route; the write policy sits behind `ShopScoped` so only an authorised member consumes the shop's budget.
- **Rationale**: FR-011, FR-018, FR-022; the engine's `Retry-After` handling already produces the `429` problem.
- **Alternatives**: token bucket (rejected: AS-22 is a count per minute).

## D-11 Shop facts: summary at create, copy for reads

- **Decision**: `create` reads `ShopQueryService.getShopsByIds([shopId])` before the transaction for `isSandbox`; the status gate (`403 shop_suspended`, `409 shop_offboarding`) comes from `ShopScoped` for HTTP and from the same summary for the R1 commands (`ShopNotActiveError`). The read path uses `ProductShopState`, fed by `tenancy.shop_status_changed` (`versionGuard` on `shopVersion`: `UPSERT … WHERE excluded."shopVersion" > "ProductShopState"."shopVersion"`). A shop with no row is `ACTIVE`.
- **Rationale**: FR-013, FR-038, FR-041; hot path needs no cross-domain call.
- **Alternatives**: none that keep the public read at one statement.

## D-12 Bounded sweeps and purge as self-re-enqueuing jobs

- **Decision**: the status consumer upserts the copy in a short transaction, then enqueues `products.drop-shop-entries {shopId, shopVersion, afterId?}` (idempotency key `drop:<shopId>:<shopVersion>`); the job reads ≤ 1,000 ids by keyset (`id > :afterId ORDER BY id`), calls `invalidate`, then re-enqueues itself with the last id until the page is short. The deleted consumer marks the copy `DELETED` and enqueues `products.purge-shop {shopId}` (key `purge:<shopId>`): per run ≤ 500 rows in one transaction (delete history, operations, products; append `catalog.product_deleted` per product with `previous + 1`), then entries, then re-enqueue until empty; the last run deletes the copy row. Re-delivery re-enqueues with the same key (no-op).
- **Rationale**: FR-038/039, AS-76/77; the cursor lives in the payload, so a crash resumes from the last committed page. Entries for products already deleted are dropped unconditionally (AS-47).
- **Note**: these two job types are internal; the spec's three listed jobs stay as listed. `products.backfill-shop-ids` re-enqueues itself the same way.

## D-13 Shop-id backfill, orphans and the contract step

- **Decision**: `products.backfill-shop-ids` (`fleetConcurrency: 1`): each run takes ≤ 200 distinct `sellerId`s with `shopId IS NULL`, calls `ensureShopsForLegacySellers`, then per seller updates `"shopId"` for ≤ 500 rows in a transaction (`WHERE "shopId" IS NULL AND "sellerId" = :s`), sets `createdBy = sellerId`, `version = version + 1` and appends `catalog.product_updated` (`changedFields: ["shopId"]`). Products with neither `shopId` nor `sellerId` (orphans) are counted in `catalog_backfill_orphans` and logged; they are never deleted, and the `NOT NULL` migration refuses to run while any exists (operator decision, `quickstart.md`). When no legacy row is left the job enqueues nothing; the contract migration (`CHECK … NOT VALID` → `VALIDATE` → `SET NOT NULL` → drop the check) is run by the deploy step.
- **Rationale**: S03 follow-up, FR-040, AS-79/80. S03's own `tenancy.backfill-shops` job still exists and also fills `ChatChannel`; both are idempotent (`WHERE "shopId" IS NULL`), and its `Product_shopId_not_null` CHECK is dropped by our contract migration (it is subsumed by `NOT NULL`; the job's `exists` guard re-adds a harmless valid check if it runs again).
- **Alternatives**: auto-archive orphans (rejected: silent data loss of unknown rows).

## D-14 Legacy writers keep working during the transition

- **Decision**: `price` stays as a column until its readers switch (contract migration deferred, in the follow-ups); a `BEFORE INSERT OR UPDATE` trigger on `Product` keeps `price` and `priceMinor` equal whichever one a writer set (removed together with `price`). `status` defaults `'ACTIVE'`, `isSandbox` `false`, `currency` the platform currency, `version` default 1; `sellerId` stays physically (nullable, no foreign key), `createdBy` is filled for new rows by the catalog and copied from `sellerId` by the migration. The `quantity` check is `NOT VALID` at expand (negative legacy rows are clamped to 0 by the backfill batch first) and validated in the contract step. `embedding` and `searchVector` columns are left in place and unmapped (S32 decides).
- **Rationale**: eighteen files of sibling code `INSERT`/`UPDATE` `Product` with `price`; without the trigger the expand step would break them (III.11).
- **Alternatives**: rename in one step (forbidden, III.11).

## D-15 Removing search from the domain

- **Decision**: delete `GET /products/search`, `GET /shops/:shopId/products/search`, the `SearchQueryLogger` import, `ElasticsearchService` injection and `ProductSearchProjector`. The search projector's index code and the search tests are S32's; until S32 exists the index is not fed by new events: recorded in the sibling follow-ups for **S32** (`catalog.product_*` snapshots; reindex by replay of `products.events`). `ProductService.search` is removed from the compat facade; `assistant-tools.ts` (the one caller) switches to `ElasticsearchService.searchProducts` in a one-line change (WP-12).
- **Rationale**: D-15, D-16, AS-87.
- **Alternatives**: keep the projector in `apps/projector` until S32 (rejected: it reads `"Shop"` with SQL, finding 2 of 3, and imports `ElasticsearchService`).

## D-16 What the toolkits already give and what the plan relies on

Verified in code: `CacheService.getOrLoad` / `getOrLoadMany` / `invalidate` / `invalidateIfOlder` (version, minimum retention, L1 broadcast), `WriteBehindCounter.claim/commit/release/restore/reclaimExpired`, `VersionEtagInterceptor` (needs `id` + `version`; `304`; never overwrites a handler's `Cache-Control`), `JobHandler` options `leaseMs/concurrency/fleetConcurrency`, `declareJobType` (the flush job already declares its contract), `JobsService.enqueue` with `idempotencyKey`, `Projector` with `idempotency`, `handles`, `aggregateIdSchema`, `coalesce`, `TopicRegistry` policy check, `OutboxService.append` joining the CLS transaction, `ShopQueryService.getShopsByIds`, `ShopProvisioningService.ensureShopsForLegacySellers` (≤ 200), `ShopScoped(permission)`. Nothing in S52, S53, S49 or S50 has to change for this capability; the "additions asked for" of the spec's Requires section already exist.

## Baseline 2026-10-10

- `check:table-ownership`: 85 cross-domain accesses in 21 domains; `catalog` 3 findings (`UserModel` association in `product.model.ts`, `Shop` SQL in `product-search.projector.ts`, `ShopMembership` SQL in `drafts.service.ts`).
- `check:boundaries`: 0 errors, 61 warnings. `npx tsc --noEmit -p tsconfig.json`: clean.
- Direct `sequelize.transaction` / `S54 T037 audit` sites in `libs/domains/catalog`: 0 (one `dbUtilsService.wrapInTransaction` in `application/product.service.ts`).
- `JobsService.cancel` / `.cancel(` callers in `libs/domains/catalog`: none.
