# W03 — Data model (client and read models)

W03 adds no tables. This file lists the read models, where each lives, and the state machines. Backend shapes are the `packages/contracts` schemas named in `contracts/backend-endpoints.md`; none is re-declared in the web package (FR-055).

## State homes (AS-71)

| State | Home | Key / storage | Lifetime |
|---|---|---|---|
| Cart lines (cheap list) | TanStack Query | `queryKeys.cart.lines()` | 0 s stale, refetch on focus |
| Cart page (lines + product + shop) | TanStack Query | `queryKeys.cart.page()` | 0 s, refetch on focus |
| Last merge result | TanStack Query (`setQueryData`) | `queryKeys.cart.lastMerge()` | until reload |
| Orders list page | TanStack Query | `queryKeys.orders.list({cursor})`; cursor in the URL | 15 s |
| Order detail aggregate | TanStack Query | `queryKeys.orders.detail(id)` | 0 s until terminal, then 60 s |
| Payment | TanStack Query | `queryKeys.payments.detail(id)`; `clientSecret` stripped by `select`, read once outside the cache | 0 s until terminal |
| Unread count / inbox | TanStack Query (`useInfiniteQuery` for the inbox) | `queryKeys.notifications.unreadCount()` / `.inbox()` | 30 s |
| Order attempt / pay attempt | tab `sessionStorage` through `attempt-store.ts` | `w03.attempt.checkout`, `w03.attempt.pay:{orderId}` | ≤ 24 h |
| Pay phase | `useReducer` in `use-pay-flow.ts` | none | page |
| Dialog / panel open, pending flags, undo toast, field text | `useState` in the lowest component | none | component |
| Stream health | module state read by `useSyncExternalStore` | none | page |
| Merge notice dismissed | `useState` | none | until reload |

## Entities

**Cart view** (`cartPageResponseSchema`, B-5): `lines[{productId, quantity 1-20, addedAt, product{title, priceMinor, currency, imageUrl|null, inStock}|null, shop{id,name}|null}]`, `droppedLines`, `errors[{section:'products'|'shops', code, retryable}]`. Derived by pure code in `lib/cart/totals.ts`: groups by `shop.id` (null → "Other items"), per-currency integer subtotal over available lines (`priceMinor × quantity`), unit count for the badge from `cart.lines` only.

**Order attempt**: `{key: uuid, expectedTotalMinor, cartFingerprint, createdAt}`. **Pay attempt**: `{key, paymentMethodId, createdAt}` (new key when the method token changes). The fingerprint is a hash of sorted `productId:quantity` pairs; no personal data.

| Event | Order attempt |
|---|---|
| first press | create |
| network failure, `503`, `409 idempotency_in_flight`, press after `401` with an unchanged cart | keep key |
| `409 price_changed`, then **Accept**: body total changes, key kept (no order existed) | keep key, update `expectedTotalMinor` |
| press after `out_of_stock` | new key |
| cart fingerprint differs | new key |
| `202`, `cart_empty`, `product_unavailable`, `mixed_currency`, key-misuse `422`/`400`, sign-out message, age > 24 h | delete |

**Order / payment views**: `orderSchema` (status, totals, `reservedUntil`, items, `shopOrders`, `timeline[{status,reason,at}]`), `paymentSchema`; the order-page aggregate carries a payment *summary* without `clientSecret`.

**Notification item**: `{id, type, category, title, body, link|null, read, createdAt}`; the live event has `unread` instead of `read`. Deduplicated by `id` in the inbox cache.

## Order status → UI (FR-060, FR-061)

| Status | Badge | Actions | Pay page | Success page |
|---|---|---|---|---|
| `PENDING` | Processing | none | "Reserving your items…" | not confirmed |
| `RESERVED` | Awaiting payment | Pay now, Cancel | pay form or panel by payment state | "You haven't paid…" or the payment panel |
| `PAID`, `FULFILLING`, `SHIPPED`, `DELIVERED` | Paid / Preparing / Shipped / Delivered | none | redirect to success | "Order confirmed" |
| `CANCELLED` | Cancelled | Buy these items again | AS-43 | AS-43 copy |
| `REFUNDED` | Refunded | none | AS-43 | AS-43 copy |

"Order confirmed" is rendered by one component, `SuccessView`, which receives a boolean from one pure function `isConfirmed(status)` (`PAID` and later). SC-003 is a test of that function and of every caller.

## Pay phases (FR-051)

`idle → tokenizing → submitting → processing → confirming → completed`; side branches `processing → actionRequired → processing`, `processing | confirming → unknown → completed | failed`, `processing → failed`, `idle | actionRequired → expired` (only when no payment is in progress). `failed`, `completed`, `expired` are terminal. The table of allowed `(phase, event)` pairs *is* the reducer; any other pair returns the same state (a `describe.each` over the full cross product).

Mapping from server data: payment `PENDING` + `requiresAction` → `actionRequired`; `PENDING` → `processing`; `UNKNOWN` → `unknown`; `COMPLETED` with order not `PAID` → `confirming`; `COMPLETED` with order `PAID` → `completed`; `FAILED` → `failed`; `CANCELLED` / `REFUND_PENDING` / `REFUNDED` on a cancelled order → the AS-43 panel.

## Live events (B-5 schemas)

| Event on `user:<id>` | Payload | Effect |
|---|---|---|
| `order.status` | `{orderId, status, orderVersion}` | invalidate `orders.detail(orderId)` and the `orders.list` prefix; one polite announcement on the page that shows it |
| `payment.status` | `{paymentId, orderId, status, version}` | invalidate `payments.detail(paymentId)` and `orders.detail(orderId)` |
| `notification` | item with `unread` | prepend to the loaded inbox page if the `id` is new; unread +1 if `unread` |
| `resync` | `{reason}` | invalidate everything the page holds |
| `revoked` | `{}` | unsubscribe, no banner |
