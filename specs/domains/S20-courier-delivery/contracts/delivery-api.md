# HTTP contract: S20 (prefix `/api`; schemas in `packages/contracts/src/fulfilment/delivery.ts`)

Errors are problem+json with a stable `code`. Unknown body fields → `400`.

| Route | Guard | Success | Errors |
|---|---|---|---|
| `POST /couriers/me` | session | 201 new / 200 update, `courierSchema` | 400, 401, 409 `courier_busy` |
| `GET /couriers/me` | session + profile | 200 `courierSelfSchema` {profile, liveOffer?, activeDelivery?} | 401, 403 `courier_profile_required` |
| `PUT /couriers/me/availability {available}` | profile | 200 | 403, 409 `courier_busy` |
| `POST /couriers/me/locations` | profile; `fulfilment.courier-locations` 30/min fail open; body ≤ 32 KB | 202 `{accepted, dropped:{stale,future}, applied, reason?}` | 400, 401, 403, 413, 429 + `Retry-After`, 503 `location_history_unavailable` |
| `POST /deliveries/:id/accept` | courier | 200 courier view | 404 `delivery_not_found`; 409 `offer_not_active` / `offer_expired` / `courier_busy` / `invalid_delivery_transition` |
| `POST /deliveries/:id/decline` | courier | 204 | 404, 409 |
| `POST /deliveries/:id/picked-up`, `/delivered` | assigned courier | 204 | 404, 409 `invalid_delivery_transition` |
| `GET /deliveries/:id` | buyer / assigned or offered courier | 200 role view | 404 for everyone else |
| `GET /orders/:orderId/deliveries` | buyer | 200 `{items:[buyer view]}` | 401 |
| `POST /shops/:shopId/deliveries` | `ShopScoped('orders.manage')`; `Idempotency-Key` required; `fulfilment.delivery-request` 60/min fail closed | 201 `deliveryShopViewSchema` + `Location` | 400, 401, 403, 404 `order_not_found`, 409 `order_not_deliverable` / `delivery_already_open` / `open_delivery_limit`, 422 missing key, 429, `route_too_long`, `city_not_served` |
| `GET /shops/:shopId/deliveries?status&limit&cursor`, `GET …/:id` | `ShopScoped('orders.read')` | 200 `deliveryPageSchema {items,nextCursor}` / shop view with history | 400, 404 |
| `POST /shops/:shopId/deliveries/:id/cancel {reason}` | `ShopScoped('orders.manage')` | 200 shop view | 400, 404, 409 `invalid_delivery_transition` |

Views: the buyer view has no courier ID, offer, attempt or version, and a position only while `ASSIGNED|PICKED_UP` with `stale` after 60 s; the courier view has no buyer ID; the shop view has no courier coordinates.

Realtime: `delivery:<id>` events `status {status, deliveryVersion, at}` (replayed) and `courier_position {lat,lng,ts}` (live, ≤ 1 per 2 s); `user:<courierId>` events `delivery_offer`, `delivery_offer_withdrawn`, `delivery_cancelled`.
