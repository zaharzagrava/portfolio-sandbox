---
id: S05
title: Product CRUD, pricing, stock fields, product cache and invalidation, product views
kind: capability
status: draft
generated_at: e95ce81
depends_on: [S03, S50, S52, S53, S49, S54]
concepts: [problem-json-errors, outbox-task-queue, projection-and-replay, job-scheduler-lease, cache-layers, rate-limit-policy, tenant-shop-rbac, transaction-runner, idempotency-key, order-reservation]
models: []
scope:
  - packages/backend/libs/domains/catalog/**
  - packages/web/lib/api/**
---
# S05 - Product CRUD, pricing, stock fields, product cache and invalidation, product views
## Purpose
A shop sells products. Members of a shop ({{concept:tenant-shop-rbac}}, {{cap:S03}}) create, edit, list, archive and restore them. Anyone reads a product page quickly and safely through a layered cache ({{concept:cache-layers}}). Other domains read prices and change stock only through the exported commands of this capability.

## Entry points
- `POST /shops/:shopId/products` creates a product (member with `products.write`). [code: packages/backend/libs/domains/catalog/api/product.controller.ts#ProductController]
- `GET /shops/:shopId/products` lists a shop's products with a keyset cursor (`products.read`).
- `GET /shops/:shopId/products/:productId` returns the member view.
- `PATCH /shops/:shopId/products/:productId` updates a product with `expectedVersion`.
- `POST /shops/:shopId/products/:productId/archive` and `.../restore` move the product between `ACTIVE` and `ARCHIVED`.
- `GET /products/:productId` returns the public view, without credentials. [code: packages/backend/libs/domains/catalog/api/public-product.controller.ts#PublicProductController]
- `GET /batch/products?ids=` returns public items in request order for the BFF. [code: packages/backend/libs/domains/catalog/api/product-batch-read.controller.ts#ProductBatchReadController]
- Exported commands: `ProductCommandService`, `ProductQueryService.getProductsByIds`, `ProductStockService.applyStockDelta`, `ProductImportService.upsertFromExternal`. [code: packages/backend/libs/domains/catalog/application/product-stock.service.ts#ProductStockService]
- Consumers: a cache invalidator of `products.events`, and consumers of `tenancy.shop_status_changed` and `tenancy.shop_deleted`. [code: packages/backend/libs/domains/catalog/infra/product-cache-invalidator.projector.ts#ProductCacheInvalidator]
- Scheduled jobs: `products.flush-view-counts` every 10 s and the purge of stock operations older than 30 days. [code: packages/backend/libs/domains/catalog/infra/product-maintenance.jobs.ts#ProductMaintenanceJobs]

## Rules
- **S05.R-01** A product belongs to one shop for its whole life, starts [`ACTIVE`](../terms/product-lifecycle.md) at [`version: 1`](../terms/product-version.md), and the shop and creator never come from the request body. [proof: S05 AS-01, S05 AS-02]
- **S05.R-02** Create and update bodies MUST be [strict](../terms/strict-body.md): unknown fields, `null` values and out-of-limit text, price or stock are refused. [proof: S05 AS-02, S05 AS-08] [code: packages/backend/libs/domains/catalog/domain/product-input.ts#parseCreateInput]
- **S05.R-03** A price is an integer in [minor units](../terms/minor-units.md). A currency other than the [platform currency](../terms/platform-currency.md) gives [`422 currency_not_supported`](../terms/currency-not-supported.md); an omitted currency means the platform currency. [proof: S05 AS-03]
- **S05.R-04** A request without credentials gets `401`, a [`VIEWER`](../terms/shop-role.md) gets [`403 permission_denied`](../terms/permission-denied.md), and a [non-member](../terms/shop-membership.md) or unknown shop gets [the same `404`](../terms/identical-not-found.md). [proof: S05 AS-04]
- **S05.R-05** A write on a [`SUSPENDED`](../terms/shop-status.md) shop gives [`403 shop_suspended`](../terms/shop-status-gate.md); on a [`DELETING`](../terms/shop-status.md) shop it gives [`409 shop_offboarding`](../terms/shop-status-gate.md). [proof: S05 AS-05]
- **S05.R-06** A product of another shop is [indistinguishable from an unknown product](../terms/identical-not-found.md): [`404 product_not_found`](../terms/product-not-found.md). [proof: S05 AS-12, S05 AS-50]
- **S05.R-07** Update, [archive](../terms/product-archive.md) and restore require [`expectedVersion`](../terms/expected-version.md); a mismatch gives [`409 version_conflict`](../terms/version-conflict.md) with [`currentVersion`](../terms/product-version.md), and of two simultaneous requests [exactly one wins](../terms/optimistic-concurrency.md). [proof: S05 AS-10, S05 AS-11, S05 AS-20]
- **S05.R-08** [An update that equals the stored values](../terms/no-op-update.md) writes no row, no [event](../terms/event-row.md) and leaves the [cache entry](../terms/cache-entry.md) untouched. [proof: S05 AS-09]
- **S05.R-09** The lifecycle is [`ACTIVE ⇄ ARCHIVED`](../terms/product-lifecycle.md) only; any other transition gives [`409 invalid_transition`](../terms/invalid-transition.md), and editing an archived product gives [`409 product_archived`](../terms/product-archived.md). [proof: S05 AS-18, S05 AS-19, S05 AS-21] [code: packages/backend/libs/domains/catalog/domain/product-status.ts#applyTransition]
- **S05.R-10** [The shop list](../terms/get-shops-mine.md) is ordered by `createdAt` then `id`, both descending, with an [opaque cursor](../terms/pagination-cursor.md); the [default status](../terms/shop-status.md) is `ACTIVE`. [proof: S05 AS-14, S05 AS-15]
- **S05.R-11** A shop MUST NOT exceed 120 writes per minute; the 121st gives [`429 rate_limited`](../terms/rate-limited.md) and reads still work ({{concept:[rate-limit-policy](../terms/rate-limit-policy.md)}}). [proof: S05 AS-22]
- **S05.R-12** A product is public only if it is [`ACTIVE`](../terms/product-lifecycle.md), in a [non-sandbox shop](../terms/sandbox-shop.md), and the shop is not [`SUSPENDED`](../terms/shop-status.md), `DELETING` or `DELETED`; otherwise the answer equals the unknown-ID `404`. [proof: S05 AS-25] [code: packages/backend/libs/domains/catalog/domain/visibility.ts#isPubliclyVisible]
- **S05.R-13** A malformed product ID gives [`400 validation_failed`](../terms/validation-failed-error.md) before any cache or database access. [proof: S05 AS-26]
- **S05.R-14** [Cache entries](../terms/cache-entry.md) MUST have a lifetime of [60 s fresh plus 300 s stale](../terms/stale-while-revalidate.md), each within ±10%, and at most 32 KiB. [proof: S05 AS-28, S05 AS-37]
- **S05.R-15** [Concurrent cold reads share one database load ↗](../sw-external-terms.md#single-flight); [stale entries are served while one background refresh runs](../terms/stale-while-revalidate.md). [proof: S05 AS-29, S05 AS-30]
- **S05.R-16** A missing product is [cached negatively](../terms/negative-caching.md) for about 10 s. [proof: S05 AS-31]
- **S05.R-17** A write deletes the product's cache entry [after commit](../terms/after-commit-callback.md) and [never stores a value](../terms/invalidation-only-writes.md). [proof: S05 AS-39]
- **S05.R-18** An [invalidation event](../terms/cache-invalidator.md) deletes the entry only when [its version is higher than the cached one](../terms/invalidate-if-older.md); stale or duplicate events change nothing. [proof: S05 AS-41, S05 AS-42, S05 AS-43]
- **S05.R-19** [`applyStockDelta`](../terms/apply-stock-delta.md) is [all-or-nothing](../terms/all-or-nothing-reservation.md), [idempotent ↗](../sw-external-terms.md#idempotency) by [`operationId`](../terms/stock-operation-id.md), and MUST NOT take stock below 0 or above 1,000,000,000. [proof: S05 AS-52, S05 AS-53, S05 AS-54, S05 AS-58, S05 AS-59] [code: packages/backend/libs/domains/catalog/domain/stock-rule.ts#applyDelta]
- **S05.R-20** Every committed change writes one [versioned product event](../terms/product-version.md) in the [same transaction ↗](../sw-external-terms.md#database-transaction) ([{{concept:outbox-task-queue}}](../terms/outbox-append.md)). [proof: S05 AS-82, S05 AS-83]
- **S05.R-21** The [view flush](../terms/view-count-flush.md) [claims](../terms/write-behind-claim.md) the [pending counts](../terms/write-behind-counter.md), applies them in chunks of at most 1,000 products (one transaction and one [`ProductViewBatch` marker](../terms/product-view-batch-marker.md) per chunk), changes no [`version`](../terms/product-version.md), writes no event and deletes no [cache entry](../terms/cache-entry.md); two concurrent flushes apply each count once. [proof: S05 AS-66, S05 AS-69, S05 AS-71, S05 AS-74] [code: packages/backend/libs/domains/catalog/application/product-views.service.ts#ProductViewsService]
- **S05.R-22** A failed chunk stops the flush: the chunks not yet applied go back to the [pending counts](../terms/write-behind-counter.md), the applied ones stay, and the next flush stores each count exactly once; [members](../terms/pending-count-member.md) that are not [UUIDs ↗](../sw-external-terms.md#uuid) are skipped and counted. [proof: S05 AS-67, S05 AS-69, S05 AS-70]
- **S05.R-23** The catalog keeps the [shop status](../terms/shop-status.md) from [`tenancy.shop_status_changed`](../terms/shop-status-changed-event.md), ignoring an event whose [`shopVersion`](../terms/shop-version.md) is not above the stored one, and drops the shop's [cache entries](../terms/cache-entry.md) in batches of at most 1,000. [proof: S05 AS-76, S05 AS-78] [code: packages/backend/libs/domains/catalog/infra/shop-consumers.ts#ShopStatusConsumer]
- **S05.R-24** On [`tenancy.shop_deleted`](../terms/shop-deleted-event.md) the catalog deletes the shop's products, history and [stock operations](../terms/stock-operation.md) in transactions of at most 500 products, writes one [`catalog.product_deleted`](../terms/catalog-product-deleted-event.md) per product with [`productVersion`](../terms/product-version.md) one above its last, and [can run again after any interruption ↗](../sw-external-terms.md#idempotency). [proof: S05 AS-77] [code: packages/backend/libs/domains/catalog/application/shop-listing.service.ts#ShopListingService]
- **S05.R-25** Products without a shop get the shop of their owner through [`ShopProvisioningService.ensureShopsForLegacySellers`](../terms/ensure-shops-for-legacy-sellers.md) (at most 200 owners per call, at most 200 products per transaction), with one [`catalog.product_updated`](../terms/catalog-product-updated-event.md) per product; `Product.shopId` is `NOT NULL` and `Product` has no [foreign key ↗](../sw-external-terms.md#foreign-key) to `User` or `Shop`, and no table of another domain holds a foreign key that references `Product` (they keep a plain `productId`; cleanup follows the [`catalog.product_*` events](../terms/catalog-product-events.md)). [proof: S05 AS-79, S05 AS-80] [code: packages/backend/libs/domains/catalog/application/product-backfill.service.ts#ProductBackfillService]
- **S05.R-26** A product created in a [sandbox shop](../terms/sandbox-shop.md) is flagged [`isSandbox`](../terms/is-sandbox.md), every event carries the flag, and the product is [never public](../terms/sandbox-product.md). [proof: S05 AS-81]
- **S05.R-27** Where billing is hosted, creating a product MUST ask S18 for the shop's `maxProducts` before the transaction and count the shop's non-archived products under a per-shop lock inside it: at the limit it MUST answer `409 plan_limit_reached {key: "maxProducts", limit}` and write nothing, concurrent creates MUST NOT exceed the limit, an archived product MUST NOT count, and an answer that cannot be had MUST fail the create closed with `503 entitlements_unavailable`. [proof: S05 G-20] [code: packages/backend/libs/domains/catalog/application/product-command.service.ts#ProductCommandService]

## Behaviors
- **S05.B-01** Given a [`STAFF`](../terms/shop-role.md) member of an [active shop](../terms/shop-status.md), when they post a valid product, then the answer is `201` with the [member view](../terms/member-view.md) at [`version: 1`](../terms/product-version.md). [proof: S05 AS-01]
- **S05.B-02** Given a [`PATCH` ↗](../sw-external-terms.md#http-patch) with the current [`expectedVersion`](../terms/expected-version.md), when the values change, then the answer is `200` with `version` plus one. [proof: S05 AS-07]
- **S05.B-03** Given a `PATCH` with a stale version, when it is sent, then [`409 version_conflict`](../terms/version-conflict.md) returns [`currentVersion`](../terms/version-conflict.md) and nothing changes. [proof: S05 AS-10]
- **S05.B-04** Given 45 products, when the client follows [`nextCursor`](../terms/pagination-cursor.md), then pages hold 20, 20 and 5 items without duplicates. [proof: S05 AS-14]
- **S05.B-05** Given an active product, when a [member](../terms/shop-member.md) [archives](../terms/product-archive.md) it, then the status becomes `ARCHIVED` and [restore](../terms/product-archive.md) makes it `ACTIVE` again. [proof: S05 AS-16, S05 AS-17]
- **S05.B-06** Given an [anonymous call](../terms/anonymous-state.md), when the product is visible, then `200` returns the [public view](../terms/member-view.md) with an [`ETag` ↗](../sw-external-terms.md#etag); the same [`If-None-Match` ↗](../sw-external-terms.md#if-none-match) returns `304`. [proof: S05 AS-23, S05 AS-24]
- **S05.B-07** Given an archived or [sandbox product](../terms/sandbox-product.md), when anyone reads it, then `404` with [`Cache-Control: public, s-maxage=5` ↗](../sw-external-terms.md#cache-control). [proof: S05 AS-25]
- **S05.B-08** Given a [cold product read](../terms/cold-request.md) twice, when the second read arrives, then the [cache](../terms/cache-toolkit.md) serves it with no database statement. [proof: S05 AS-27]
- **S05.B-09** Given 100 [concurrent cold reads ↗](../sw-external-terms.md#single-flight), when they run, then the database receives one statement. [proof: S05 AS-29]
- **S05.B-10** Given 700 reads of random IDs from [one address](../terms/client-address.md), when the minute passes, then the first [600 answer `404`](../terms/cache-penetration.md) and the rest [`429`](../terms/rate-limited.md). [proof: S05 AS-32]
- **S05.B-11** Given the [shared cache](../terms/l2-cache.md) is down, when a product is read, then the database answers within 2 s and [the view is not counted](../terms/product-view-count.md). [proof: S05 AS-34]
- **S05.B-12** Given a [warm entry](../terms/stale-if-error.md) and a database that is down, when the product is read, then `200` comes from the cache. [proof: S05 AS-35]
- **S05.B-13** Given [`GET /batch/products?ids=a,b,c`](../terms/batch-products-lookup.md) with `b` [invisible](../terms/search-visibility.md), when called, then the array keeps request order with `null` for `b`. [proof: S05 AS-38]
- **S05.B-14** Given stock 5 and ten [concurrent `-1` operations](../terms/stock-operation.md), when they run, then five apply, five give [`insufficient_stock`](../terms/insufficient-stock.md), and stock is 0. [proof: S05 AS-53]
- **S05.B-15** Given an applied [`operationId`](../terms/stock-operation-id.md), when it is sent again, then the result has [`replayed: true`](../terms/stock-operation-replayed.md) with the original [`quantityAfter`](../terms/quantity-after.md). [proof: S05 AS-54]
- **S05.B-16** Given a new [`externalSku`](../terms/external-sku.md), when [`upsertFromExternal`](../terms/upsert-from-external.md) runs, then a product is created; an identical second call is [idempotent ↗](../sw-external-terms.md#idempotency). [proof: S05 AS-60, S05 AS-61]
- **S05.B-17** Given five reads and a [flush](../terms/view-count-flush.md), when the job runs, then the stored [`viewCount`](../terms/product-view-count.md) is 5 with [`version`](../terms/product-version.md) unchanged. [proof: S05 AS-66]
- **S05.B-18** Given an [operation record](../terms/stock-operation.md) older than 30 days, when the [purge job](../terms/idempotency-purge-job.md) runs, then it is deleted. [proof: S05 AS-65]
- **S05.B-19** Given 2,500 products with [pending views](../terms/product-view-count.md) and a failure in the second [chunk](../terms/bounded-batch.md), when the [flush](../terms/view-count-flush.md) runs, then 1,000 are stored, 1,500 stay pending, and the next flush stores the rest once. [proof: S05 AS-69]
- **S05.B-20** Given a shop with 2,500 products [suspended](../terms/shop-status.md) at [`shopVersion: 5`](../terms/shop-version.md), when the event is consumed, then its products answer [`404`](../terms/search-visibility.md), and [reinstating](../terms/shop-status.md) at `shopVersion: 6` shows them again. [proof: S05 AS-76]
- **S05.B-21** Given [`tenancy.shop_deleted`](../terms/shop-deleted-event.md) for a shop of 1,200 products, when the [purge](../terms/catalog-shop-purge.md) runs, then 1,200 [`catalog.product_deleted`](../terms/catalog-product-deleted-event.md) events exist and the other shops are untouched. [proof: S05 AS-77]
- **S05.B-22** Given 453 products of two [owners](../terms/legacy-seller.md) [without a shop](../terms/legacy-seller.md), when the [backfill](../terms/search-backfill-shop-state.md) runs twice at once, then each product gets its owner's shop once. [proof: S05 AS-79]

## Lifecycles
Statuses: `ACTIVE` and `ARCHIVED`. A shop member with `products.write` moves them with `archive` and `restore`; each move adds a status-history row and increments `version`. The external upsert never revives an archived product.

## Owns
- Tables: `Product`, `ProductShopState`, `ProductStatusHistory`, `ProductStockOperation`, `ProductViewBatch`.
- Events: `catalog.product_created`, `catalog.product_updated`, `catalog.product_archived`, `catalog.product_restored`, `catalog.product_deleted` on topic `products.events`.
- Rate policies: `catalog.product-write.shop` (120/min), `catalog.product-read.ip` (600/min), `catalog.batch-read.ip` (120/min).
- Jobs: `products.flush-view-counts` (every 10 s, one run in the fleet), `products.purge-stock-operations`, `products.drop-shop-entries`, `products.purge-shop`, `products.backfill-shop-ids`.

## Decisions
- Money is an integer in minor units with one platform currency, never a float.
- Controllers and other domains share `ProductCommandService`, so one path enforces every rule.
- The cache is never the source of truth; price and stock for other domains come from the database.
- Writes delete cache entries and never write them; an event consumer repairs lost deletes.
- View counts are approximate and counted in the shared cache, so reads never wait on the database.
- Entries carry the product version so late events and slow readers cannot restore old data.

## Known gaps
- `Product.embedding` and `Product.searchVector` still exist: `libs/domains/discovery/application/shop-product-search.service.ts` reads `searchVector`, so the drop waits for S32.
- R-16 negative caching and R-11 rate-limit fail-closed on limiter outage have no `[proof]` for the outage case.
- A failed flush whose restore also fails leaves the claim for the cache toolkit's reclaim after the claim age; a chunk applied before that failure can then be counted twice (analytics-grade counts, at most one flush).