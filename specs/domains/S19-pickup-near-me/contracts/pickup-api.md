# Contract: S19 pickup HTTP API, service and events

Schemas live in `packages/contracts/src/fulfilment/pickup.ts` (zod; the read schemas exist, the write and event schemas are added). All paths are under the global prefix `/api`. Errors are `application/problem+json` (`type, title, status, detail, instance, requestId, code`; `errors[]` for `validation_failed`). 5xx `detail` is generic.

## Seller (ShopScoped; write = `products.write`, read = `products.read`; 401 anonymous, 404 foreign shop, 403 role, 403 `shop_suspended`)

| Method and path | Body / query | Success | Errors |
|---|---|---|---|
| `POST /shops/:shopId/pickup-points` | `{name, address, lat, lng, openingHours?}` | `201 {id, shopId, name, address, lat, lng, openingHours, active, version, createdAt, updatedAt}` | 400 `validation_failed`, 409 `pickup_point_limit_reached` |
| `GET /shops/:shopId/pickup-points` | `limit` (1–50, default 20), `cursor` | `200 {items: [point], nextCursor}` order `createdAt desc, id desc` | 400 |
| `PATCH /shops/:shopId/pickup-points/:pointId` | `{name?, address?, openingHours?, active?}` (≥ 1 key; `lat`/`lng`/`shopId` refused) | `200 point` | 400, 404 `pickup_point_not_found` |
| `GET /shops/:shopId/pickup-points/:pointId/stock` | `limit`, `cursor` | `200 {items: [{productId, quantity, version, updatedAt}], nextCursor}` | 404 |
| `PUT /shops/:shopId/pickup-points/:pointId/stock/:productId` | `{quantity: int 0…1000000, expectedVersion?: int ≥ 0}` | `200 {pickupPointId, productId, quantity, version}` | 400, 404 `pickup_point_not_found` / `product_not_found`, 409 `pickup_point_inactive` / `stock_version_conflict {currentVersion}` |
| `POST /shops/:shopId/pickup-points/:pointId/stock/:productId/adjustments` | header `Idempotency-Key` (required), `{delta: int, ≠ 0, ±100000}` | `200 {pickupPointId, productId, quantity, version, applied: true}`; replay adds `Idempotency-Replayed: true` | 400, 404, 409 `insufficient_pickup_stock {available}` / `stock_limit_exceeded` / `pickup_point_inactive` / in-flight key, 422 missing key or key reused with another body, 503 retryable generic |

## Public (anonymous allowed; no cookies)

| Method and path | Query | Success | Errors |
|---|---|---|---|
| `GET /search/near` | `lat`, `lng` (required), `radiusKm` 0.1–50 (5), `q` ≤ 100 (blank = absent), `limit` 1–50 (20), `cursor` | `200 {items: [{productId, title, category, priceMinor, currency, nearest: {pickupPointId, name, distanceM, quantity}}], nextCursor}` | 400 (unknown parameter too), 429 `rate_limited`+`Retry-After`, 503 `search_unavailable`+`Retry-After` |
| `GET /pickup-points/near` | as above plus `productId` (UUID), no `q` | `200 {items: [{id, shopId, name, address, lat, lng, distanceM, openingHours, quantity?}], nextCursor}` (`quantity` only with `productId`) | 400, 429, 503 `service_unavailable` |
| `GET /pickup-points/clusters` | `bbox=top,left,bottom,right` (required; `left > right` = crosses ±180°), `zoom` int 0–20 (10), `productId?` | `200 {cells: [{cellId, offers, pickupPoints, lat, lng, pickupPointId?}], truncated}`, `Cache-Control: public, s-maxage=30` | 400 (names `bbox`), 429 / 503 with `Cache-Control: no-store` |

Rate-limit policies: `fulfilment.near-search` 120/min per user or client address, fail open (search and browse); `fulfilment.map-clusters` 300/min per client address, fail open.

## Service (R1)

`PickupAvailabilityService.checkAvailability(pickupPointId, lines: {productId, quantity ≥ 1}[1..50] unique) → {available, reason?: 'pickup_point_inactive', shortages: {productId, requested, available}[]}`; throws `PickupPointNotFoundError`, `InvalidAvailabilityRequestError`. One statement for the batch, exact store. Consumers: none today.

## Events (`pickup.events`)

See `data-model.md` § Events. Consumers: this capability's projector only.

## Consumed

`catalog.product_created|updated|archived|restored|deleted` (topic `products`, compacted), `tenancy.shop_created|shop_status_changed|shop_deleted`; R1 `ProductQueryService.getProductsByIds(ids ≤ 500, {shopId})`.

## Changes against today's behaviour (BREAKING, in `questions.md`)

`/search/near` and `/pickup-points/near` return `{items, nextCursor}` instead of bare arrays; `price` → `priceMinor` + `currency`; clusters `[{tile, offers, lat, lng}]` → `{cells, truncated}` with `cellId`; strict validation replaces clamping.
