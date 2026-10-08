# Gaps: current code vs W03 spec

Files in scope: `packages/web/app/cart/page.tsx`, `app/checkout/page.tsx`, `app/checkout/success/page.tsx`, `app/dashboard/orders/{page,view}.tsx`, `app/dashboard/view.tsx` (uses the orders hook), `components/{add-to-cart-button,notifications-popover}.tsx`, `components/dashboard/orders-table.tsx`, `components/layout/navbar.tsx` (W07's frame, W03's badge and popover), `lib/api/{cart,orders,client,sse,errors}.ts`, `lib/{query-keys,utils,providers}.ts`, `hooks/{use-auth,use-event-stream}`, `tests/{cart-checkout.spec.ts,helpers.ts}`, `vitest.config.ts`, `playwright.config.ts`, `package.json`. Line numbers refer to the files as read on 2026-10-07. This is the implementation agent's to-do list; the order of work is at the end. Nothing was changed while writing this spec.

## A. Data flow and constitution VI

| # | Gap | Where | Spec |
|---|---|---|---|
| A1 | Network calls inside a page component: `apiClient.post('/api/checkout', …)` | `app/checkout/page.tsx:47` | FR-011, FR-055, AS-71 |
| A2 | The whole cart, checkout and orders pages are client components with client-side data and guards; no static shell, no server guard | `app/cart/page.tsx:1`, `app/checkout/page.tsx:1,40-42`, `app/dashboard/orders/page.tsx:3-4` (`instant = false`) | FR-010, FR-052, AS-14, AS-70 |
| A3 | One product request per cart line from the browser (N+1) | `lib/api/cart.ts:44-58` | FR-001, `[BREAKING]` aggregate (see I1) |
| A4 | Query keys duplicated outside `lib/query-keys.ts` (`CART_QUERY_KEY`, `ORDERS_QUERY_KEY`) and the cart key mixes in the user id | `lib/api/cart.ts:20,75`, `lib/api/orders.ts:16,33`, `lib/query-keys.ts:9-14` | FR-055, AS-71 |
| A5 | Responses typed by hand-written interfaces, none parsed with contract schemas (`packages/contracts` has no source) | `lib/api/cart.ts:9-17`, `lib/api/orders.ts:8-13`, `app/checkout/page.tsx:17-23` | FR-055, `packages/contracts` (T9) |
| A6 | Absolute API base and a bearer token set from JavaScript | `lib/api/client.ts:3,13-24,48-51` | AS-72 (W01 removes the token; W03 uses relative same-origin URLs only) |
| A7 | `useCart` waits for `useAuth().isLoading` and keys by user id to dodge a race the cookie session no longer has | `lib/api/cart.ts:72-76` | `[BREAKING]` cart query ownership |
| A8 | Global stale time (60 s) for everything, including cart and order status | `lib/providers.tsx:15-18` | FR-057 |
| A9 | No static guard against `fetch`/`axios` in components, new Context or store, `use cache` on member pages | `eslint.config.mjs` | AS-70, AS-71, AS-72 (`lib/architecture.test.ts`) |

## B. Cart

| # | Gap | Where | Spec |
|---|---|---|---|
| B1 | Money formatted with the USD default from cents (`formatMoney(item.product.price)`), no currency anywhere | `app/cart/page.tsx:97-98,115`, `lib/utils.ts:7-17` | AS-73, FR-007 (W02 makes `currency` required) |
| B2 | Stock gate uses the product's exact `quantity` | `app/cart/page.tsx:90` | AS-06 (checkout is the stock authority) |
| B3 | **−** at quantity 1 deletes the line; **Remove** has no undo | `lib/api/cart.ts:41` (`nextQuantity`), `app/cart/page.tsx:23-24,70-77` | AS-05, AS-06 |
| B4 | No optimistic update, no per-product ordering of writes, no rollback; the response replaces the cache only after another N product requests | `lib/api/cart.ts:79-85` | AS-04, FR-002 |
| B5 | Lines not grouped by shop; no shop names; no product image; no "out of stock" label; `product: null` always reads "Product no longer available", even when the product request merely failed | `app/cart/page.tsx:57-68`, `lib/api/cart.ts:50-55` | AS-03, AS-08, AS-09, FR-006 |
| B6 | No partial or error recovery besides "Please refresh"; no skeleton; no `role="status"` or `role="alert"` | `app/cart/page.tsx:34-38` | AS-09, AS-74 |
| B7 | Guest sees **Proceed to Checkout** that redirects after a loading flash; no "Sign in to check out" | `app/cart/page.tsx:121-123`, `app/checkout/page.tsx:40-42` | AS-10 |
| B8 | `mergeGuestCart` returns nothing; `droppedLines` is lost, so a capped merge is silent | `lib/api/cart.ts:66-69` | AS-11, FR-004 |
| B9 | Quantity control has no label, no numeric field, buttons are 32 px, `data-testid` hooks instead of roles | `app/cart/page.tsx:80-94,86` | AS-06, AS-74 (44 px targets) |
| B10 | Layout is one `lg:grid-cols-3` with a table that overflows at mobile; no bottom bar | `app/cart/page.tsx:46-103` | FR-040 |
| B11 | `AddToCartButton` has no `category`, no `track('add_to_cart')`, no **View cart** action, label says "Adding..." with three dots, and shows "Out of stock" only through the `disabled` prop | `components/add-to-cart-button.tsx:11-35` | AS-02, FR-003, FR-090, W02 FR-057 |
| B12 | Navbar cart badge is the literal `0` and the mobile menu has no count | `components/layout/navbar.tsx:109-120` | AS-13, FR-005 (W07 mounts `<CartBadge />`) |

## C. Checkout

| # | Gap | Where | Spec |
|---|---|---|---|
| C1 | Idempotency key fixed per page mount, lost on reload, never rotated after a final outcome; body `{}` (no `expectedTotalMinor`) | `app/checkout/page.tsx:36,47` | AS-19, AS-20, FR-012, FR-020, FR-021 |
| C2 | Every failure becomes one toast through `apiErrorMessage` (reads `detail` from the body, shows it raw) | `app/checkout/page.tsx:50-52`, `lib/api/errors.ts:6-17` | FR-081, FR-082, AS-22 to AS-31 (W01's `problemFromError`) |
| C3 | No handling of `price_changed`, `out_of_stock`, `product_unavailable`, `mixed_currency`, `cart_empty`, `checkout_in_progress`, `idempotency_in_flight`, `rate_limited`, `checkout_unavailable` | `app/checkout/page.tsx:44-54` | AS-22 to AS-30 |
| C4 | Double-press guard is the `submitting` flag only; Enter-key and reload are not covered; no offline state | `app/checkout/page.tsx:44-54,97-99` | AS-18, AS-20, AS-33 |
| C5 | Total shown is a client sum in USD cents; lines with `product: null` silently omitted | `app/checkout/page.tsx:70-93` | AS-15, FR-007, B1 |
| C6 | Guard is a client `useEffect` redirect using `returnUrl` and renders "Loading checkout…" first | `app/checkout/page.tsx:40-42,58-60` | AS-14, FR-010 (W01: `returnTo`) |
| C7 | Referral code never read or sent | `app/checkout/page.tsx` (absent) | AS-34, FR-011 |
| C8 | No progress indicator, no grouping by shop, no analytics (`checkout_step`) | `app/checkout/page.tsx:63-105` | AS-15, FR-090 |
| C9 | The flow ends at a `RESERVED` order: no pay step exists anywhere in `packages/web` (`grep` for `payments` finds nothing) | `app/checkout/` | AS-35 to AS-47 (new `/checkout/pay/{orderId}`, hosted fields, 3-D Secure, live status) |

## D. Success page

| # | Gap | Where | Spec |
|---|---|---|---|
| D1 | Always says "Order Confirmed! Thank you for your purchase." regardless of the order's status | `app/checkout/success/page.tsx:25-31` | AS-48, AS-49, SC-003 |
| D2 | The order number is the raw `orderId` query parameter, unchecked, "UNKNOWN" when missing, readable by anyone | `app/checkout/success/page.tsx:12-15` | AS-50, FR-010 |
| D3 | Promises an email confirmation without any knowledge of payment | `app/checkout/success/page.tsx:35-37` | AS-48 |
| D4 | No live status, no order read, no focus management, no `View order` link to a detail page | `app/checkout/success/page.tsx` | AS-48, AS-74 |

## E. Order history and detail

| # | Gap | Where | Spec |
|---|---|---|---|
| E1 | History lives in the dashboard shell and reads a bare array (`GET /api/orders` → `OrderSummary[]`); no `nextCursor`, so more than one page is unreachable | `app/dashboard/orders/view.tsx:8`, `lib/api/orders.ts:33-35` | AS-51, AS-53, FR-053, `[BREAKING]` |
| E2 | `total: number \| string` "cents (NUMERIC arrives as a string)" with the USD default; no `currency`; status shown as the raw enum | `lib/api/orders.ts:12`, `components/dashboard/orders-table.tsx:33-36,41` | AS-51, FR-060 |
| E3 | `isCancellable` includes `PENDING`; **Cancel** has no confirmation and no problem forms (`409 order_not_cancellable`, `404`, `429`) | `lib/api/orders.ts:19`, `components/dashboard/orders-table.tsx:38-52` | AS-54, FR-061 |
| E4 | No order detail page: no timeline, items, shop slices, payment panel, **Pay now**, **Buy these items again** | `app/` (absent) | AS-55, AS-56, AS-59 |
| E5 | Table only: overflows at mobile, no caption, date by `toLocaleDateString()` | `components/dashboard/orders-table.tsx:21-60` | FR-044 |
| E6 | No live status (`order.status`), no empty/error recovery beyond text | `app/dashboard/orders/view.tsx:19-26` | AS-52, AS-58 |
| E7 | `OrdersTable` and `orderStats` also feed the dashboard home | `app/dashboard/view.tsx:7,9,13-14,48-55` | `[CONTRACT]` W04 |
| E8 | `/dashboard/orders` is the only URL; S28 links point at `/orders/<id>` | `app/dashboard/orders/page.tsx` | AS-60, FR-065 |

## F. Notification popover and live stream

| # | Gap | Where | Spec |
|---|---|---|---|
| F1 | Subscribes to topic `'notifications'`; S51's topic is `user:<id>` | `components/notifications-popover.tsx:33` | AS-66, FR-050 |
| F2 | Never loads the inbox or the unread count; state is a local `useState` list that is empty after every reload; "Mark all read" is local only | `components/notifications-popover.tsx:23-40` | AS-61 to AS-64, AS-71 |
| F3 | Event shape assumed `{id, message, createdAt, read}`; S28's is `{id, type, category, title, body, link, unread, createdAt}` | `components/notifications-popover.tsx:15-20,87` | AS-62, AS-66 |
| F4 | Items are not links; `link` is ignored; no unsafe-link rule | `components/notifications-popover.tsx:80-95` | AS-63, FR-064 |
| F5 | Trigger button has no accessible name or count in its name; badge is shown at any count | `components/notifications-popover.tsx:44-55` | AS-61 |
| F6 | No loading, empty-with-error, retry or paging; no live announcement | `components/notifications-popover.tsx:69-102` | AS-62, AS-65, AS-66, AS-67 |
| F7 | `EventSource` URL is absolute (`NEXT_PUBLIC_SSE_URL`); `onerror` only logs; no `resync`, `revoked` or recreate-after-401 handling; no ref-counting, so two components would open two connections | `lib/api/sse.ts:6,24-32`, `hooks/use-event-stream.ts:6-21` | AS-45, AS-68, AS-72, FR-050 |
| F8 | `useEventStream` re-subscribes whenever `onEvent` changes and joins `topics` strings in its dependency list | `hooks/use-event-stream.ts:19` | FR-050 (`subscribeUserEvents`) |
| F9 | Popover width fixed at `w-80`; no mobile rule | `components/notifications-popover.tsx:57` | AS-69 |

## G. Cross-cutting and tests

| # | Gap | Where | Spec |
|---|---|---|---|
| G1 | Existing journey ends by cancelling a `RESERVED` order and asserts `data-testid`s that go away | `tests/cart-checkout.spec.ts:7-45` | test-plan JC, JO, JN |
| G2 | `register(page)` waits for the home page and `login` uses `returnUrl` (W01 changes both) | `tests/helpers.ts:15-37` | W01 contract |
| G3 | Existing unit tests cover `cartTotals`, `nextQuantity`, `orderStats` and the order hooks that this spec removes or rewrites | `lib/api/cart.test.ts`, `lib/api/orders.test.ts` | test-plan UC5 |
| G4 | No error boundary, `loading` skeleton, not-found for the W03 routes | `app/cart`, `app/checkout`, `app/dashboard/orders` (no `loading.tsx`, `error.tsx`, `not-found.tsx`) | AS-09, AS-52, AS-57 (W07 provides the global ones) |

## H. Missing backend endpoints and contract changes the UI needs

| # | Need | Owner (constitution IX.7) | Why |
|---|---|---|---|
| H1 | `GET /api/bff/cart` → `cartPageResponseSchema` (lines + product + shop, partial `errors[]`, anonymous allowed) | **S48** (`libs/composition/bff`), **R2** | replaces N product requests; cart screen combines orders (S10), catalog (S05) and tenancy (S03) |
| H2 | `GET /api/bff/orders/{orderId}` → `orderPageResponseSchema` (order + latest payment, `errors[]`) | **S48**, **R2** | order detail and pay step combine orders (S10) and payments (S13 `GET /payments?orderId`) |
| H3 | Forward the guest `cart` cookie and its `Set-Cookie` on cart routes; forward `GET /api/streams` unbuffered | **S48** (with **W01**'s C-FWD) | today's forwarding strips cookies, which empties every guest cart |
| H4 | Optional `refCode` in `checkoutRequestSchema` | **S10** | W02 AS-63: the order must carry the referral code |
| H5 | `reservedUntil` on the order list item | **S10** | hide **Pay now** for expired holds |
| H6 | Read-only priced preview `GET /checkout/preview` | **S10** (reuses the checkout pricing path, no reservation) | show the true total incl. seller discounts; otherwise the estimate triggers `price_changed` whenever a discount applies |
| H7 | Names of the fake provider's test payment methods for success, decline, action required | **S13** | sandbox card picker and journeys |
| H8 | `packages/contracts` source with the schemas named in `spec.md` | **S54 / contracts** | constitution V.2; the package has only `moon.yml` and `package.json` |
| H9 | Event field `unreadCount` on `notification` | **S28** (nice to have) | avoids one extra read; optional |
| H10 | Entitlement read per order line for digital downloads | **S31** (deferred) | "My purchases → Download" |

## I. Test tooling

| # | Gap | Where | Needed |
|---|---|---|---|
| T1 | React Testing Library, `@testing-library/user-event`, `@testing-library/jest-dom` and `@vitejs/plugin-react` are not installed | `package.json` devDependencies | add; set `setupFiles` with jest-dom matchers and `cleanup` |
| T2 | MSW not installed | `package.json` | add `msw`; shared handlers with problem+json fixtures in `tests/msw/` |
| T3 | Vitest `include` covers only `lib/**/*.test.ts` and `hooks/**/*.test.ts` | `vitest.config.ts:7` | add `components/**/*.test.{ts,tsx}` and `app/**/*.test.{ts,tsx}`; `esbuild.jsx: 'automatic'` or the React plugin |
| T4 | No Playwright visual project, no screenshot baselines, no axe | `playwright.config.ts` | add a `tests/visual` project (390 × 844 and 1280 × 800), `@axe-core/playwright`, `expect.toHaveScreenshot` config, `reducedMotion: 'reduce'` |
| T5 | No `EventSource` and hosted-field stubs for jsdom | — | `tests/stubs/event-source.ts`, `tests/stubs/payment-fields.tsx` |
| T6 | No helper to pay in a journey and no way to read a sent notification | `tests/helpers.ts` | `payWithSandboxCard(page)`, `bellCount(page)` |
| T7 | No sandbox card picker and no flag | `components/checkout/` (absent) | `NEXT_PUBLIC_PAYMENTS_SANDBOX`; compiled out of production builds |
| T8 | No architecture test | — | `lib/architecture.test.ts` (reads source files; see test-plan) |
| T9 | Server-component pages cannot be rendered in jsdom today | — | page tests call the async page function with mocked `requireServerSession`/data modules and render the returned tree |
| T10 | `next build` as a gate for Cache Components validation of the new pages | CI | run in the SDD gate |

## Order of work

1. Tooling T1–T5 and T8 (nothing else can be tested before it), `packages/contracts` schemas (H8).
2. W01 prerequisites (`requireServerSession`, `loginHref`, `problemFromError`, `<ProblemAlert />`, session-ended flow) and S48 aggregates H1–H3 (until they exist, MSW fixtures stand in).
3. `lib/query-keys.ts`, `lib/api/{cart,checkout,orders,payments,notifications}.ts`, `lib/realtime/user-stream.ts`.
4. Cart (page, line, badge, add-to-cart), then checkout review and the order function, then the pay step and success page, then history and detail, then the popover.
5. Redirect `/dashboard/orders`, remove the old components and tests, update W04's dashboard usage.
6. Journeys JC, JO, JN; visual baselines.
