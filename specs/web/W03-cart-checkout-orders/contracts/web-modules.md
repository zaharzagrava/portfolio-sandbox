# W03 — Web modules, routes and events (what other capabilities may rely on)

Names are exact. Paths are in `packages/web`. Signatures are the contract; bodies belong to `tasks.md`.

## Routes

| Route | Guard | Notes |
|---|---|---|
| `/cart` | none (guest allowed) | static shell, client fetch |
| `/checkout` | `requireServerSession('/checkout')` | review + Place order |
| `/checkout/pay/[orderId]` | `requireServerSession('/checkout/pay/{id}')`, UUID check → `notFound()` | foreign/unknown → same not-found |
| `/checkout/success/[orderId]` | same | replaces `/checkout/success?orderId=` |
| `/orders` (`?cursor=`) | `requireServerSession('/orders' + search)` | keyset; `400 invalid_cursor` → AS-53 copy |
| `/orders/[orderId]` | same | target of S28 links |
| `/dashboard/orders` | none | permanent redirect to `/orders` (`next.config.ts` `redirects()`) |

Route builders added to `lib/routes.ts`: `cartHref()`, `checkoutHref()`, `payHref(orderId)`, `successHref(orderId)`, `ordersHref(cursor?)`, `orderHref(orderId)`.

## Components (consumed by other capabilities)

| Export | File | Consumers |
|---|---|---|
| `AddToCartButton({productId, category?, disabled?})` | `components/add-to-cart-button.tsx` | W02 product page, cards |
| `CartBadge()` | `components/cart/cart-badge.tsx` | W07 navbar and mobile menu; accessible name "Cart" / "Cart, {n} items"; badge `99+` |
| `useCartCount(): number \| null` | `components/cart/cart-badge.tsx` re-export of `lib/api/cart.ts` | W07 |
| `NotificationsPopover()` | `components/notifications/notifications-popover.tsx` | W07 navbar, signed-in only (old path re-exports until the import moves) |

## lib (consumed by W01/W04/W05)

| Export | File | Contract |
|---|---|---|
| `mergeGuestCart(): Promise<{droppedLines: number}>` | `lib/api/cart.ts` | never throws; failure resolves `{droppedLines: 0}`; sets `queryKeys.cart.lastMerge()`; W01 may keep ignoring the value |
| `subscribeUserEvents(handler): () => void`, `useUserStream()` | `lib/realtime/user-stream.ts`, `hooks/use-user-stream.ts` | one ref-counted `EventSource` per page for `user:<id>`; handler receives `{type: 'order.status' \| 'payment.status' \| 'notification', data}` plus `onResync`, `onRevoked`; health `connected \| reconnecting \| closed`. W04/W05 may add topics through `addTopic(topic)` (the URL lists all topics; the connection is recreated once when the set changes) |
| `queryKeys.cart.{all, lines(), page(), lastMerge()}`, `queryKeys.orders.{all, list({cursor}), detail(id)}`, `queryKeys.payments.{all, detail(id)}`, `queryKeys.notifications.{all, unreadCount(), inbox()}` | `lib/query-keys.ts` | `CART_QUERY_KEY`, `ORDERS_QUERY_KEY` removed |
| `safeNotificationLink(link): string \| null` | `lib/safe-link.ts` | starts with exactly one `/`, no scheme, no `//`, no backslash, no control characters |
| `isConfirmed(status): boolean` | `lib/checkout/status.ts` | the only way any page decides to say "confirmed" |

## Server function

`placeOrder(input: {key: string; expectedTotalMinor: number}): Promise<{ok: true; orderId: string; replayed: boolean} | {ok: false; problem: CheckoutProblem}>` in `app/checkout/actions.ts` (`'use server'`). `CheckoutProblem` = parsed problem plus optional `retryAfter` seconds, `productIds`, `currentTotalMinor`, `lines`, `flashSaleId`. Adds `Idempotency-Key`, the CSRF header from the `__Host-bff-csrf` cookie, forwards the session cookie; adds `refCode` only if the contract schema declares it.

## Events (S39) emitted through `track()`

| Event | Props | When |
|---|---|---|
| `add_to_cart` | `{product_id, category}` | once per successful add |
| `checkout_step` | `{step: 'cart' \| 'review' \| 'pay' \| 'success', items, order_id?}` | once per view of the step; `order_id` on pay and success |

No titles, totals, personal data; nothing is sent under Global Privacy Control / Do Not Track (enforced by `track`).

## Storage keys (listed in `lib/browser-storage-keys.ts` and the privacy page)

`w03.attempt.checkout`, `w03.attempt.pay:{orderId}` — `sessionStorage`, random key + expected total + timestamp, ≤ 24 h, no credential.

## Configuration

| Variable | Scope | Use |
|---|---|---|
| `PAYMENT_PROVIDER_HOSTS` | server | CSP script/frame/connect hosts on `/checkout/pay/*` only (already parsed by `lib/config-parse.ts`) |
| `NEXT_PUBLIC_PAYMENT_PUBLISHABLE_KEY` | public | Stripe publishable key for `StripeFields` |
| `NEXT_PUBLIC_PAYMENTS_SANDBOX` | public, non-production | enables `SandboxCardPicker`; ignored when `NODE_ENV === 'production'` |
