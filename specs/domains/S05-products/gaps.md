# Gaps: S05 — current `catalog` product code versus the spec

The implementation agent's to-do list. Paths are under `packages/backend/` unless stated; line numbers are those read on 2026-10-05. **Check not run:** `pnpm check:table-ownership` needs approval an unattended session cannot get, so section C is reconstructed from searches over `libs/` (every use of `"Product"`, `ProductModel`, `ProductDtoService`, `ProductDtoModule` and `@app/domains/catalog`). Run the real check first and reconcile. Collaborative drafts (`collab.module.ts`, `drafts.*`, `room*`, `hash-ring`) are S06 and are not listed except where they write the product table.

## A. Code versus spec

| # | Gap | Where | Spec |
|---|---|---|---|
| A1 | Only create and read exist: no update, archive, restore, list, no OCC, no status, no history. `ProductDtoService.update` overwrites without a version check and nothing calls it | `libs/domains/catalog/api/product.controller.ts` (whole file); `infra/product-dto.service.ts` `update` | FR-006–FR-009, AS-07–AS-21 |
| A2 | Shop-less `POST /products` lets any signed-in user create a product with `sellerId` and no shop | `api/product.controller.ts:67-71` | FR-001, FR-004, AS-06 |
| A3 | Create route is `POST /products/shops/:shopId`, guarded by `ShopScoped('products.write')`, returns the ORM model cast to a DTO (`embedding`, `searchVector`, `sellerId` leak) | `api/product.controller.ts:62-65`; `application/product.service.ts:109` | FR-010, AS-01 |
| A4 | `CreateProductDto`: no length limits (title, description, brand, category), `price` accepts `0` with no maximum, `quantity` has no maximum, `rating` is seller-writable, no currency, no tag length rule, no tag normalisation | `api/product.dto.ts:18-58` | FR-002, FR-003, AS-02, AS-03 |
| A5 | `findById` caches `sellerId` and exact `quantity` in the public view; it counts a view before knowing the product is visible to the public (no archived, sandbox or shop-status rule) | `application/product.service.ts:44-62`; `infra/product-cache.ts` | FR-010, FR-013, AS-23, AS-25 |
| A6 | Detail route is rate limited with the search policy `search.query`; no `Cache-Control`; no `404` caching header | `api/product.controller.ts:44-47` | FR-018, FR-021, AS-32 |
| A7 | Controller injects discovery's `SearchQueryLogger` and serves search; `ProductService` injects `ElasticsearchService` and exposes `search` | `api/product.controller.ts:3,20,30-41`; `application/product.service.ts:2,60-77` | FR-043, AS-87 (D-15, D-16) |
| A8 | `application/` imports `infra/` classes and ORM models directly (`ProductDtoService`, `Product`, `productCacheKey`) instead of domain ports | `application/product.service.ts:4,8,12` | I.2 (D-6) |
| A9 | Events are `{productId}` notifications written with `outboxService.notify`; no type, no version snapshot, no `isSandbox`; four other writers publish the same topic with raw SQL | `application/product.service.ts:101-107`; `application/drafts.service.ts:133`; and rows in section C | FR-042, AS-82 |
| A10 | Cache invalidation is an unconditional `DEL` per aggregate ID; no version, no minimum, no payload validation, no lag metric; a slow reader can store an old value (`CacheService.refresh` has no version guard) | `infra/product-cache-invalidator.projector.ts:21-23`; `libs/infrastructure/cache/cache.service.ts:109-114,136-149` | FR-024–FR-028, AS-40–AS-47 (S52 additions) |
| A11 | Writer path does not delete the product's cache entry after commit (only the event does, so a seller reads stale data right after saving) | `application/product.service.ts:80-111` | FR-023, AS-39 |
| A12 | Cache calls have no timeout (`redis.client.get`, lock `set`, `del`, `publish`); `invalidate` uses `DEL` not `UNLINK` | `libs/infrastructure/cache/cache.service.ts:87,119,111` | FR-020, AS-34, AS-37 (S52) |
| A13 | Entry value is the DTO with no version of its own for the guard; entry size not bounded because fields are unbounded | `infra/product-cache.ts`; `api/product.dto.ts` | FR-015, FR-025, AS-37 |
| A14 | View flush is one statement of any size; ids and deltas are built as `{a,b,c}` array literals from the drained hash; a poison member (non-UUID) fails the whole flush forever and is restored each time | `infra/product-views.jobs.ts:43-60` | FR-036, AS-69, AS-70 |
| A15 | Batch read controller runs raw SQL (`@InjectConnection`) in `api/`, is `skipThrottle`, no id cap check in the controller, returns archived and sandbox products, bypasses the cache | `api/product-batch-read.controller.ts:14-29` | FR-022, AS-38 (D-4 is resolved only by moving the file) |
| A16 | `Product` model: `BelongsTo(User)` and a foreign key on `sellerId` (identity's table), `shopId` nullable with a foreign key from the tenancy migration, `version` default 0, `price` named in cents without currency, `embedding` column on the product, no `status`, no `isSandbox`, no `createdBy`, no `externalSku` in the model (catalog-sync's SQL already writes that column), no check constraint on `quantity` | `infra/models/product.model.ts:14,74-83,99-121`; `migrations/20261001140000-shops-tenancy-expand.js:73` | FR-001, FR-031, FR-040, AS-58, AS-80 (IX.4) |
| A17 | Search projector lives in catalog, reads the `Product` table and the tenancy `Shop` table with raw SQL to drop sandbox products | `infra/product-search.projector.ts:3,36-46` | AS-81, AS-86 (moves to S32; reads `isSandbox` from the event) |
| A18 | No stock command exists: `applyStockDelta` is named in the domain map but not implemented; every caller updates `quantity` itself, with no idempotency | section C rows for orders, payments, auctions, catalog-sync, developer-platform | FR-030, AS-51–AS-57 |
| A19 | No `getProductsByIds`, `upsertFromExternal`, command service; consumers import `ProductModel`, `ProductDtoService`, `ProductService` | `index.ts:7-17` | FR-029, FR-032, FR-033, AS-48, AS-60–AS-64 |
| A20 | Barrel exports `ProductModel`, `ProductDtoModule`, `ProductDtoService`, `ProductCacheInvalidator`, `ProductSearchProjector`, `ProductService` | `index.ts:7-17` | FR-043, AS-86 (D-7, D-8) |
| A21 | No shop-status copy, no consumer of `tenancy.shop_status_changed` or `tenancy.shop_deleted`, no purge | whole domain | FR-038, FR-039, AS-76–AS-78 |
| A22 | Shop-id backfill runs in tenancy with SQL on `Product` (and `ALTER TABLE "Product"`); catalog has none | `libs/domains/tenancy/infra/tenancy-backfill.jobs.ts:33,52,79,83` | FR-040, AS-79, AS-80 |
| A23 | `drafts.service.ts` reads and updates `"Product"` with raw SQL and writes its own outbox row; it must go through the update path | `application/drafts.service.ts:44,128-133` | S06; spec Provides (`ProductCommandService.update`) |
| A24 | No metrics named in AS-85; no problem+json `code`s for product errors (`NotFoundError` only) | `api/product.controller.ts:49` | AS-85 |
| A25 | Existing e2e covers only get-by-id, 404 and search (4 tests); no write, cache, invalidation, view, concurrency or IDOR test; it mixes search with products | `product.e2e-spec.ts` | test-plan.md |
| A26 | Product create and `ProductDtoService.create` run through `dbUtilsService.wrapInTransaction` and `outboxService.notify` correctly; keep the one-transaction shape (product + outbox) in the new services | `application/product.service.ts:80-111` | FR-042, AS-83 |

## B. Open debt-register rows naming `catalog` or S05

| Row | Status | What S05 must do | Mechanism |
|---|---|---|---|
| D-6 (I.2) | open | `application/product.service.ts` imports `infra/` classes; introduce repository ports and tokens in `domain/`, adapters in `infra/`; same for the new services | `domain/` ports (`ProductRepository`, `StockOperationRepository`, `ProductEventPublisher`, `ShopListingRepository`) |
| D-7 (IX.4) | open | stop exporting `ProductModel`; remove the `User` association; consumers move to R1 (section C) | R1 `getProductsByIds`, `ProductCommandService`; R3 snapshot events; then drop the export |
| D-8 (X.4) | open | barrel exports `ProductCacheInvalidator`, `ProductSearchProjector`, `ProductDtoService`; export `ProductProjectorModule` and `ProductWorkerModule` instead; the search projector leaves | apps import the domain's projector/worker module |
| D-12 (IX.4) | open | catalog's own raw SQL is on tables it owns (allowed) except `product-search.projector.ts:40` (`"Shop"`), moved to S32; every other domain's SQL on `Product` is section C | R1 / R3 as listed per row |
| D-15 (X.5) | open | remove `SearchQueryLogger` and every `@app/domains/discovery` import; search routes move to S32 | S32 hosts search and logs queries (events or its own controller) |
| D-16 (X.3, X.7) | open | the catalog stops injecting `ElasticsearchService`; the product index adapter belongs to discovery | S32 consumes `catalog.product_*` events |
| D-4 | resolved (Phase 3) | the moved `ProductBatchReadModule` still has SQL in a controller (A15) | R2 target served by an application service; BFF composes it (S48) |
| D-1 | resolved | no action | — |

## C. `pnpm check:table-ownership` lines for this domain (reconstructed)

**Lines inside `catalog`** (its own SQL touches its own tables unless noted): `infra/product-search.projector.ts:40` reads `"Shop"` (tenancy) → moves to S32 (AS-86); `infra/models/product.model.ts` association to `identity`'s `User` → removed by the foreign-key migration (A16); `application/drafts.service.ts:68` reads `"ShopMembership"` (tenancy) → S06 uses `ShopAccessService.assertMember` (R1; listed in S03's gaps).

**Other domains using `Product`** (each must stop, then the model export is dropped). The replacement is the IX.7 mechanism in the last column.

| Domain (capability) | Where | Use | Replacement |
|---|---|---|---|
| orders (S10) | `application/checkout.service.ts:8,149`; `infra/order.jobs.ts:50,106`; `application/order.service.ts:97`; `infra/models/bis-order-item.model.ts:14` (association); `orders.module.ts:8`; `api/orders.controller.ts:9`; `checkout.e2e-spec.ts:16` | read price and stock, decrement and restore stock, `BelongsTo(Product)` | R1 `getProductsByIds` for price and stock; R1 `applyStockDelta` (operation ID per checkout step, compensation = opposite delta); drop the association (order items keep a title and price snapshot); fixtures use the test helpers |
| orders (S12) | `application/order-export.service.ts:69` | `LEFT JOIN "Product"` for titles | R1 `getProductsByIds` per page of items (batch, no N+1) |
| payments (S13) | `application/payment.service.ts:135,190`; `payment.e2e-spec.ts:16` | stock check and decrement | R1 `getProductsByIds`, `applyStockDelta` |
| auctions (S21) | `application/auction.service.ts:55`; `infra/auction.jobs.ts:70,99` | take and return one unit | R1 `applyStockDelta` (`reason: "auction"`) |
| catalog-sync (S07, S08, S09) | `application/catalog-import.service.ts:192`; `application/integration-sync.service.ts:126,131,154,186`; `application/sync.service.ts:84,101`; `catalog-import.e2e-spec.ts:79,96`; `integrations.e2e-spec.ts:55,92`; `sync.e2e-spec.ts:9` | insert, update, decrement, join `ExternalLink` | R1 `upsertFromExternal`, `applyStockDelta`; links and cursors stay in catalog-sync (it resolves `externalSku` → product through the result of `upsertFromExternal`); they stop publishing `products.events` |
| developer-platform (S42) | `application/public-catalog.service.ts:5,96,114,133,139,180,186` | list, read, update, bulk stock, publish events, `JOIN "Shop"` | R1 `ProductCommandService` (`listByShop`, `getForShop`, `update`), `applyStockDelta`; shop fields through tenancy R1 `getShopsByIds`; no event writes |
| developer-platform (S43) | `infra/webhook-router.projector.ts:116` | `SELECT … FROM "Product"` per event | R3: the snapshot in `catalog.product_*` (title, quantity, price, `shopId`) |
| developer-platform (S44) | `application/widget.service.ts:98` | products of a shop by IDs | R1 `getProductsByIds(ids, {shopId})` |
| developer-platform | `public-api.module.ts:2`, `public-api-worker.module.ts:2` | import `ProductModule` | keep (exported module, R1) once it exports only the services above |
| discovery (S32) | `search-reindex.service.ts:4`; `search-reindex-worker.module.ts:3`; `search-admin.module.ts:12`; `application/shop-product-search.service.ts:26,32,47` | reindex, shop search over `"Product"` (full text, `searchVector`) | R3: its own index or table fed by the snapshot events; reindex by replaying `products.events` (S32 decides if a republish command is needed) |
| discovery (S34, S35) | `recommendations.module.ts:3`; `application/recommendations.service.ts:4`; `application/trending.service.ts:37` | titles and prices for rails | R1 `getProductsByIds` (one batch per rail) |
| seller-insights (S40) | `infra/shop-sales.projector.ts:4`; `infra/leaderboard.projector.ts:4`; `leaderboards.e2e-spec.ts:10` | product → shop mapping | R3: `shopId` in order events and the product snapshot; no `Product` model |
| seller-insights (S41) | `application/crawler.service.ts:70,155` | ownership check and `JOIN "Product"` with `ShopMembership` | R1 `getProductsByIds(ids, {shopId})`; owner lookup through tenancy `MembershipQueryService` |
| media (S29) | `application/media.service.ts:79` | product-in-shop check joined with `"Media"` | R1 `getProductsByIds([id], {shopId})`, then query only `"Media"` |
| asset-library (S31) | `application/assets.service.ts:239` | product-in-shop check joined with `"Asset"` | R1 `getProductsByIds([id], {shopId})` |
| marketing (S36) | `application/ads.service.ts:43,53` | campaign insert-select and joins `"Product"` | R1 `getProductsByIds` for category and title; copy into the campaign row |
| assistant (S46, S47) | `application/knowledge.service.ts:246`; `api/knowledge.controller.ts:81`; `application/assistant-tools.ts:4`; `assistant.module.ts:8` | shop of a product; tool calls through `ProductService` | R1 `getProductsByIds`; search through S32's service |
| community (S26) | `infra/product-feed.projector.ts:4` | product rows for feed items | R3: snapshot events |
| fulfilment (S19) | `infra/pickup-availability.projector.ts:4`; `pickup.e2e-spec.ts:12` | stock and product fields for availability | R3: snapshot events (`quantity`, `inStock`, `status`) |
| chat (S24) | `infra/models/chat-channel.model.ts:14` (association); `application/chat.service.ts:10,55`; `chat.module.ts:5,16`; `chat.e2e-spec.ts:11` | channel for a product, shop and seller lookups | R1 `getProductsByIds`; drop the association and the `ProductDtoModule` import |
| statements (S16) | `application/statement.service.ts:47`; `infra/statement-export.ts:40` | `JOIN "Product"` in reports | R3: ClickHouse via CDC (S16), no catalog table access |
| tenancy (S03) | `infra/tenancy-backfill.jobs.ts:33,52,79,83`; `tenancy.e2e-spec.ts:12` | shop-id backfill and constraint | moves to catalog (A22, AS-79, AS-80); the e2e import is removed |
| infrastructure/cache | `cache.e2e-spec.ts:11` (imports `ProductModule`) | test-only (X.3, D-1 harness) | test uses a neutral fixture module |

## D. Work list (suggested order)

1. Migrations (expand/contract, `lock_timeout`, one step each, run as a separate deploy step): add `status`, `createdBy`, `isSandbox`, `currency`, `priceMinor` (copy of `price`), shop-status copy table, status history table, stock-operation table (unique `operationId`), check constraint on `quantity`, unique `(shopId, externalSku)`; register every new table in `db/ownership.ts` in the same PR; later: drop `sellerId` and `shopId` foreign keys, `NOT NULL` on `shopId` after the backfill, drop `price` after readers switch.
2. Domain layer: status machine, stock rule, input normalisation, ports (D-6), unit specs (AS-21, AS-59, tag table of AS-01).
3. Application services and repositories: `ProductCommandService`, `ProductQueryService`, `ProductStockService`, `ProductImportService`; one transaction per change with the outbox row; delete-on-write after commit (AS-39).
4. HTTP: new routes, DTOs, `packages/contracts` schemas, rate-limit policies, remove the routes of AS-06 and AS-87, rewrite `product-batch-read.controller.ts` onto an application service (A15).
5. S52 additions (versioned entries, minimum version, timeouts, `UNLINK`) with S52's owner; then the invalidation consumer (AS-40–AS-47) and the view flush chunking (AS-69).
6. Shop-event consumers, purge, backfill job (AS-76–AS-80).
7. Hand the replacement table of section C to each owning capability (their `gaps.md` repeat the rows); when a consumer is converted, delete its `ProductModel` import; when the last is gone, drop the model export and run `check:table-ownership --strict`.
8. Move `product-search.projector.ts`, the search routes, `SearchQueryLogger` use and the search tests to S32; replace `product.e2e-spec.ts` by the files of the test plan; update `packages/web` (`lib/api/shops.ts` `useCreateProduct` and `useShopProducts`, `lib/api/catalog.ts` `ProductDetail`, the inventory view) for the new routes and fields.
