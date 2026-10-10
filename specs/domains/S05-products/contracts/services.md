# Service contract (R1): S05 — Products

Exported from `@app/domains/catalog`. Every method returns DTOs, never a model. Signatures are those of the spec's Provides section; this file adds the error classes, limits and module wiring.

## Exports

| Export | Kind | Consumers |
|---|---|---|
| `ProductModule` | Nest module (core + any app hosting the R1 services) | S06, S42, S10, S13, … |
| `ProductBatchReadModule` | core | S48 route |
| `ProductWorkerModule` | worker | jobs |
| `ProductProjectorModule` | projector | consumers (new) |
| `ProductQueryService`, `ProductStockService`, `ProductImportService`, `ProductCommandService` | providers | see spec |
| types `ProductDto`, `ProductMemberView`, `StockOperation`, `ApplyStockResult`, `ExternalProductInput`, `ExternalUpsertResult`, `ProductId`, `ShopId` | types | consumers |
| error classes `ProductNotFoundError`, `VersionConflictError`, `InvalidTransitionError`, `ProductArchivedError`, `ShopNotActiveError`, `StockOperationConflictError` | classes | consumers |
| events `ProductCreated`, `ProductUpdated`, `ProductArchived`, `ProductRestored`, `ProductDeleted` (definitions) | event contracts | S32, S19, S25/S26, S43, S40 |
| `catalogRatePolicies` | policy table | rate-limit tests, global modules |

**Transitional block** (marked in `index.ts`, pinned by `product-boundary.e2e-spec.ts`; each line goes when its last importer is converted): `ProductModel`, `ProductDtoModule`, `ProductDtoService`, `ProductService` (compat facade: `findById`, `create`), `ProductChanged`, `productChanged`, `PRODUCTS_AGGREGATE`, `CollabModule`, `DraftsModule`.
`ProductDtoModule`/`ProductDtoService` stay as a thin adapter over the new repository until chat (S24) converts (`requestProduct`); they do not hold SQL of their own.

**Removed from the entry point**: `ProductCacheInvalidator`, `ProductSearchProjector` (apps import `ProductProjectorModule` instead; D-8).

## `ProductQueryService`

`getProductsByIds(ids: ProductId[], options?: { shopId?: ShopId }): Promise<Map<ProductId, ProductDto>>`. Database only, one statement (`WHERE id = ANY(:ids) [AND "shopId" = :shopId]`), duplicates collapse, unknown absent, `[]` → empty map with no statement, > 500 or a non-UUID → `ValidationError`.

## `ProductStockService`

`applyStockDelta(ops: StockOperation[]): Promise<ApplyStockResult>`. Limits: 1–100 operations; distinct `operationId` (1–128); `delta` non-zero integer, ±1,000,000; `reason` `[a-z0-9._-]{1,64}`; result `quantity ≤ 1,000,000,000`.

Algorithm per call (one transaction, items sorted by `productId` to keep lock order stable):

1. For each item: `INSERT INTO "ProductStockOperation" … ON CONFLICT ("operationId") DO NOTHING RETURNING` (no row → replay path: read the stored row; same `productId`/`shopId`/`delta` → `replayed: true` with the stored `quantityAfter`/`productVersion`; different → throw `StockOperationConflictError` and roll back).
2. New operation: `UPDATE "Product" SET quantity = quantity + :d, version = version + 1, "updatedAt" = :now WHERE id = :id AND "shopId" = :shopId AND quantity + :d BETWEEN 0 AND 1000000000 [AND status = 'ACTIVE' when :d < 0] RETURNING quantity, version, …`. Zero rows → classify with one read: absent/other shop → `not_found`; archived and `:d < 0` → `unavailable`; over limit → `quantity_limit`; else `insufficient_stock`.
3. Any failure → roll back the whole call (operation rows included) and return `{outcome:'rejected', failures}`; success → update the operation row's `quantityAfter`/`productVersion`, append one `catalog.product_updated` per product (`changedFields: ["quantity"]`).
4. After commit: `invalidateIfOlder` per product (bounded concurrency 20); failures logged, never thrown.

## `ProductImportService`

`upsertFromExternal(shopId, items, source)`: 1–500 items; `ShopNotActiveError` before any write (summary read before the transaction). Items validated one by one with the create rules plus `externalSku` 1–128; invalid → `outcome: 'rejected', errors`. Valid items in one transaction: `INSERT … ON CONFLICT ("shopId","externalSku") WHERE "externalSku" IS NOT NULL DO UPDATE … WHERE (changed columns differ)` with `RETURNING (xmax = 0) AS inserted`; unchanged rows return no row and are reported `unchanged` (no version bump, no event). Archived products keep their status; `quantity` is touched only when the item carries it.

## `ProductCommandService`

`create(shopId, actorId, input)`, `update(shopId, productId, input & {expectedVersion})`, `archive(shopId, productId, expectedVersion, actorId)`, `restore(...)`, `listByShop(shopId, query)`, `getForShop(shopId, productId)`. Throws `ProductNotFoundError`, `VersionConflictError{currentVersion}`, `InvalidTransitionError`, `ProductArchivedError`, `ShopNotActiveError`, `ValidationError`, `CurrencyNotSupportedError`. `create` reads the shop summary before the transaction (sandbox flag, status). Writer-side cache invalidation happens inside these methods, after commit.

## Metrics (AS-85, `domain/product-metrics.ts`)

`catalog_product_read_total{outcome}`, `catalog_product_invalidation_total{result}`, `catalog_product_invalidation_lag_seconds`, `catalog_view_flush_total{result}`, `catalog_view_flush_pending`, `catalog_stock_operation_total{result}`, plus `catalog_backfill_orphans`, `catalog_shop_sweep_total{kind}`. No id labels.

## Jobs (S49)

| Job type | Schedule / trigger | Options |
|---|---|---|
| `products.flush-view-counts` | every 10 s (`upsertSchedule`, `InvalidScheduleError` caught and logged) | `concurrency: 1, fleetConcurrency: 1, leaseMs: 30_000` |
| `products.purge-stock-operations` | daily | `concurrency: 1, fleetConcurrency: 1`; 5,000 per run, oldest first; also purges `ProductViewBatch` > 7 days |
| `products.backfill-shop-ids` | enqueued at worker boot (`idempotencyKey: 'catalog-backfill'`), self re-enqueue | `fleetConcurrency: 1, leaseMs: 300_000` |
| `products.drop-shop-entries` | by the status consumer | `fleetConcurrency` unset (per shop key) |
| `products.purge-shop` | by the deleted consumer | idempotency key per shop |

Each type has a `declareJobType` contract (zod) next to its `JobPayloads` augmentation.
