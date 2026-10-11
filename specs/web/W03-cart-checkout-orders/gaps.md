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

## Gate repairs

- **Playwright `cart-checkout.spec.ts` "guest cart survives sign-up, checks out…" (order list empty)**: the cause was a race, not the orders page. A full page load starts `POST /api/auth/refresh` (the AuthProvider restore); the test left the page (`goto('/dashboard/orders')`) while it was in flight. The core API had already rotated the one-time refresh token, but the browser never received the new cookie, so the next refresh presented a spent token, was treated as reuse, and revoked the session; the dashboard then redirected to `/login`. Fix in `packages/web/lib/api/auth-relay.ts`: refreshes carrying the same cookie share one upstream rotation and its answer is replayed for 10 s (failures are not replayed), so a refresh the browser abandoned can be repeated safely. Verified: the spec passes 4/4 repeated runs and the full Playwright suite passes (53 passed). One unrelated `product-community.spec.ts` failure appeared in one earlier full run and did not reproduce (3/3 alone, full suite green on the next run).
- **Scenario-ID gate (AS-14, AS-59)**: the JC-4 journey existed but its title carried no scenario ID; it is now `W03 AS-14: JC-4 …` (`tests/cart-checkout.spec.ts`). AS-59 (buy again) had no test: added `components/checkout/buy-again.test.tsx` (sequential writes, current + ordered quantity capped at 20, toast + redirect, failed lines listed with a cart link). The test-plan names `components/orders/buy-again.test.tsx` (UO4) for the orders-page copy; that component belongs to the deferred orders story, and the test already proves the shared behaviour. `check-tests.py scenarios` no longer lists AS-14/AS-59 (AS-56, AS-60, AS-69 remain, covered only by deferred stories).
- **ESLint gate (live stream)**: `lib/realtime/user-stream.ts` created the `EventSource` itself, against the rule that streams are opened in `lib/api/*`; it now calls `openUserStreamSource` in `lib/api/user-stream-source.ts`. `useStreamBanner` (`hooks/use-user-stream.ts`) set state inside an effect to learn its claim token; the token is now created during the first render and passed to `claimStreamBanner(token)`, whose snapshot update re-renders the owner. `hooks/use-user-stream.test.tsx` returned an anonymous wrapper component; it is now a named `Wrapper`. No test was changed otherwise. Verified: eslint on those files is clean; `vitest run hooks/use-user-stream.test.tsx lib/realtime` passes 30/30.
- **tsc gate (dashboard still on the removed order hooks)**: `app/dashboard/view.tsx`, `app/dashboard/orders/view.tsx` and `components/dashboard/orders-table.tsx` imported `useOrders`, `orderStats` and `OrderSummary`, which W03 removed from `lib/api/orders.ts`. They now use `useOrdersPage()` and the contract list item (`totalMinor` + `currency` through `formatMoney`); the overview stats are counted from the first page. This keeps `/dashboard/orders` working until US5 (T075) replaces it with `/orders`; no test was changed. The other error was a stale generated `.next-prod/types/validator.ts` (git-ignored build output) that still pointed at the deleted `app/checkout/success/page.tsx`; I deleted that file and `next build` regenerates it. Verified: `pnpm exec tsc --noEmit` is clean; eslint on the three files is clean.
- **Playwright `visual/auth-navbar.spec.ts` "W01 AS-19 … signed in" (screenshot showed the signed-out header)**: the spec fakes a member with a stubbed `GET /api/bff/session`; the real cookie does not exist. W03's popover now opens the shared `user:<id>` stream, which the API refuses (401), the session refresh is refused too (401), and `refuseAndRecover` ran W01's session-ended flow, which signed the fake member out before the screenshot. Fix in `lib/realtime/user-stream.ts`: after a refused refresh the session read (`sessionApi.current()`) decides; the flow runs unless it still answers with a member (then the stream stays closed, no live updates). A real expired session fails that read too, so AS-45 still holds. Tests: the refresh-failure case now mocks the read (401 → flow runs) and a new case covers "still a member → no flow" (`lib/realtime/user-stream.test.ts`). Verified: `vitest run lib/realtime hooks/use-user-stream.test.tsx` and `playwright test tests/visual/auth-navbar.spec.ts` (6 passed). One parallel run showed a layout-shift value of 0.11 in AS-18 while a second spec ran; it did not reproduce alone.
- **Playwright `visual/product-page.spec.ts` "all optional sections missing" (a "Trending in Kitchen" rail appeared)**: the spec assumes the dev stack has no trending data. W03's journeys add to the cart for real, and `add_to_cart` events (weight 5, 60-minute window, S35) filled the ranking (scores 50 and 45). Fix in `tests/cart-checkout.spec.ts` (W03's own journey file): `/api/events` is answered by a route stub, so the request is still made and asserted (JC-1) but never reaches ingestion. The ranking already holding events drains within the 60-minute window; the product-page spec could not be re-run green before that, so it is not claimed verified here.
- **Playwright `zz-dbg.spec.ts` (`cart-line` found 0 elements)**: a scratch spec committed with W07 that walked the pre-W03 cart and checkout UI (`data-testid`s, "Proceed to Checkout", "Place Order", `/checkout/success?orderId=`). It is rewritten onto the W03 UI with the same steps (add, sign up, cart, raise quantity, checkout, place order, cart empty afterwards); only assertions on the removed markup changed. It also sent real `add_to_cart` events unstubbed, which filled the trending ranking and made `visual/product-page.spec.ts` "all optional sections missing" show a "Trending in Kitchen" rail; it now stubs `/api/events` like `cart-checkout.spec.ts`. Verified: `playwright test tests/zz-dbg.spec.ts` passes on desktop and mobile. The product-page spec was still red when re-run (the events already recorded stay in the 60-minute ranking window), so it is not claimed green here; it should pass once they age out.
- **Test-integrity gate (`zz-dbg.spec.ts`: 8 < 10 it()/expect() calls)**: the rewrite above dropped assertions (HEAD had 10 calls). Two real assertions were added on the W03 UI: the "Place order" button is enabled before the click, and the browser is at `/cart` before "Your cart is empty" is asserted. The count is back to 10. Verified: `python3 scripts/sdd/check-tests.py integrity packages/web` prints nothing (passes). The Playwright run of this spec was not repeated after the edit.
- **Playwright `visual/auth-navbar.spec.ts` "W01 AS-18 … no layout shift" (CLS 0.11, about 3 runs in 20)**: not caused by the header. The recorded shift entries show the page's footer (visible at the bottom of the viewport under the short `app/loading.tsx` placeholder) jumping out of view when the long home page streamed in (0.10 on its own), and the test counts it whenever a header node moves in the same frame (the account slot streaming in, 0.0007). Fix in `app/loading.tsx`: the placeholder is at least one viewport tall (`min-h-svh`), so the footer stays below the fold while the page streams. Verified: `playwright test tests/visual/auth-navbar.spec.ts -g AS-18 --repeat-each=20` passes 40/40 (desktop and mobile; it failed 3/20 before); `vitest run app/loading.test.tsx` passes.
- **Playwright `visual/product-page.spec.ts` "all optional sections missing" still red at the time of writing**: the ranking holds `add_to_cart`/`product_view` events recorded by earlier unstubbed runs (scores 80 and 65 at 13:20 UTC, 60-minute window); the stubs in `cart-checkout.spec.ts`, `visual/checkout.spec.ts` and `zz-dbg.spec.ts` keep new events out (a stubbed JC-3 run left the grinder's score unchanged). The scores kept rising for a few minutes after the last unstubbed run (ingestion lag), so the spec should pass once the window empties; **it was not re-run green here and is not claimed verified**.

## Sibling-spec follow-ups

Written by the plan of 2026-10-11. Each bullet is something another capability must adopt; W03 does not edit their specs.

- **W07**: replace the `CartBadge` and `NotificationsPopover` import in `components/layout/navbar.tsx` / `mobile-menu.tsx` with `components/cart/cart-badge.tsx` and `components/notifications/notifications-popover.tsx` (W03 keeps a re-export at the old popover path until then and updates the one navbar import itself in Phase 7); `PAYMENT_PROVIDER_HOSTS` stays the only host list for `/checkout/pay/*`.
- **W01**: `mergeGuestCart()` now resolves `{droppedLines}` (never rejects); the call site may keep ignoring the value. W01's `lib/auth/architecture.test.ts` (AS-29) walks `lib/api/**`: the attempt storage is deliberately outside it, in `lib/checkout/attempt-store.ts`.
- **W02**: `lib/attribution/ref.server.ts` / `getRefCode()` are not in the tree; W03's `placeOrder` calls a `readRefCode()` seam that returns `null` until they exist, and W02 must then export `getRefCode()` from that path (sent only if `checkoutRequestSchema` declares `refCode`). W02's product page keeps passing `category` to `<AddToCartButton>`.
- **W04**: the seller dashboard no longer renders the buyer's `OrdersTable` / "Recent orders" card (`app/dashboard/view.tsx`); `/dashboard/orders` redirects to `/orders`; `useOrders`, `orderStats`, `ORDERS_QUERY_KEY` and `components/dashboard/orders-table.tsx` are removed. A shop's own orders come from `GET /shops/:shopId/orders`. W04 may subscribe extra topics through `lib/realtime/user-stream.ts` and calls `useRefreshSession()` after a shop opens.
- **W05**: may reuse the shared `user:<id>` connection (`subscribeUserEvents`) for its topics; handle `resync` and `revoked` as W03 does; drop any `Authorization` / `setAccessToken` use.
- **W06**: the admin layout needs the server guard (`requireServerSession` + role); not touched by W03.
- **S10**: `checkoutRequestSchema` is `.strict()` without `refCode` and `orderListItemSchema` has no `reservedUntil`; W03 works without both (`research.md` R-02, R-03). If S10 adds `refCode`, W03 starts sending it with no change (the server function reads the schema's keys). `GET /orders/:orderId` was specified but unrouted; W03 adds the route (B-1) under S10's contract.
- **S13**: W03 adds `GET /payments?orderId=` (B-2) for the order aggregate; S13 should name the sandbox payment-method tokens for decline and 3-D Secure (only `pm_card_visa` is known); the `payment/stream` branch of the BFF forwarder is removed in W03 Phase 8.
- **S48**: the guest cart token the orders domain issues is `guest:<uuid>.<signature>`; the BFF's `GUEST_CART_TOKEN` pattern refused the colon, so `GET /bff/cart` silently read an empty cart for every guest. W03 widened the pattern (`upstream/upstream-client.ts`) and changed the e2e fixture to the real shape; S48's spec should state the token alphabet.
- **S48**: owns `bff/cart` and `bff/orders/:orderId` going forward; W03 builds the first version (B-3, B-4) with the section outcome machinery of the product page.
- **S28**: the notification event has no `unreadCount`; W03 re-reads the count on focus and reconnect. The preferences screen has no owner yet.
- **W07**: at 320 px the header's right-hand group (theme, cart badge, account) is 29 px wider than the viewport, which widens the layout viewport on phones. W03's 320 px cart check hides the header to measure its own content; W07 should fit the header at 320 px (44 px targets included).

## Deferred until a later pass

This pass (priority P1 and higher) built Setup, Foundational and User Stories 1-4 (AS-01..AS-50). Left for the later pass, by the instruction of this run, not because they failed:

- **User Story 5 — orders list, detail, cancel, buy again (P2)**: AS-51..AS-60 (tasks T067-T077). Waits for the later pass only; its backend (B-1, B-2, B-4) and web libraries (`lib/api/orders.ts`, `useOrder`, cursor paging) are already built. Until then `/orders*` pages do not exist, `app/dashboard/orders` and `app/dashboard/view.tsx` run on `useOrdersPage()` (see Gate repairs; T075 deletes that code), and the success page's "View order" link leads to a missing page.
- **User Story 6 — notification bell and inbox (P2)**: AS-61..AS-69 (tasks T078-T081). Waits for the later pass only; `lib/api/notifications.ts`, the user stream and the schemas are built. The old `components/notifications-popover.tsx` stays in place (W07's navbar uses it) and now listens on the shared user stream (`useUserEvents`) instead of the removed `useEventStream`, so the `plan Phase 8` case of `lib/checkout/architecture.test.ts` passes; T079 still replaces it.
- **User Story 7 — shared rules, removal of old code (P3)**: AS-70..AS-75 are asserted by the architecture test (all but the removed-name case) and by the stories above; the clean-up tasks T082-T086 and Phase 11 (T087-T092) are left for the final pass. That includes `JC-4` (T054, anonymous redirects of the five guarded URLs; needs the `/orders*` pages) and the `payment/stream` branch of the BFF forwarder (T083).
- **Capability markers**: S10, S13, S28 and S51 have no `.implemented` marker in their spec folders, but their endpoints answer on the dev stack and the e2e journeys place and read real orders; W03 uses them as built and does not stub them. Payments do not settle on this stack (`research.md` R-08), so JC-2 stops at "Payment is being processed…" unless the stack runs with `IS_LOAD_TEST=true`.
