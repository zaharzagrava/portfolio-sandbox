# Test Plan: W03 — Cart, checkout, pay step, success page, orders, notification popover (`packages/web`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md) (75 scenarios, AS-01 to AS-75), each proven at the lowest layer that can prove it. A dash means the layer does not test that scenario. Where a row names two layers, each proves a different part (stated in the cell); no part is proven twice. "Proven by backend spec" names the backend scenario that owns the rule; the UI never re-tests it (VII.7).

## Layers and conventions

- **UI journey (Playwright, happy path only)**: `packages/web/tests/*.spec.ts` against the real local dev stack (`moon run :dev-monolith`, web on 3000), an isolated user per test, web-first assertions, no fixed sleeps. Payments use the sandbox card picker (`NEXT_PUBLIC_PAYMENTS_SANDBOX=true`, see `gaps.md` T7). A journey never forces a failure and never asserts a backend rule; failure forms are unit tests with MSW. Each file's top-level `describe` names its feature.
- **UI unit (Vitest + React Testing Library)**: `*.test.tsx` / `*.test.ts` next to the code. Queries by role and label, `@testing-library/user-event`, MSW at the network boundary with problem+json fixtures parsed by the `packages/contracts` schemas, `jsdom`, fake timers for countdowns, retries and polling, a stub for the provider's hosted fields and for `EventSource`. They cover UI-only logic, states, copy, focus and accessibility. No markup snapshots.
- **Visual (Playwright screenshot)**: `packages/web/tests/visual/*.spec.ts`. Layout states at mobile (390 × 844, ≤ 640) and desktop (1280 × 800, ≥ 1024) in the `chromium` project plus a `mobile` project. The backend is stubbed with `page.route` (layout only, no behaviour), animations disabled, an axe scan (serious or critical = 0) runs on each state, screenshots are compared to committed baselines. AS-74 is proven here for every state.
- **Static gates** (VII.1): `tsc --noEmit`, ESLint, `next build` (Cache Components validation), and the architecture test `lib/architecture.test.ts` (reads the source: no `fetch`/`axios`/`EventSource` in components or hooks, query keys only from `lib/query-keys.ts`, no new Context or store, no `use cache` in W03 pages, no token storage).
- Fallback and degradation paths (VII.9) each have a forcing test: partial cart (AS-09), partial order (AS-56), polling fallback (AS-39), stream reconnect (AS-45, AS-68), pay-request lag retry (AS-44), merge failure (AS-12).

### Test files

| Key | File | Top-level `describe` |
|---|---|---|
| JC | `packages/web/tests/cart-checkout.spec.ts` | `Cart & checkout` (rewritten: guest cart → sign-up merge → checkout → pay → success; remove last line; guarded URLs) |
| JO | `packages/web/tests/orders.spec.ts` | `Orders` (history, detail, cancel an unpaid order) |
| JN | `packages/web/tests/notifications.spec.ts` | `Notifications` (pay → bell → inbox → order) |
| UC1 | `packages/web/components/cart/cart-view.test.tsx` | `Cart view` |
| UC2 | `packages/web/components/cart/cart-line.test.tsx` | `Cart line` |
| UC3 | `packages/web/components/add-to-cart-button.test.tsx` | `Add to cart button` |
| UC4 | `packages/web/components/cart/cart-badge.test.tsx` | `Cart badge` |
| UC5 | `packages/web/lib/api/cart.test.ts` | `Cart API client` (rewritten; `cartTotals`/`hydrate` tests go away) |
| UK1 | `packages/web/components/checkout/review.test.tsx` | `Checkout review` |
| UK2 | `packages/web/lib/checkout/attempt.test.ts` | `Order attempt (idempotency key lifecycle)` |
| UK3 | `packages/web/app/checkout/actions.test.ts` | `Order creation function` |
| UK4 | `packages/web/components/checkout/place-order.test.tsx` | `Place order` |
| UK5 | `packages/web/components/checkout/pay-panel.test.tsx` | `Pay panel` |
| UK6 | `packages/web/lib/checkout/pay-flow.test.ts` | `Pay flow reducer` |
| UK7 | `packages/web/components/checkout/reservation-timer.test.tsx` | `Reservation timer` |
| UK8 | `packages/web/components/checkout/success-view.test.tsx` | `Success view` |
| UP1 | `packages/web/app/checkout/pay/[orderId]/page.test.tsx` | `Pay page access` |
| UP2 | `packages/web/app/checkout/success/[orderId]/page.test.tsx` | `Success page access` |
| UO1 | `packages/web/components/orders/orders-list.test.tsx` | `Orders list` |
| UO2 | `packages/web/components/orders/order-detail.test.tsx` | `Order detail` |
| UO3 | `packages/web/components/orders/cancel-order-dialog.test.tsx` | `Cancel order dialog` |
| UO4 | `packages/web/components/orders/buy-again.test.tsx` | `Buy again` |
| UO5 | `packages/web/app/orders/[orderId]/page.test.tsx` | `Order page access` |
| UN1 | `packages/web/components/notifications/notifications-popover.test.tsx` | `Notifications popover` |
| UN2 | `packages/web/lib/realtime/user-stream.test.ts` | `User stream` |
| UL | `packages/web/lib/safe-link.test.ts` | `Safe notification link` |
| UE | `packages/web/lib/checkout/events.test.ts` | `Checkout analytics events` |
| UR | `packages/web/lib/redirects.test.ts` | `Redirects` (reads the `redirects()` of `next.config.ts`) |
| UA | `packages/web/lib/architecture.test.ts` | `W03 architecture rules` |
| VC | `packages/web/tests/visual/cart.spec.ts` | `Cart layout` |
| VK | `packages/web/tests/visual/checkout.spec.ts` | `Checkout layout` (review, pay, success) |
| VO | `packages/web/tests/visual/orders.spec.ts` | `Orders layout` |
| VN | `packages/web/tests/visual/notifications.spec.ts` | `Notifications layout` |

Journeys (`JC-1` …) are named steps inside one test so each scenario points at one place: **JC-1** guest adds from a product page (toast, badge 1) → signs up → lands with the guest line merged; **JC-2** cart (quantity +, subtotal) → checkout → place order → pay with the sandbox card → success page "Order confirmed"; **JC-3** remove the last line → empty cart; **JC-4** an anonymous visitor opens `/checkout`, `/checkout/pay/{id}`, `/checkout/success/{id}`, `/orders`, `/orders/{id}` and lands on sign-in with `returnTo`, then returns after signing in; **JO-1** place an order (no payment) → `/orders` shows it with **Pay now** and **Cancel** → open detail → cancel → `CANCELLED`; **JN-1** pay for an order → bell count rises live → open → follow the item to the order → count drops.

## Scenario table

| Scenario | UI journey (Playwright, happy path) | UI unit (Vitest + RTL: UI-only logic, states, a11y) | Visual (Playwright screenshot: layout states at mobile/desktop) | Proven by backend spec (ID) |
|---|---|---|---|---|
| AS-01 empty cart (guest) | — | UC1 (empty copy, link, no summary); UC4 (no badge) | VC `empty` | S10 AS-01 |
| AS-02 add to cart | JC-1 (toast and badge after pressing) | UC3 (pending label, toast action, reads current quantity first, `add_to_cart` once) | — | S10 AS-03 |
| AS-03 cart page loaded | JC-2 (line, title link, subtotal with real data) | UC1 (grouping by shop, "Other items", links, summary) | VC `loaded` | S10 AS-01 |
| AS-04 change quantity | JC-2 (press +, total changes) | UC2 (instant values, `aria-busy`, rollback); UC5 (writes per product serialised, last value wins, re-read after last) | — | S10 AS-03 |
| AS-05 remove and undo | JC-3 (remove last line → empty) | UC2 (undo toast 8 s with fake timers, focus move) | — | S10 AS-03 |
| AS-06 quantity bounds | — | UC2 (− disabled at 1, + disabled at 20 with hint, typed values revert and announce) | — | S10 AS-03 (400 for out-of-range) |
| AS-07 write failures | — | UC2 (copy per code via MSW: `cart_line_limit`, `rate_limited` with `Retry-After`, network, other; rollback) | — | S10 AS-03, AS-10 |
| AS-08 unavailable and out-of-stock lines | — | UC1 (labels, "—", excluded from subtotal, checkout still enabled) | VC `unavailable-lines` | S10 AS-21 |
| AS-09 loading, error, partial | — | UC1 (skeleton status, error + Try again, partial banner + Reload, subtotal unavailable) | VC `loading`, `error`, `partial` | S48 AS-14 |
| AS-10 guest checks out | JC-1 (Sign in to check out → sign-in → `/checkout`) | UC1 (guest label and `loginHref('/checkout')` target) | — | S10 AS-08; W01 AS-01 |
| AS-11 merge after sign-in | JC-1 (guest line present after sign-up) | UC1 (notice with `droppedLines` > 0, dismiss, none at 0) | — | S10 AS-05, AS-07 |
| AS-12 merge failure is silent | — | UC5 (`mergeGuestCart` rejects → resolved, no throw, next read unaffected) | — | S10 AS-06 |
| AS-13 cart badge | — | UC4 (name "Cart, n items", `99+`, absent when unknown, refetch on focus) | — | S10 AS-01 |
| AS-14 guard (anonymous) | JC-4 (every guarded W03 URL → sign-in with `returnTo`, back after sign-in; also proves the anonymous parts of AS-35, AS-50, AS-57) | — | — | S10 AS-21; W01 AS-27 |
| AS-15 review screen | JC-2 (total shown, Place order present) | UK1 (progress list `aria-current`, lines by shop, note, estimated total) | VK `review` | — |
| AS-16 empty cart on checkout | — | UK1 (empty state, no Place order) | — | S10 AS-21 |
| AS-17 place order, happy path | JC-2 (Place order → pay page) | UK4 (pending label, `aria-busy`, navigates with `orderId`, cart cleared); UE (`checkout_step` review, pay) | — | S10 AS-13 |
| AS-18 one request at a time | — | UK4 (two presses and double Enter = one call) | — | S10 AS-17 |
| AS-19 key lifecycle | — | UK2 (table-driven: reuse after network, 503, in-flight, price re-confirmation; new key after `out_of_stock` and after cart change; UUID; 24 h drop) | — | S10 AS-18, AS-20 |
| AS-20 reload during the request | — | UK2 (restore from session storage, same key; cleared on success, final outcome, sign-out) | — | S10 AS-15, AS-16 |
| AS-21 replay is success | — | UK4 (`Idempotency-Replayed: true` behaves as `202`) | — | S10 AS-15 |
| AS-22 in flight | — | UK4 (automatic retry with fake timers honouring `Retry-After`, 5 tries, final alert and link) | — | S10 AS-16, AS-30 |
| AS-23 price changed | — | UK4 (alert, old/new prices, accept re-sends with new total, focus on alert) | VK `price-changed` | S10 AS-14 |
| AS-24 out of stock | — | UK4 (titles from `productIds`, labels on lines, new key) | — | S10 AS-32, AS-33 |
| AS-25 product unavailable | — | UK4 (Remove unavailable items writes exactly those lines, button disabled meanwhile) | — | S10 AS-21 |
| AS-26 mixed currency | — | UK4 (alert and link) | — | S10 AS-21 |
| AS-27 cart empty at submit | — | UK4 (empty state plus orders link) | — | S10 AS-21, AS-27 |
| AS-28 another checkout running | — | UK4 (alert, link, button enabled) | — | S10 AS-27 |
| AS-29 rate limited | — | UK4 (disabled until `Retry-After` passes, re-enabled, announced twice only) | — | S10 AS-26 |
| AS-30 temporarily unavailable | — | UK4 (alert, same key on retry) | — | S10 AS-30 |
| AS-31 misuse and unknown failures | — | UK4 (generic alert with reference, new attempt; `5xx` detail hidden) | — | S10 AS-14, AS-18 |
| AS-32 session ended while placing | — | UK2 (attempt survives a `401`, reused after sign-in, cleared on the `signed-out` message) | — | W01 AS-26 |
| AS-33 offline | — | UK1 (banner, Place order disabled, restored online) | — | — |
| AS-34 referral code | — | UK3 (code added only when the schema declares it, typed result, never throws) | — | S10 questions (S37); W02 AS-63 |
| AS-35 pay page access and order states | — | UP1 (not found for malformed, unknown, foreign); UK5 (PENDING status, PAID → redirect, CANCELLED/REFUNDED → AS-43 panel) | — | S10 AS-55, AS-58 |
| AS-36 countdown | — | UK7 (timer role, announcements at 5 min/1 min/expiry, re-read at zero, "Payment in progress" suppresses expiry) | VK `pay-countdown` | S10 AS-36 |
| AS-37 pay form | — | UK5 (Pay disabled until complete, provider errors with `aria-describedby`, no card data in the DOM) | VK `pay-form` | S13 AS-02, AS-63 |
| AS-38 pay, happy path | JC-2 (sandbox card → processing → success page) | UK6 (phase transitions idle → submitting → processing → confirming → completed); UK5 (messages) | — | S13 AS-01, AS-15; S10 AS-41 |
| AS-39 processing and live updates | — | UK6 + UN2 (stream silence 10 s → polling 2 s/5 s schedule, ≤ 30 req/min, stop message and Check again) | VK `pay-processing` | S13 AS-21; S51 AS-16 |
| AS-40 action required | — | UK5 (frame opens with the secret from memory, abandon → Continue verification, secret never stored or in URL) | VK `pay-action-required` | S13 AS-17 |
| AS-41 payment failed | — | UK5 (table-driven copy per `failureCode`, Buy again offered, no retry button) | VK `pay-failed` | S13 AS-16; S10 AS-48 |
| AS-42 outcome unknown | — | UK5 + UK6 (message, no Pay button, settles to completed or failed) | VK `pay-unknown` | S13 AS-23, AS-26 |
| AS-43 order cancelled or refunded | — | UK5 (reason sentences, refund notice for paid-after-cancel, refunded copy) | VK `pay-cancelled` | S10 AS-36, AS-47, AS-49 |
| AS-44 pay request problems | — | UK5 (`order_not_payable` re-read per reason, `payment_already_exists` follows the payment, `order_not_found` lag retried 3 × 2 s then message, 422/400/5xx generic, 429 countdown, in-flight retry) | — | S13 AS-02, AS-06, AS-07, AS-11, AS-12, AS-14 |
| AS-45 stream health | — | UN2 (banner once per page, resync re-read, 401/403 → refresh and recreate once, then W01 flow) | — | S51 AS-16, AS-21 |
| AS-46 order lags payment | — | UK6 (completed payment + `RESERVED` order shows "Confirming", hint after 60 s fake timer, never "confirmed") | — | S10 AS-41, AS-44 |
| AS-47 double submit of the payment | — | UK2 (pay attempt key persisted per order); UK5 (two presses = one request) | — | S13 AS-03, AS-05, AS-07 |
| AS-48 success confirmed | JC-2 (heading "Order confirmed", links) | UK8 (copy, focus on `<h1>`, announced once, `checkout_step` success) | VK `success` | S10 AS-41, AS-58 |
| AS-49 success not confirmed | — | UK8 (unpaid, in progress, cancelled/refunded never say "confirmed") | — | S10 AS-41 |
| AS-50 success page access | — | UP2 (not found for foreign, unknown, malformed; anonymous part is AS-14) | — | S10 AS-58 |
| AS-51 history list | JO-1 (order listed with Pay now and Cancel) | UO1 (rows, actions per status, status text, order id keys) | VO `list` | S10 AS-59 |
| AS-52 history empty, loading, error | — | UO1 (empty copy, skeleton status, error + Try again, `429`/`5xx` forms) | VO `empty`, `error` | S10 AS-59 |
| AS-53 paging in the URL | — | UO1 (Older orders link with cursor, Newest link, `invalid_cursor` form) | — | S10 AS-59 |
| AS-54 cancel | JO-1 (confirm → `CANCELLED`) | UO3 (dialog focus on Keep order, pending label, focus return, `409`/`404`/`429` forms) | — | S10 AS-40, AS-55 |
| AS-55 order detail | JO-1 (detail opens with timeline and shop slice) | UO2 (timeline order, shop subtotals, status-dependent actions, links) | VO `detail-reserved`, `detail-paid`, `detail-cancelled` | S10 AS-58 |
| AS-56 detail partial payment | — | UO2 (payment unavailable note + Reload; absent when null without error) | VO `detail-partial` | S48 AS-14 |
| AS-57 detail states | — | UO2 (skeleton, read error); UO5 (not found for malformed, unknown, foreign; anonymous part is AS-14) | — | S10 AS-58 |
| AS-58 live status | — | UO1 + UO2 (stream stub: re-read, one polite announcement, other orders only refreshed in cache) | — | S10 AS-65 |
| AS-59 buy again | — | UO4 (sequential puts, quantity = current + order capped at 20, redirect and toast, failures listed on the cart) | — | S10 AS-03 |
| AS-60 old and deep links | — | UR (`/dashboard/orders` → `/orders` permanent); UO5 (deep link renders detail) | — | S28 AS-01 |
| AS-61 bell | JN-1 (bell shows unread after the order is paid) | UN1 (name with count, `99+`, absent at 0 or unknown, none for anonymous, count read on mount and focus) | — | S28 AS-57 |
| AS-62 open the inbox | JN-1 (open, item visible) | UN1 (focus in, skeleton, plain text items, unread marker, time element, Esc returns focus) | VN `open` | S28 AS-55 |
| AS-63 follow an item | JN-1 (click → order detail, count drops) | UN1 (optimistic read + rollback); UL (table-driven link safety: `/x` ok; `//x`, `https://x`, `javascript:` refused) | — | S28 AS-58 |
| AS-64 mark all read | — | UN1 (all read, count 0, announcement, rollback, button hidden at 0) | — | S28 AS-60 |
| AS-65 inbox empty, error, limits | — | UN1 (empty copy, error + Try again, `429` wait, `401` hands to W01) | VN `empty`, `error` | S28 AS-56, AS-57 |
| AS-66 live arrival | JN-1 (badge rises without reload after payment) | UN1 (adds on top, ignores known id, announcement throttled to 1 per 5 s, focus unmoved) | — | S28 FR-040; S51 AS-08 |
| AS-67 more items | — | UN1 (Show older appends without duplicates, focus on first new, button gone at end) | — | S28 AS-55 |
| AS-68 reconnect (popover) | — | UN1 (banner in header, re-read of count and first page on reconnect and `resync`, `revoked` silent) | — | S51 AS-16 |
| AS-69 popover layout and keyboard | — | UN1 (tab order, labelled list) | VN `layout` (width at both viewports, internal scroll) | — |
| AS-70 rendering model | — | UA (no `use cache` in W03 pages, request reads inside Suspense, `/cart` has no request-time read); static: `next build` | — | — |
| AS-71 state homes | — | UA (no fetch/axios/EventSource in components or hooks, keys only from `query-keys`, no new Context or store); UK6 (closed phase set) | — | — |
| AS-72 browser secrets | — | UA (no token storage or readable-cookie access in W03 code, relative URLs); UN2 (one ref-counted connection per page) | — | — |
| AS-73 text and money | — | UC1 (integer subtotal, multi-currency list); UN1 (HTML in title shown as text); UL | — | — |
| AS-74 accessibility baseline | — | — | all `VC`, `VK`, `VO`, `VN` states (axe serious/critical = 0, no horizontal scroll at 320 px, 44 px targets at mobile) | — |
| AS-75 analytics | — | UE (`add_to_cart` and `checkout_step` props exactly as FR-090, none under a privacy signal); UC3 | — | S39 AS-01 |
