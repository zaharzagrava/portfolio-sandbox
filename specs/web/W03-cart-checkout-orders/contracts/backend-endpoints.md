# W03 — Backend endpoints: what the UI calls, what this plan adds

Status column verified 2026-10-11. "Browser" = same-origin `/api/*` through the BFF forwarder (`/api/:path*` → `/api/bff/f/:path*`); aggregates are `/api/bff/*`. Every write sends the CSRF header (`csrfHeaders()`); order and payment creation also send `Idempotency-Key`.

## Called by W03

| Call | Status | Schema (`@marketplace-sandbox/contracts`) | Used by |
|---|---|---|---|
| `GET /api/cart` | exists | `cartSchema` | badge, add-to-cart |
| `PUT /api/cart/items/:productId` `{quantity 0..20}` | exists | `setCartLineRequestSchema` → `cartSchema` | cart writes, buy again |
| `POST /api/cart/merge` | exists (`200`) | `cartSchema` (`droppedLines`) | `mergeGuestCart()` |
| `GET /api/bff/cart` | **B-3** | `cartPageResponseSchema` | cart page, review |
| `POST /api/checkout` (`Idempotency-Key`, `{expectedTotalMinor}`) | exists | `checkoutRequestSchema` → `checkoutResponseSchema` | `placeOrder` server action |
| `GET /api/orders?limit&cursor` | exists | `orderPageSchema` | history |
| `GET /api/orders/:orderId` | **B-1** | `orderSchema` | (used inside B-4; also by the pay page prefetch through B-4) |
| `GET /api/bff/orders/:orderId` | **B-4** | `orderPageResponseSchema` | detail, pay, success |
| `POST /api/orders/:orderId/cancel` | exists | `orderSchema` | cancel |
| `POST /api/payments/intents` (`Idempotency-Key`) | exists | `createPaymentIntentRequestSchema` → `paymentAcceptedSchema` | pay |
| `GET /api/payments/:paymentId` | exists | `paymentSchema` | pay panel (only caller that keeps `clientSecret`, in memory) |
| `GET /api/payments?orderId=` | **B-2** | `paymentPageSchema` | inside B-4 (latest payment) |
| `GET /api/notifications?limit&cursor` | exists | `notificationPageSchema` (**B-5**) | inbox |
| `GET /api/notifications/unread-count` | exists | `unreadCountSchema` (**B-5**) | bell |
| `POST /api/notifications/read` `{ids}` or `{all:true}` | exists | `markReadRequestSchema` → `unreadCountSchema` (**B-5**) | mark read |
| `GET /api/streams?topics=user:<id>` | exists (S51, unbuffered by the forwarder) | `streamEventEnvelopeSchema`, payload schemas (**B-5**) | `user-stream.ts` |
| `POST /api/events` | exists (W02) | `ClientEventInput` | `track()` |

## Added by this plan

### B-1 `GET /orders/:orderId` (S10)
- Controller method in `orders.controller.ts` using `@Firewall()`, `@User()`, `ParseUUIDPipe`; returns `OrderQueryService.getOrderForUser(orderId, user.id)`.
- `200 orderSchema`; `400` not a UUID; `401`; `404 order_not_found` identical for missing and foreign (no `403`).
- e2e (extend the orders suite with a new file `order-read.e2e-spec.ts`): happy with items, shop orders and timeline parsed by `orderSchema`; other user → `404`; unknown → `404`; malformed → `400`; no token → `401`; response and DB unchanged (read only).

### B-2 `GET /payments?orderId&status&limit&cursor` (S13)
- Query parsed by `paymentListQuerySchema`; owner only; newest first; keyset like the other S13 reads; `clientSecret` is `null` in list items.
- `200 paymentPageSchema`; `400` bad query; `401`; another user's `orderId` → empty page (existence hidden); rate policy `payments.read.user` (`429`).
- e2e: added to `payment-read.e2e-spec.ts` (happy, ordering, cross-user empty, 400, 401, 429).

### B-3 `GET /bff/cart` (S48, IX.7 R2)
- Anonymous allowed (`identity: 'optional'`). Steps: read the S10 cart (`cart` cookie forwarded for guests, bearer for members), `productsBatch(ids)` (≤ 50), `shopsBatch(distinct shopIds)`; compose lines in cart order.
- Response `cartPageResponseSchema` `{lines[{productId, quantity, addedAt, product|null, shop|null}], droppedLines, errors[{section, code, retryable}]}`. Product hidden/unknown → `product:null`, no error entry; products call failed → every `product:null` + `errors:[{section:'products',…}]`; shops call failed → `shop:null` + `errors:[{section:'shops',…}]`. The cart read itself is required: its failure is the BFF's problem response (status passed through, `Retry-After` kept). No `Set-Cookie`, `Cache-Control: private, no-store`.
- Uses the section/outcome machinery already in `page/section-outcome.ts` (budget per call, breaker per upstream) rather than a second implementation.
- e2e (extend `bff.e2e-spec.ts`): anonymous guest cart, member cart, hidden product, products down, shops down, empty cart, `no-store`, no `Set-Cookie`, shape parsed by the schema.

### B-4 `GET /bff/orders/:orderId` (S48, IX.7 R2)
- Requires a session. Order via B-1's route (required; its `404`/`400`/`401` pass through unchanged); latest payment via B-2 with `limit=1` (optional).
- Response `orderPageResponseSchema` `{order: orderSchema, payment: {id,status,amountMinor,currency,failureCode,requiresAction,version,updatedAt}|null, errors[{section:'payment',code,retryable}]}`. No payment yet → `payment:null`, no error. Payment call failed → `payment:null` + error entry. `clientSecret` is never copied.
- e2e: happy with payment, without payment, payment upstream down → `payment:null` + error, foreign order `404`, malformed `400`, no token `401`, `no-store`.

### B-5 `packages/contracts`
- `src/bff/cart-page.ts` (`cartPageResponseSchema`), `src/bff/order-page.ts` (`orderPageResponseSchema`), both exported from `src/bff/index.ts`.
- `src/notifications/index.ts`: `notificationItemSchema {id, type, category, title, body, link: string|null, read}`, `notificationPageSchema {items, nextCursor}`, `unreadCountSchema {unread}`, `markReadRequestSchema` (`{ids: uuid[1..100]} | {all: true}`), exported from `index.ts`. The shapes are read from `InboxService` and the controller (verified in T009). Differences from the first draft: items also carry `createdAt` (ISO string, optional in the schema); `link` is always a string in the code (the schema keeps `nullable()` for safety); `POST /notifications/read` returns `{unread}` (`unreadCountSchema`), `{all:true}` answers `{unread:0}`; the controller only validates `ids` as strings and the schema is stricter (uuid[1..100]); the list `limit` is clamped to 1..50 (default 20) and the cursor is `<bucket>:<pageState>`.
- `src/realtime-user.ts`: `orderStatusEventSchema`, `paymentStatusEventSchema`, `notificationEventSchema`, and a discriminated `userStreamEventSchema` keyed by `type`. The code publishes with the SSE event name as discriminator and a payload without `type`: `order.status {orderId,status}` (no `orderVersion` today, optional in the schema), `payment.status {paymentId,orderId,status,version}`, `notification {id,type,category,title,body,link,unread,createdAt}`. So `userStreamEventSchema` is `{type: 'order.status'|'payment.status'|'notification', data: <payload schema>}` where `type` is the SSE `event:` name and `data` is `envelope.data`.
- Contract tests parse a real response from each new e2e spec (VII.6).

### Not added (recorded in `research.md` R-02/R-03)
`refCode` in `checkoutRequestSchema`, `reservedUntil` on the list item, `GET /checkout/preview`, `unreadCount` on the notification event, entitlement read per order line.

## Problem codes W03 renders

Exactly the table of spec FR-081, keyed by `(surface, status, code)` in `lib/api/problem-copy.ts`. Codes are stable strings from S10/S11/S13/S28; a code outside the table falls to the FR-082 generic form with "Reference: {requestId}".

## Cleanup of removed routes

`/payment/by-key/:key`, `/payment/:id`, `/payment`, `/payment/stream` no longer exist (S13). Phase 8 removes the `payment/stream` branch in `composition/bff/forward/route-table.ts` (re-run `bff-forward.e2e-spec.ts`) and the comment in `next.config.ts` that lists it.
