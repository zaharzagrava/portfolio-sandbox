# HTTP contract: S11 — Flash sales

All routes under `/api`, errors `application/problem+json` (`type, title, status, detail, instance, requestId, code`). Schemas live in `packages/contracts/src/orders/flash-sale.ts` and are re-exported from `packages/contracts` under these names: `flashSaleCreateRequestSchema`, `flashSaleMemberSchema`, `flashSalePageSchema`, `flashSalePublicSchema`, `flashSaleEventSchemas`. The BFF's loose `flashSalePublicSchema` in `packages/contracts/src/bff/upstream.ts:41` is replaced by a re-export of the real one **under the same exported name** (S48/S30 follow-up); `flashSalesResponseSchema` stays `z.array(flashSalePublicSchema)`.

## Seller routes (controller `FlashSaleController`, one application call per handler)

| Route | Guard | Success | Errors |
|---|---|---|---|
| `POST /shops/:shopId/flash-sales` | `ShopScoped('products.write')` | `201 flashSaleMemberSchema`, `Location: /api/shops/:shopId/flash-sales/:id` | `400 validation_failed` (field named), `401`, `403` (permission, `shop_suspended`), `404 shop` / `product_not_found`, `409 flash_sale_overlap`, `422 insufficient_stock \| drop_price_above_regular \| product_unavailable` |
| `GET /shops/:shopId/flash-sales?status&limit&cursor` | `ShopScoped('products.read')` | `200 flashSalePageSchema` = `{ items: flashSaleMemberSchema[], nextCursor: string \| null }`, order `(startsAt DESC, id DESC)`, `limit` 1–100 default 20, `status` optional enum | `400` (bad cursor, `limit > 100`, bad status), `401`, `403`, `404` |
| `GET /shops/:shopId/flash-sales/:saleId` | `ShopScoped('products.read')` | `200 flashSaleMemberSchema` with `stats` | `401`, `403`, `404 flash_sale_not_found` (also another shop's id) |
| `POST /shops/:shopId/flash-sales/:saleId/cancel` | `ShopScoped('products.write')` | `200 flashSaleMemberSchema` (second call also `200`) | `401`, `403`, `404 flash_sale_not_found`, `409 flash_sale_not_cancellable` |

`flashSaleCreateRequestSchema` (strict — unknown properties are `400`): `{ productId: uuid, priceMinor: int 1..9_007_199_254_740_991, units: int 1..1_000_000, buckets?: int 1..256 (16), perUserLimit?: int 1..20 (2), admissionRatePerSecond?: int 1..10_000 (2000), startsAt: ISO datetime, endsAt: ISO datetime }`; cross-field rules (end after start, ≥ now + 2 min, window ≤ 24 h, `perUserLimit ≤ units`) are checked in the schema's refinement for the shape and in the service for the clock. `shopId` is never in the body.

`flashSaleMemberSchema`: `{ id, shopId, productId, priceMinor, currency, units, buckets, perUserLimit, admissionRatePerSecond, startsAt, endsAt, status, statusReason: string | null, stats: { unitsLoaded, unitsRemaining, unitsHeld, unitsSold } | null, createdAt }`. `stats` is `null` while `SCHEDULED`/`CANCELLED`/`START_FAILED`; for `LOADED` it is exact: `unitsRemaining` = sum of buckets (one pipelined read), `unitsHeld`/`unitsSold` = sums of `HELD` / `CONVERTED` flash reservations; for `ENDED`/`RECONCILED` remaining comes from the durable records (`units − sold − held`, not the store).

## Public routes (anonymous, `@RateLimit('orders.flash-sale-read.ip')`, fail open)

| Route | Success | Errors |
|---|---|---|
| `GET /flash-sales/:saleId` | `200 flashSalePublicSchema`, `Cache-Control: public, s-maxage=1` | `400` (not a uuid), `404 flash_sale_not_found` (unknown, `CANCELLED`, `START_FAILED`, `SCHEDULED` with start > 24 h away) |
| `GET /flash-sales?productIds=<uuid>,<uuid>` | `200 flashSalePublicSchema[]` (at most one per product: the open sale, else the next upcoming within 24 h), `Cache-Control: public, s-maxage=1` | `400` (> 100 ids, malformed id, empty, duplicates collapse) |

`flashSalePublicSchema`: `{ saleId, productId, priceMinor, currency, perUserLimit, startsAt, endsAt, state: 'UPCOMING' | 'LIVE' | 'SOLD_OUT' | 'ENDED', remainingApprox: int ≥ 0 | null, degraded?: true, serverTime }` — strict: no `units`, buckets, rate, `shopId`, buyer data. `remainingApprox`: `UPCOMING` → `null` (the total is not public, no `degraded`); `LIVE` / `SOLD_OUT` → integer in `[0, units]`; `ENDED` → `0`; `null` with `degraded: true` only when the stock store failed during `LIVE`.

## Checkout problem codes raised by the flash source (S10's `POST /checkout`)

| Code | Status | Body extras | Header |
|---|---|---|---|
| `out_of_stock` | 422 | `productIds`, `flashSaleId?` | — |
| `flash_sale_limit_exceeded` | 422 | `limit`, `flashSaleId` | — |
| `flash_sale_busy` | 429 | `flashSaleId` | `Retry-After: 1..3` |
| `rate_limited` (S50) | 429 | — | `Retry-After` |
| `flash_sale_unavailable` | 503 | — | `Retry-After: 2` |
| `checkout_unavailable` (S10, order-write margin) | 503 | — | `Retry-After: 2` |

The refusals of a drop line (`busy`, `rate_limited`, `limit_exceeded`, `out_of_stock`, `unavailable`) are **final for the attempt and leave the idempotency key unused** (they happen before an order exists; S10 R-13). `409 price_changed` for a drop cart carries the drop-priced `currentTotalMinor` (AS-04).

## Rate-limit policies (S50 registry, `ordersRatePolicies`)

`orders.flash-reserve.user` 30 / 60 s per `<userId>:<saleId>` fail closed (called programmatically by the flash source); `orders.flash-sale-read.ip` 600 / 60 s per address fail open.
