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
- **S05.R-01** A product belongs to one shop for its whole life, starts `ACTIVE` at `version: 1`, and the shop and creator never come from the request body. [proof: S05 AS-01, S05 AS-02]
- **S05.R-02** Create and update bodies MUST be strict: unknown fields, `null` values and out-of-limit text, price or stock are refused. [proof: S05 AS-02, S05 AS-08] [code: packages/backend/libs/domains/catalog/domain/product-input.ts#parseCreateInput]
- **S05.R-03** A price is an integer in minor units. A currency other than the platform currency gives `422 currency_not_supported`; an omitted currency means the platform currency. [proof: S05 AS-03]
- **S05.R-04** A request without credentials gets `401`, a `VIEWER` gets `403 permission_denied`, and a non-member or unknown shop gets the same `404`. [proof: S05 AS-04]
- **S05.R-05** A write on a `SUSPENDED` shop gives `403 shop_suspended`; on a `DELETING` shop it gives `409 shop_offboarding`. [proof: S05 AS-05]
- **S05.R-06** A product of another shop is indistinguishable from an unknown product: `404 product_not_found`. [proof: S05 AS-12, S05 AS-50]
- **S05.R-07** Update, archive and restore require `expectedVersion`; a mismatch gives `409 version_conflict` with `currentVersion`, and of two simultaneous requests exactly one wins. [proof: S05 AS-10, S05 AS-11, S05 AS-20]
- **S05.R-08** An update that equals the stored values writes no row, no event and leaves the cache entry untouched. [proof: S05 AS-09]
- **S05.R-09** The lifecycle is `ACTIVE ⇄ ARCHIVED` only; any other transition gives `409 invalid_transition`, and editing an archived product gives `409 product_archived`. [proof: S05 AS-18, S05 AS-19, S05 AS-21] [code: packages/backend/libs/domains/catalog/domain/product-status.ts#applyTransition]
- **S05.R-10** The shop list is ordered by `createdAt` then `id`, both descending, with an opaque cursor; the default status is `ACTIVE`. [proof: S05 AS-14, S05 AS-15]
- **S05.R-11** A shop MUST NOT exceed 120 writes per minute; the 121st gives `429 rate_limited` and reads still work ({{concept:rate-limit-policy}}). [proof: S05 AS-22]
- **S05.R-12** A product is public only if it is `ACTIVE`, in a non-sandbox shop, and the shop is not `SUSPENDED`, `DELETING` or `DELETED`; otherwise the answer equals the unknown-ID `404`. [proof: S05 AS-25] [code: packages/backend/libs/domains/catalog/domain/visibility.ts#isPubliclyVisible]
- **S05.R-13** A malformed product ID gives `400 validation_failed` before any cache or database access. [proof: S05 AS-26]
- **S05.R-14** Cache entries MUST have a lifetime of 60 s fresh plus 300 s stale, each within ±10%, and at most 32 KiB. [proof: S05 AS-28, S05 AS-37]
- **S05.R-15** Concurrent cold reads share one database load; stale entries are served while one background refresh runs. [proof: S05 AS-29, S05 AS-30]
- **S05.R-16** A missing product is cached negatively for about 10 s. [proof: S05 AS-31]
- **S05.R-17** A write deletes the product's cache entry after commit and never stores a value. [proof: S05 AS-39]
- **S05.R-18** An invalidation event deletes the entry only when its version is higher than the cached one; stale or duplicate events change nothing. [proof: S05 AS-41, S05 AS-42, S05 AS-43]
- **S05.R-19** `applyStockDelta` is all-or-nothing, idempotent by `operationId`, and MUST NOT take stock below 0 or above 1,000,000,000. [proof: S05 AS-52, S05 AS-53, S05 AS-54, S05 AS-58, S05 AS-59] [code: packages/backend/libs/domains/catalog/domain/stock-rule.ts#applyDelta]
- **S05.R-20** Every committed change writes one versioned product event in the same transaction ({{concept:outbox-task-queue}}). [proof: S05 AS-82, S05 AS-83]

## Behaviors
- **S05.B-01** Given a `STAFF` member of an active shop, when they post a valid product, then the answer is `201` with the member view at `version: 1`. [proof: S05 AS-01]
- **S05.B-02** Given a `PATCH` with the current `expectedVersion`, when the values change, then the answer is `200` with `version` plus one. [proof: S05 AS-07]
- **S05.B-03** Given a `PATCH` with a stale version, when it is sent, then `409 version_conflict` returns `currentVersion` and nothing changes. [proof: S05 AS-10]
- **S05.B-04** Given 45 products, when the client follows `nextCursor`, then pages hold 20, 20 and 5 items without duplicates. [proof: S05 AS-14]
- **S05.B-05** Given an active product, when a member archives it, then the status becomes `ARCHIVED` and restore makes it `ACTIVE` again. [proof: S05 AS-16, S05 AS-17]
- **S05.B-06** Given an anonymous call, when the product is visible, then `200` returns the public view with an `ETag`; the same `If-None-Match` returns `304`. [proof: S05 AS-23, S05 AS-24]
- **S05.B-07** Given an archived or sandbox product, when anyone reads it, then `404` with `Cache-Control: public, s-maxage=5`. [proof: S05 AS-25]
- **S05.B-08** Given a cold product read twice, when the second read arrives, then the cache serves it with no database statement. [proof: S05 AS-27]
- **S05.B-09** Given 100 concurrent cold reads, when they run, then the database receives one statement. [proof: S05 AS-29]
- **S05.B-10** Given 700 reads of random IDs from one address, when the minute passes, then the first 600 answer `404` and the rest `429`. [proof: S05 AS-32]
- **S05.B-11** Given the shared cache is down, when a product is read, then the database answers within 2 s and the view is not counted. [proof: S05 AS-34]
- **S05.B-12** Given a warm entry and a database that is down, when the product is read, then `200` comes from the cache. [proof: S05 AS-35]
- **S05.B-13** Given `GET /batch/products?ids=a,b,c` with `b` invisible, when called, then the array keeps request order with `null` for `b`. [proof: S05 AS-38]
- **S05.B-14** Given stock 5 and ten concurrent `-1` operations, when they run, then five apply, five give `insufficient_stock`, and stock is 0. [proof: S05 AS-53]
- **S05.B-15** Given an applied `operationId`, when it is sent again, then the result has `replayed: true` with the original `quantityAfter`. [proof: S05 AS-54]
- **S05.B-16** Given a new `externalSku`, when `upsertFromExternal` runs, then a product is created; an identical second call is idempotent. [proof: S05 AS-60, S05 AS-61]
- **S05.B-17** Given five reads and a flush, when the job runs, then the stored `viewCount` is 5 with `version` unchanged. [proof: S05 AS-66]
- **S05.B-18** Given an operation record older than 30 days, when the purge job runs, then it is deleted. [proof: S05 AS-65]

## Lifecycles
Statuses: `ACTIVE` and `ARCHIVED`. A shop member with `products.write` moves them with `archive` and `restore`; each move adds a status-history row and increments `version`. The external upsert never revives an archived product.

## Owns
- Tables: `Product`, `ProductShopState`, `ProductStatusHistory`, `ProductStockOperation`, `ProductViewBatch`.
- Events: `catalog.product_created`, `catalog.product_updated`, `catalog.product_archived`, `catalog.product_restored`, `catalog.product_deleted` on topic `products.events`.
- Rate policies: `catalog.product-write.shop` (120/min), `catalog.product-read.ip` (600/min), `catalog.batch-read.ip` (120/min).
- Job: `products.flush-view-counts`.

## Decisions
- Money is an integer in minor units with one platform currency, never a float.
- Controllers and other domains share `ProductCommandService`, so one path enforces every rule.
- The cache is never the source of truth; price and stock for other domains come from the database.
- Writes delete cache entries and never write them; an event consumer repairs lost deletes.
- View counts are approximate and counted in the shared cache, so reads never wait on the database.
- Entries carry the product version so late events and slow readers cannot restore old data.

## Known gaps
- No test id covers AS-33 (limiter store down), AS-36 hot key as listed in the code excerpts beyond cache tests, or AS-67 to AS-79 (flush failures, chunks, two workers, shop suspension, shop purge, backfill); the specification lists them but no test carries these ids except AS-80.
- AS-81 (sandbox stamping) has no test carrying its id.
- Tests listed for the following ids in the facts exist, but the fact list does not show their detail: AS-40, AS-44 to AS-47 are covered only by the invalidation file.
- R-16 negative caching and R-11 rate-limit fail-closed on limiter outage have no `[proof]` for the outage case.
- AS-73 to AS-75 (not counted cases, no write amplification, schedule) have no test.