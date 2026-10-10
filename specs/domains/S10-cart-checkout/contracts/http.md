# HTTP contract: S10 — `orders`

All under `/api`. Errors are `application/problem+json` (`type, title, status, detail, instance, requestId, code`, extensions as listed). Schemas live in `packages/contracts/src/orders/`; e2e specs parse every success body with them (VII.6). Money fields end in `Minor`; ids are UUIDs.

| Route | Auth | Limits / policy | Success | Problem codes |
|---|---|---|---|---|
| `GET /cart` | anonymous allowed (`Firewall({anonymous: true})`) | none (reads) | `200 cartSchema` `{lines:[{productId,quantity,addedAt}], droppedLines:0}`; never `Set-Cookie` | — |
| `PUT /cart/items/:productId` body `{quantity: int 0..20}` (`setCartLineRequestSchema`, strict) | anonymous allowed | `orders.cart-write.identity` 120/min per user or client address, fail open | `200 cartSchema`; first guest write sets `cart=guest:<uuid>.<sig>; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000` (+`Secure` outside local) | `400 validation_failed`, `422 cart_line_limit`, `429 rate_limited` |
| `POST /cart/merge` | session | same policy | `200 cartSchema` with `droppedLines`; always clears the cookie (`cart=; Max-Age=0; Path=/`) when one was sent | `401`, `429` |
| `POST /checkout` body `{expectedTotalMinor?: int ≥ 0}` (`checkoutRequestSchema`, strict) | session, `Firewall({sensitive: true})`, `Idempotency-Key` required | `checkout.create` 10/min per user, token bucket, fail closed | `202 checkoutResponseSchema` `{orderId, status:"RESERVED", totalMinor, currency, reservedUntil}` + `Location: /api/orders/<id>`; replay adds `Idempotency-Replayed: true` | `401`, `400 validation_failed`, `409 idempotency_in_flight` (`Retry-After: 1`), `409 price_changed {currentTotalMinor, lines:[{productId, unitPriceMinor}]}`, `409 checkout_in_progress`, `422 idempotency_key_required|invalid|reuse`, `422 cart_empty`, `422 product_unavailable {productIds}`, `422 mixed_currency`, `422 out_of_stock {productIds}` (final per key), `429 rate_limited`, `503 checkout_unavailable` (`Retry-After: 2`) |
| `GET /orders?limit&cursor` | session | `limit` 1–100, default 20 | `200 orderPageSchema` `{items:[{id,status,totalMinor,currency,createdAt}], nextCursor}` | `401`, `400 validation_failed|invalid_cursor` |
| `GET /orders/:orderId` | session | — | `200 orderSchema` `{id,status,totalMinor,currency,reservedUntil,createdAt,items:[{productId,shopId,title,quantity,unitPriceMinor,discountMinor,lineTotalMinor}],shopOrders:[{id,shopId,subtotalMinor,status}],timeline:[{status,reason,at}]}` | `401`, `400` (not a UUID), `404 order_not_found` (identical for missing and foreign) |
| `POST /orders/:orderId/cancel` | session, `Firewall({sensitive: true})` | `orders.cancel.user` 20/min, fail closed | `200 orderSchema` (also for an already `CANCELLED` order, unchanged) | `401`, `400`, `404 order_not_found`, `409 order_not_cancellable {currentStatus}`, `429` |
| `GET /shops/:shopId/orders?status&limit&cursor` | `ShopScoped('orders.read')` | `status` ∈ `PENDING|PAID|CANCELLED|REFUNDED`, `limit` 1–100 | `200 shopOrderPageSchema` `{items:[{shopOrderId,orderId,status,subtotalMinor,currency,buyerId,createdAt,items}], nextCursor}` — only that shop's lines | `401`, `404 shop_not_found` (non-member and foreign shop), `400` (status/cursor), S03 status gate |
| `POST /webhooks/stripe` raw body ≤ 64 KiB, `Stripe-Signature` | none (signature) | `orders.webhook.ip` 300/min, fail open | `200 webhookAckSchema` `{received:true, duplicate?:true}` | `400 invalid_signature`, `400 invalid_payload`, `413`, `405` (other methods), `429` |

## Status-code rules applied

`401` unauthenticated; `404` for foreign orders and shops (existence hidden); `409` state conflicts (`order_not_cancellable`, `idempotency_in_flight`, `price_changed`, `checkout_in_progress`); `422` semantic and idempotency-key misuse; no `403` on order reads. `GET` never writes. The checkout `202` carries no `paymentIdempotencyKey` (removed).

## Cookies

`cart` is the only cookie of this domain; it names a cart, grants no order access, and is exempt from CSRF rules (spec Assumptions).

## Removed from this domain

`POST /shops/:shopId/flash-sales` stays served by the legacy flash module until S11 replaces it (D-9); it is not part of this contract and keeps its current shape.
