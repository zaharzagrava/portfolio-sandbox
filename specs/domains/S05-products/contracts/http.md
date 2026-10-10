# HTTP contract: S05 — Products

Base path `/api`. Errors are `application/problem+json` with `type`, `title`, `status`, `detail`, `instance`, `requestId` and `code` (S54 filter). Schemas live in `packages/contracts/src/catalog/index.ts` and are strict (an unexpected response field fails the e2e parse). Limits are exported constants shared by the DTOs and the schemas.

## Routes

| Route | Guard / policy | Success | Notes |
|---|---|---|---|
| `POST /shops/:shopId/products` | `ShopScoped('products.write')`, `@RateLimit('catalog.product-write.shop')` | `201 productMemberSchema` | body `productCreateRequestSchema` |
| `GET /shops/:shopId/products?status&category&inStock&limit&cursor` | `ShopScoped('products.read')` | `200 productPageSchema` (`{items: member[], nextCursor}`) | keyset; default `limit` 20, 1–100; default `status=ACTIVE` |
| `GET /shops/:shopId/products/:productId` | `ShopScoped('products.read')` | `200 productMemberSchema` | archived visible to members |
| `PATCH /shops/:shopId/products/:productId` | `ShopScoped('products.write')`, write policy | `200 productMemberSchema` | `productUpdateRequestSchema` |
| `POST /shops/:shopId/products/:productId/archive` | same | `200 productMemberSchema` | `{expectedVersion}` |
| `POST /shops/:shopId/products/:productId/restore` | same | `200 productMemberSchema` | `{expectedVersion}` |
| `GET /products/:productId` | `Firewall({anonymous:true})`, `@RateLimit('catalog.product-read.ip')`, `VersionEtagInterceptor` | `200 productPublicSchema` / `304` | headers below |
| `GET /batch/products?ids=a,b,c` | `Firewall({anonymous:true})`, `@RateLimit('catalog.batch-read.ip')` | `200 (productBatchItemSchema \| null)[]` | ≤ 100 ids, request order, `Cache-Control: public, max-age=10` |

Removed (answer `404`): `POST /products`, `POST /products/shops/:shopId`, `GET /products/search`, `GET /shops/:shopId/products/search`.

Answer order on shop routes (S03): `401` → `404` (non-member and unknown shop, same body) → `403 permission_denied` → status gate `403 shop_suspended` / `409 shop_offboarding` → validation `400` / `422` → domain errors.

## Schemas

```
productCreateRequestSchema  (strict)  { title, description?, brand, category, priceMinor, currency?, quantity?, tags? }
productUpdateRequestSchema  (strict)  { expectedVersion, title?, description?, brand?, category?, priceMinor?, currency?, quantity?, tags? }   at least one field besides expectedVersion; no null
productTransitionRequestSchema (strict) { expectedVersion }
productMemberSchema (strict)  { id, shopId, title, description, brand, category, priceMinor, currency, rating, tags, quantity, inStock,
                                status, version, viewCount, externalSku|null, createdAt, updatedAt }
productPublicSchema (strict)  { id, shopId, title, description, brand, category, priceMinor, currency, rating, tags, inStock, version, viewCount, updatedAt }
productBatchItemSchema (strict) { id, shopId, title, priceMinor, currency, inStock, category, rating }
productPageSchema           { items, nextCursor: string|null }
```

Limits: `title` 1–200; `description` 0–4,000; `brand`, `category` 1–100 (code points, after trim); `priceMinor` integer 1…10,000,000,000; `quantity` integer 0…1,000,000,000; `tags` ≤ 32 of 1–50; `expectedVersion` positive integer; `limit` 1–100; `ids` 1–100 UUIDs. Forbidden body fields (create and update): `id, shopId, status, version, rating, viewCount, sellerId, createdBy, isSandbox, externalSku`.

## Headers

- `GET /products/:id` `200`: `ETag: W/"<id>-v<version>"`, `Cache-Control: public, s-maxage=15, stale-while-revalidate=30`. `304` on matching `If-None-Match`. `404`: `Cache-Control: public, s-maxage=5`.
- `429`: `Retry-After` (S50). `GET /batch/products` `200`: `Cache-Control: public, max-age=10`.

## Problem codes

| Status | `code` | When |
|---|---|---|
| 400 | `validation_failed` | any DTO/path/query violation; lists fields |
| 400 | `invalid_cursor` | tampered cursor or cursor for another shop/filter set |
| 401 | (S01) | no credentials |
| 403 | `permission_denied` | `VIEWER` on a write route |
| 403 | `shop_suspended` | write on a suspended shop |
| 404 | `product_not_found` | unknown id, id of another shop, hidden product (public) |
| 404 | `shop_not_found` | non-member / unknown shop (S03 body) |
| 409 | `version_conflict` (+ `currentVersion`) | stale `expectedVersion` |
| 409 | `invalid_transition` | archive archived / restore active |
| 409 | `product_archived` | edit of an archived product |
| 409 | `shop_offboarding` | shop `DELETING` |
| 422 | `currency_not_supported` | currency other than the platform's |
| 429 | `rate_limited` | policy exceeded |
| 503 | `service_unavailable` | cold read with database down/timeout; limiter store down on writes; outbox failure |

## Rate-limit policies (`rate-limit-policies.ts`)

| Policy | Algorithm | Key | Fail mode |
|---|---|---|---|
| `catalog.product-read.ip` | slidingWindow 600 / 60 s | `ip` | open |
| `catalog.product-write.shop` | slidingWindow 120 / 60 s | `shop` | closed |
| `catalog.batch-read.ip` | slidingWindow 120 / 60 s | `ip` | open |

`search.query` **stays** in the catalog's table, marked transitional: five other domains (experimentation, catalog-sync, fulfilment, discovery, launch-events) use the name and S32 has not declared it yet. The catalog's own routes stop using it. S32 takes the declaration over (sibling follow-up).
