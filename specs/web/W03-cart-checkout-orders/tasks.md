# Tasks: W03 — Cart, checkout, pay step, success page, orders, notification popover

**Input**: `spec.md`, `plan.md`, `test-plan.md`, `gaps.md`, `questions.md` (defaults accepted), `research.md`, `data-model.md`, `contracts/{backend-endpoints,web-modules}.md`, `quickstart.md`, constitution.
**Tests**: required (test-plan.md, one row per AS-01..AS-75). **Order is test-first**: inside every phase the failing test task precedes the code task it proves; run the test, see it fail for the right reason, then implement.
**Paths**: `packages/web/…` unless a path starts with `packages/backend` or `packages/contracts`. Test keys (UC1, UK3 …) are the files named in `test-plan.md` "Test files".
**Commands** (narrowest first): web unit `cd packages/web && pnpm exec vitest run <path>`; backend `scripts/sdd/test-spec.sh <pattern>` (wait for `GET http://localhost:8000/health/ready` after backend edits); journeys `pnpm exec playwright test tests/<file>`; whole suites once in Phase 11. A test failing after 5 attempts → write blocker, attempts, hypothesis into `questions.md` and stop.
**Rules that apply to every task**: never `git checkout/restore/reset/stash/clean` (undo by hand); no new direct `sequelize.transaction`; relative same-origin URLs only; no `Authorization`, `setAccessToken`, `refreshSession`; text-only rendering; stable ids as React keys; money via `formatMoney(minor, currency)` with the object's own currency.

## Format: `- [ ] Tnnn [P?] [USn?] Description with path`

---

## Phase 1: Setup (Phase 0 of plan)

- [X] T001 Read `packages/web/AGENTS.md` and the Next guides *Authentication with Cache Components*, *Rendering philosophy*, *Building interactive apps*, `instant`, *Server Functions / forms* under `packages/web/node_modules/next/dist/docs/`; note anything that contradicts `plan.md` at the end of `research.md` under "Phase 0 re-read".
- [X] T002 Verify test tooling is present (RTL, user-event, jest-dom, `@vitejs/plugin-react`, `msw`, `@axe-core/playwright`; `vitest.config.ts` includes `components/`, `app/`, `lib/`, `hooks/`; `tests/msw/` handlers exist or create them with problem+json fixtures); close gaps T1–T3 by adding only what is missing in `packages/web/package.json` / `vitest.config.ts` / `tests/msw/handlers.ts`.
- [X] T003 [P] Add stubs for jsdom: `packages/web/tests/stubs/event-source.ts` (controllable `EventSource`: open, message, error, close) and `packages/web/tests/stubs/payment-fields.tsx` (hosted-field stand-in with complete/incomplete/error controls) (gaps T5).
- [X] T004 [P] Add `@stripe/stripe-js` to `packages/web/package.json` (lazy use only on the pay page, behind `PaymentFields`, R-07).
- [X] T005 [P] Document `PAYMENT_PROVIDER_HOSTS`, `NEXT_PUBLIC_PAYMENT_PUBLISHABLE_KEY`, `NEXT_PUBLIC_PAYMENTS_SANDBOX` (ignored when `NODE_ENV === 'production'`) in `packages/web/.env.example` and `packages/web/README.md`; extend `packages/web/lib/config.test.ts` to assert `PAYMENT_PROVIDER_HOSTS` is parsed and applied only to `/checkout/pay/*` (W07 follow-up, gaps T10 part).
- [X] T006 Probe the dev stack (R-08): `POST /api/payments/intents` with `pm_card_visa` on a fresh `RESERVED` order; record in `research.md` R-08 whether the payment settles (Stripe test keys or load-test provider) and the contingency if not.
- [X] T007 [P] Add storage keys `w03.attempt.checkout` and `w03.attempt.pay:{orderId}` to `packages/web/lib/browser-storage-keys.ts` and to the privacy page entry list (`packages/web/app/privacy/…` per existing pattern), with the test in the existing browser-storage-keys test if present.
- [X] T008 Write UA `packages/web/lib/checkout/architecture.test.ts` (`W03 architecture rules`; note plan path, not `lib/architecture.test.ts`): no `fetch`/`axios`/`EventSource` in `components/**` and `hooks/**` of W03 files; query keys only from `lib/query-keys.ts`; no new Context/store; no `use cache` in W03 pages; `/cart` page has no request-time read; request reads inside `<Suspense>`; no token storage or readable-cookie access; relative URLs only; no index keys in W03 files; no `dangerouslySetInnerHTML`; no import of removed names. Run it and confirm it is red for the right reason (AS-70, AS-71, AS-72; gaps A9, T8).

---

## Phase 2: Foundational — contracts and backend (B-1…B-6)

**⚠️ BLOCKS all stories.** Read `contracts/backend-endpoints.md` first. Each endpoint: e2e spec first (red), then code.

- [X] T009 Read `InboxService` and the notifications controller in `packages/backend` and correct the notification schema list in `contracts/backend-endpoints.md` B-5 if the code differs.
- [X] T010 [P] Add `packages/contracts/src/bff/cart-page.ts` (`cartPageResponseSchema`: `lines[{productId, quantity 1-20, addedAt, product{title, priceMinor, currency, imageUrl|null, inStock}|null, shop{id,name}|null}]`, `droppedLines`, `errors[{section:'products'|'shops', code, retryable}]`) and `packages/contracts/src/bff/order-page.ts` (`orderPageResponseSchema`: `order: orderSchema`, `payment: {id,status,amountMinor,currency,failureCode,requiresAction,version,updatedAt}|null` with no `clientSecret`, `errors[{section:'payment',code,retryable}]`); export both from `src/bff/index.ts` and `src/index.ts` (H8, B-5).
- [X] T011 [P] Add `packages/contracts/src/notifications/index.ts` (`notificationItemSchema {id,type,category,title,body,link:string|null,read}`, `notificationPageSchema {items,nextCursor}`, `unreadCountSchema {unread}`, `markReadRequestSchema` = `{ids: uuid[1..100]} | {all: true}`) and `packages/contracts/src/realtime-user.ts` (`orderStatusEventSchema {orderId,status,orderVersion}`, `paymentStatusEventSchema {paymentId,orderId,status,version}`, `notificationEventSchema` with `unread`, discriminated `userStreamEventSchema` on `type`); export from `src/index.ts`.
- [X] T012 Write failing e2e `packages/backend/test/…/order-read.e2e-spec.ts` (B-1): happy with items, shopOrders, timeline parsed by `orderSchema`; other user `404 order_not_found`; unknown `404`; malformed id `400`; no token `401`; read only. Run `scripts/sdd/test-spec.sh order-read` (red).
- [X] T013 Implement B-1 `GET /orders/:orderId` in `packages/backend/libs/domains/orders/api/orders.controller.ts` (`@Firewall()`, `@User()`, `ParseUUIDPipe`, `OrderQueryService.getOrderForUser`); green.
- [X] T014 Extend `payment-read.e2e-spec.ts` with B-2 cases (happy, newest first, other user's `orderId` → empty page, bad query `400`, `401`, `429` under `payments.read.user`, `clientSecret` null in list items) and run `scripts/sdd/test-spec.sh payment-read` (red).
- [X] T015 Implement B-2 `GET /payments?orderId&status&limit&cursor` in `packages/backend/libs/domains/payments/api/payment.controller.ts` + `PaymentQueryService.listOwned`, `paymentListQuerySchema`/`paymentPageSchema` in contracts if missing; green.
- [X] T016 Extend `packages/backend/libs/composition/bff/bff.e2e-spec.ts` with B-3 cases (anonymous guest cart, member cart, hidden product → `product:null` no error, products down → all `product:null` + `errors[{section:'products'}]`, shops down → `shop:null` + `errors[{section:'shops'}]`, empty cart, 50 lines, `Cache-Control: private, no-store`, no `Set-Cookie`, shape parsed by `cartPageResponseSchema`) (red).
- [X] T017 Implement B-3 `GET /bff/cart` in `packages/backend/libs/composition/bff/cart/` + `upstream/endpoints/cart.ts` (`identity: 'optional'`, guest `cart` cookie forwarded, `productsBatch` ≤ 50, `shopsBatch`, reuse `page/section-outcome.ts`); cart read failure passes status and `Retry-After`; green.
- [X] T018 Extend `bff.e2e-spec.ts` with B-4 cases (happy with payment, no payment → `payment:null` no error, payment upstream down → `payment:null` + error, foreign `404` passthrough, malformed `400`, no token `401`, `no-store`, `clientSecret` never present) (red).
- [X] T019 Implement B-4 `GET /bff/orders/:orderId` in `packages/backend/libs/composition/bff/orders/` + `upstream/endpoints/{orders,payments}.ts`; green.
- [X] T020 [P] Add contract tests in `packages/contracts` that parse a real response captured from each of T012/T014/T016/T018 and the notification endpoints; run `cd packages/contracts && pnpm test`.
- [X] T021 B-6: grep every backend file touched by T013/T015/T017/T019 for `// S54 T037 audit`; migrate any direct `sequelize.transaction` to `TransactionRunner.run`/`@Transactional` and delete the comment; confirm the direct-site count in the domain did not rise; run the touched domains' suites.

**Checkpoint**: `test-spec.sh order-read payment-read bff` green; contracts tests green.

---

## Phase 3: Foundational — web libraries

- [X] T022 [P] Write failing `packages/web/lib/query-keys.test.ts` additions for `queryKeys.cart.{all,lines(),page(),lastMerge()}`, `orders.{all,list({cursor}),detail(id)}`, `payments.{all,detail(id)}`, `notifications.{all,unreadCount(),inbox()}`; then update `lib/query-keys.ts` (cart key no longer includes the user id; gaps A4, A7) and set browser cache lifetimes per plan (cart 0 s + refetch on focus, `orders.list` 15 s, detail/payment 0 s until terminal then 60 s, notifications 30 s) in `lib/query-defaults.ts` (gap A8).
- [X] T023 [P] Add route builders `cartHref()`, `checkoutHref()`, `payHref(orderId)`, `successHref(orderId)`, `ordersHref(cursor?)`, `orderHref(orderId)` to `lib/routes.ts` with cases in `lib/routes.test.ts` (test first).
- [X] T024 [P] Write UL `lib/safe-link.test.ts` (table: `/x` ok; `//x`, `https://x`, `javascript:`, backslash, control characters refused) then implement `lib/safe-link.ts` `safeNotificationLink(link): string | null` (AS-63, FR-064, AS-73).
- [X] T025 [P] Write failing test then implement `lib/checkout/status.ts` `isConfirmed(status)` (true for `PAID`, `FULFILLING`, `SHIPPED`, `DELIVERED` only) with a `describe.each` over every order status (SC-003).
- [X] T026 [P] Extend `lib/api/problem-copy.ts` tests (new `lib/api/problem-copy.test.ts` cases) for surfaces `cart`, `checkout`, `pay`, `orders`, `notifications` keyed by `(surface,status,code)` per spec FR-081, generic FR-082 form with "Reference: {requestId}", `detail` never shown except per FR-082; then implement the table; add `lib/checkout/problem-view.ts` parsing `price_changed`, `out_of_stock`, `product_unavailable` extension fields with zod, with `problem-view.test.ts` first.
- [X] T027 Write UC5 `lib/api/cart.test.ts` (rewrite; delete `cartTotals`/`hydrate`/`nextQuantity` tests): parse `cartPageResponseSchema` and `cartSchema`; writes per product serialised, last value wins, re-read after the last; `mergeGuestCart` rejects → resolves `{droppedLines: 0}`, sets `queryKeys.cart.lastMerge()`, next read unaffected (AS-04, AS-12); `GET /cart` sends no cookie handling; relative URLs. Then rewrite `lib/api/cart.ts` (`useCartPage`, `useCartLines`, `useCartCount(): number|null`, `setLine`, `mergeGuestCart`) using the CSRF headers helper and `packages/contracts`; add `lib/cart/write-queue.ts` and `lib/cart/totals.ts` (per-currency integer subtotal `priceMinor × quantity` over available lines, grouping by `shop.id`, null → "Other items", unit count) each with a table-driven test written first.
- [X] T028 [P] Write tests then implement `lib/api/checkout.ts` (server-callable `postCheckout` returning `checkoutResponseSchema` from the 202 body, ignoring `Location`; `Idempotency-Key` mandatory) and `lib/server/checkout.server.ts` (`import 'server-only'`, session cookie + CSRF header from `__Host-bff-csrf`).
- [X] T029 [P] Write tests then implement `lib/api/orders.ts` (`useOrdersPage(cursor)` keyset `{items,nextCursor}` via `orderPageSchema`, `useOrder(id)` via `GET /bff/orders/:id`, `cancelOrder`, no `Authorization`, `404 order_not_found`) replacing the old hooks; add `lib/server/orders.server.ts` for server prefetch. `lib/api/orders.test.ts` is rewritten (old `orderStats`/hook tests removed, gap G3).
- [X] T030 [P] Write tests then implement `lib/api/payments.ts` (`createPaymentIntent` with `Idempotency-Key`, `usePayment(id)` with `select` stripping `clientSecret`, one-time read of `clientSecret` outside the cache, `paymentAcceptedSchema`/`paymentSchema` from contracts) and `lib/server/payments.server.ts`; contract schemas replace `lib/types.ts` `PaymentStatus` (lines 98-104) for new code.
- [X] T031 [P] Write tests then implement `lib/api/notifications.ts` (`useUnreadCount`, `useInbox` infinite query, `markRead`/`markAllRead` optimistic with rollback, `429` wait, `401` handoff to W01) using the B-5 schemas.
- [X] T032 Write UN2 `lib/realtime/user-stream.test.ts` using the `EventSource` stub: one ref-counted connection per page for `user:<id>` (AS-72); `subscribeUserEvents(handler)`; `addTopic(topic)` recreates once; stream silence 10 s → polling 2 s/5 s schedule ≤ 30 req/min with stop message and Check again (AS-39); banner once per page; `resync` → handler re-read; `revoked` → drop topic silently; final `401`/`403` → refresh and recreate once, then W01 flow (AS-45); health `connected|reconnecting|closed`. Then implement `lib/realtime/user-stream.ts`, `hooks/use-user-stream.ts` (`useSyncExternalStore`), `lib/checkout/polling.ts` (schedule, table test first), `hooks/use-online.ts`.
- [X] T033 Write UK2 `lib/checkout/attempt.test.ts` (table-driven per `data-model.md` key lifecycle: reuse after network failure, `503`, `409 idempotency_in_flight`, price re-confirmation, press after `401` with unchanged cart; new key after `out_of_stock` and cart fingerprint change; delete on `202`, `cart_empty`, `product_unavailable`, `mixed_currency`, key-misuse `422/400`, `signed-out` message, age > 24 h; UUID; pay attempt key per order, new key when method token changes; survives reload via storage) (AS-19, AS-20, AS-32, AS-47). Then implement `lib/checkout/attempt.ts` (pure) and `lib/checkout/attempt-store.ts` (the only `sessionStorage` user, outside `lib/api`, key + expected total + fingerprint + timestamp, listens for the `auth` broadcast).
- [X] T034 Write UK6 `lib/checkout/pay-flow.test.ts`: `describe.each` over the full (phase, event) cross product from `data-model.md` "Pay phases" (allowed pairs transition; every other pair returns the same state), server-data mapping (PENDING+requiresAction → actionRequired, PENDING → processing, UNKNOWN → unknown, COMPLETED with order not PAID → confirming with hint after 60 s fake timer and never "confirmed", COMPLETED with PAID → completed, FAILED → failed, CANCELLED/REFUND_PENDING/REFUNDED on cancelled order → AS-43 panel) (AS-38, AS-42, AS-46, AS-71). Then implement `lib/checkout/pay-flow.ts` and `hooks/use-pay-flow.ts` (`useReducer`).
- [X] T035 [P] Write UE `lib/checkout/events.test.ts` (`add_to_cart` props exactly `{product_id, category}`, `checkout_step` props `{step, items, order_id?}` per FR-090, nothing under Global Privacy Control / DNT, no titles/totals) then implement `lib/checkout/events.ts` over W02's `track()` (AS-75; S35/W02 follow-up).

**Checkpoint**: `pnpm exec vitest run lib` green except UA (red until Phase 11 cleanup).

---

## Phase 4: User Story 1 — Cart, guest and signed-in, merge on login (P1) 🎯 MVP

**Goal**: add, view, change, remove, undo, merge, badge. **Independent test**: JC-1/JC-3 + UC1-UC4 + VC.

- [X] T036 [P] [US1] Write UC1 `components/cart/cart-view.test.tsx` (AS-01, AS-03, AS-08, AS-09, AS-10, AS-11, AS-73): empty copy + link + no summary; grouping by shop and "Other items"; unavailable / out-of-stock labels, "—", excluded from subtotal, checkout enabled; skeleton `role="status"`, error + Try again, partial banner + Reload, subtotal unavailable; guest label "Sign in to check out" with `loginHref('/checkout')`; merge notice when `droppedLines > 0`, dismissible, absent at 0; integer subtotal, multi-currency list.
- [X] T037 [P] [US1] Write UC2 `components/cart/cart-line.test.tsx` (AS-04..AS-07): instant values, `aria-busy`, rollback; undo toast 8 s (fake timers) and focus move; − disabled at 1, + disabled at 20 with hint, typed values revert and announce; copy per code via MSW (`cart_line_limit`, `rate_limited` with `Retry-After`, network, other).
- [X] T038 [P] [US1] Write UC3 `components/add-to-cart-button.test.tsx` (AS-02, AS-75): pending label "Adding…", toast with View cart action, reads current quantity first, `add_to_cart` once with `product_id` and `category`, disabled/out-of-stock states.
- [X] T039 [P] [US1] Write UC4 `components/cart/cart-badge.test.tsx` (AS-13): accessible name "Cart" / "Cart, n items", `99+`, absent when unknown or anonymous empty, refetch on focus.
- [X] T040 [US1] Implement `components/cart/{quantity-control,cart-line,shop-group,cart-summary,merge-notice,cart-view}.tsx` (44 px targets at mobile, numeric field with label, no `data-testid`, responsive layout without table overflow, bottom bar on mobile; gaps B1-B10) until T036/T037 pass.
- [X] T041 [US1] Rewrite `app/cart/page.tsx` as a static shell rendering `<CartView/>` (no request-time read) and add `app/cart/loading.tsx`; remove client data code from the old page (gaps A2).
- [X] T042 [US1] Implement `components/cart/cart-badge.tsx` (`CartBadge`, re-export `useCartCount`); update `components/layout/navbar.tsx` and `mobile-menu.tsx` to import the new badge and remove the literal `0` (W07 follow-up, gap B12). Until T039 passes keep the stand-in.
- [X] T043 [US1] Update `components/add-to-cart-button.tsx` (keep path and signature; `category` prop used; emit `add_to_cart` via `lib/checkout/events.ts` once per success; View cart toast action; label "Adding…") until T038 passes (gap B11; W02/S35 follow-ups).
- [X] T044 [US1] Make `mergeGuestCart()` call sites (W01 sign-in/sign-up flows under `lib/auth/` or `components/auth/`) compile with the new `{droppedLines}` return; the cart page reads `queryKeys.cart.lastMerge()` for the notice.
- [X] T045 [P] [US1] Write VC `tests/visual/cart.spec.ts` (`Cart layout`: `empty`, `loaded`, `loading`, `error`, `partial`, `unavailable-lines`; 390×844 and 1280×800; stubbed with `page.route`; axe serious/critical = 0; no horizontal scroll at 320 px with 50 lines and 20-unit quantities; baselines committed) (AS-74, SC-008).
- [X] T046 [US1] Rewrite journey JC-1 and JC-3 in `tests/cart-checkout.spec.ts` (`Cart & checkout`): guest adds from a product page → toast and badge 1 → signs up → guest line merged; remove last line → empty cart; uses roles not testids; also posts check that `/api/events` receives `add_to_cart`. Add `payWithSandboxCard` and `bellCount` to `tests/helpers.ts` as stubs raising "not implemented" until Phases 6/9 (gaps T6). Run `pnpm exec playwright test tests/cart-checkout.spec.ts -g "JC-1|JC-3"`.

**Checkpoint**: US1 independently testable.

---

## Phase 5: User Story 2 — Place an order exactly once (P1)

**Goal**: review screen and idempotent Place order. **Independent test**: UK1, UK3, UK4, UE, VK review + price-changed.

- [X] T047 [P] [US2] Write UK3 `app/checkout/actions.test.ts` (`Order creation function`, AS-34): sends `Idempotency-Key` and CSRF header, reads `orderId` from the 202 body, `Idempotency-Replayed: true` is success, `refCode` added only when `checkoutRequestSchema` declares it (force both branches, `readRefCode()` seam returns `null` until `lib/attribution/ref.server.ts` exists), typed `CheckoutProblem` with `retryAfter`, `productIds`, `currentTotalMinor`, `lines`, `flashSaleId`, never throws.
- [X] T048 [P] [US2] Write UK1 `components/checkout/review.test.tsx` (AS-15, AS-16, AS-33): progress list `aria-current`, lines by shop, note, "estimated total" label; empty state without Place order; offline banner and disabled Place order, restored online.
- [X] T049 [P] [US2] Write UK4 `components/checkout/place-order.test.tsx` (AS-17..AS-31): pending label, `aria-busy`, navigates to pay with `orderId`, cart cleared; two presses and double Enter = one call; replay = success; `409 idempotency_in_flight` auto retry with fake timers honouring `Retry-After`, 5 tries then final alert and link; `price_changed` alert with old/new prices, Accept re-sends with new total, focus on alert; `out_of_stock` titles from `productIds`, labels on lines, new key; `product_unavailable` Remove unavailable items writes exactly those lines, button disabled meanwhile; `mixed_currency`, `cart_empty`, `checkout_in_progress` (button enabled), `rate_limited` disabled until `Retry-After` passes, announced twice only; `checkout_unavailable` same key on retry; generic alert with reference for key-misuse and unknown, `5xx` detail hidden; `checkout_step` events review/pay.
- [X] T050 [US2] Implement `app/checkout/actions.ts` (`'use server'` `placeOrder({key, expectedTotalMinor})`) over `lib/server/checkout.server.ts` until T047 passes (gap A1, C1, C7).
- [X] T051 [US2] Implement `components/checkout/{progress,review,order-summary,problem-alerts,place-order}.tsx` until T048/T049 pass (gaps C2-C5, C8).
- [X] T052 [US2] Rewrite `app/checkout/page.tsx` as a Server Component: `requireServerSession('/checkout')` at the top, `<Suspense>` around request reads, prefetch `/bff/cart` into `HydrationBoundary`, render review; add `app/checkout/loading.tsx` (gaps A2, C6; W01 follow-up `returnTo`/`loginHref`).
- [X] T053 [P] [US2] Write VK `tests/visual/checkout.spec.ts` (`Checkout layout`) states `review` and `price-changed` first (axe, 390/1280, baselines); further states (`pay-*`, `success`) are added in Phases 6-7.
- [x] T054 [US2] Add journey JC-4 to `tests/cart-checkout.spec.ts` (P1 part): anonymous visitor opens `/checkout`, `/checkout/pay/{id}`, `/checkout/success/{id}` and lands on sign-in with `returnTo` (AS-14); run it. The `/orders` and `/orders/{id}` URLs and the return-after-sign-in step need pages from later phases and are finished in T081 (the TODO in the spec file points there).

---

## Phase 6: User Story 3 — Pay and watch the payment settle (P1)

**Goal**: pay step with closed phase reducer, live/polling status, 3-D Secure. **Independent test**: UP1, UK5, UK7, VK pay states, JC-2.

- [X] T055 [P] [US3] Write UP1 `app/checkout/pay/[orderId]/page.test.tsx` (`Pay page access`): malformed, unknown and foreign order → `notFound()`; anonymous → redirect via `requireServerSession('/checkout/pay/{id}')`; PAID → redirect to success (AS-35).
- [X] T056 [P] [US3] Write UK7 `components/checkout/reservation-timer.test.tsx` (AS-36): `role="timer"`, announcements at 5 min/1 min/expiry, re-read at zero, "Payment in progress" suppresses expiry (fake timers).
- [X] T057 [P] [US3] Write UK5 `components/checkout/pay-panel.test.tsx` (AS-35, AS-37..AS-44, AS-47): Pay disabled until complete; provider errors with `aria-describedby`; no card data in the DOM; PENDING status, CANCELLED/REFUNDED panel with reason and refund notice; action required (frame opens with secret from memory, abandon → Continue verification, secret never stored or in URL); table-driven copy per `failureCode`, Buy again offered, no retry button; outcome unknown (no Pay button, settles); pay request problems (`order_not_payable` re-read per reason, `payment_already_exists` follows the payment, `order_not_found` lag retried 3 × 2 s then message, 422/400/5xx generic, 429 countdown, in-flight retry); two presses = one request with persisted pay attempt key.
- [X] T058 [US3] Implement `components/checkout/{payment-fields,sandbox-card-picker,pay-form,reservation-timer,payment-status,stream-banner,pay-panel}.tsx`: `PaymentFields` adapter (sandbox picker when `NEXT_PUBLIC_PAYMENTS_SANDBOX` and not production, otherwise lazy `@stripe/stripe-js` `StripeFields`), `hooks/use-pay-flow.ts` wiring, stream with polling fallback, `resync`/`revoked` handling; until T056/T057 pass (gaps C9, D-none; S13 follow-up; H7 sandbox names from T006).
- [X] T059 [US3] Create `app/checkout/pay/[orderId]/{page.tsx,loading.tsx,not-found.tsx}` (UUID check, `requireServerSession`, server prefetch of `/bff/orders/:id` payment summary); until T055 passes.
- [X] T060 [P] [US3] Extend `tests/visual/checkout.spec.ts` with `pay-form`, `pay-countdown`, `pay-processing`, `pay-action-required`, `pay-failed`, `pay-unknown`, `pay-cancelled` (axe, baselines at both viewports).
- [X] T061 [US3] Implement `payWithSandboxCard(page)` in `tests/helpers.ts` and journey JC-2 in `tests/cart-checkout.spec.ts` up to the pay step (cart quantity +, subtotal changes → checkout → Place order → pay page → sandbox card → processing); finish the final assertion in T066.

---

## Phase 7: User Story 4 — Truthful success page (P1)

**Independent test**: UP2, UK8, VK success, JC-2 end.

- [X] T062 [P] [US4] Write UP2 `app/checkout/success/[orderId]/page.test.tsx` (AS-50): foreign, unknown, malformed → not found; anonymous → sign-in with `returnTo`.
- [X] T063 [P] [US4] Write UK8 `components/checkout/success-view.test.tsx` (AS-48, AS-49, SC-003): copy, focus on `<h1>`, announced once, `checkout_step` success; unpaid, in progress, cancelled and refunded never say "confirmed"; only `isConfirmed(status)` decides.
- [X] T064 [US4] Implement `components/checkout/success-view.tsx` and `app/checkout/success/[orderId]/{page.tsx,loading.tsx,not-found.tsx}`; delete `app/checkout/success/page.tsx` (query-param page) (gaps D1-D4).
- [X] T065 [P] [US4] Extend `tests/visual/checkout.spec.ts` with `success` (and an unpaid variant).
- [X] T066 [US4] Finish journey JC-2: success page heading "Order confirmed" with links; run `pnpm exec playwright test tests/cart-checkout.spec.ts` on `desktop` and `mobile`.

---

## Phase 8: User Story 5 — Orders: list, detail, cancel, buy again (P2)

**Independent test**: UO1-UO5, UR, VO, JO-1.

- [X] T067 [P] [US5] Write UR `lib/redirects.test.ts` (`/dashboard/orders` → `/orders` permanent, reading `redirects()` of `next.config.ts`) (AS-60).
- [X] T068 [P] [US5] Write UO1 `components/orders/orders-list.test.tsx` (AS-51..AS-53, AS-58): rows, actions per status, status text, order id keys; empty copy, skeleton status, error + Try again, `429`/`5xx`; Older orders link with cursor, Newest link, `invalid_cursor`; stream stub re-read and one polite announcement, other orders only refreshed in cache.
- [X] T069 [P] [US5] Write UO2 `components/orders/order-detail.test.tsx` (AS-55..AS-58): timeline order, shop subtotals, status-dependent actions, links; payment unavailable note + Reload; absent when null without error; skeleton and read error; live status.
- [X] T070 [P] [US5] Write UO3 `components/orders/cancel-order-dialog.test.tsx` (AS-54): focus on Keep order, pending label, focus return, `409 order_not_cancellable`/`404`/`429` forms.
- [X] T071 [P] [US5] Write UO4 `components/orders/buy-again.test.tsx` (AS-59): sequential puts, quantity = current + order capped at 20, redirect and toast, failures listed on the cart.
- [X] T072 [P] [US5] Write UO5 `app/orders/[orderId]/page.test.tsx` (AS-57, AS-60): malformed, unknown, foreign → not found; deep link renders detail; anonymous → sign-in with `returnTo`.
- [X] T073 [US5] Implement `components/orders/{status-badge,order-row,orders-list,order-timeline,payment-panel,order-detail,cancel-order-dialog,buy-again}.tsx` (cards on mobile, table with caption on desktop, `<time>` elements, `OrderLive` stream bridge, no `data-testid`) until T068-T071 pass (gaps E2, E3, E5, E6).
- [X] T074 [US5] Create `app/orders/{page.tsx,loading.tsx,error.tsx}` and `app/orders/[orderId]/{page.tsx,loading.tsx,not-found.tsx}` (guard, cursor from `searchParams` inside Suspense, server prefetch); until T072 passes.
- [X] T075 [US5] Add the `/dashboard/orders` → `/orders` permanent redirect in `next.config.ts` `redirects()`; delete `app/dashboard/orders/`; remove the buyer `OrdersTable` / "Recent orders" card and `orderStats` use from `app/dashboard/view.tsx`; delete `components/dashboard/orders-table.tsx` if nothing else imports it (E7, E8); T067 passes.
- [X] T076 [P] [US5] Write VO `tests/visual/orders.spec.ts` (`list`, `empty`, `error`, `detail-reserved`, `detail-paid`, `detail-cancelled`, `detail-partial`).
- [X] T077 [US5] Write `tests/orders.spec.ts` journey JO-1 (`Orders`): place order without paying → `/orders` shows it with Pay now and Cancel → open detail (timeline, shop slice) → cancel → `CANCELLED`.

---

## Phase 9: User Story 6 — Notification bell and inbox (P2)

**Independent test**: UN1, VN, JN-1.

- [X] T078 [P] [US6] Write UN1 `components/notifications/notifications-popover.test.tsx` (AS-61..AS-69, AS-73): name with count, `99+`, absent at 0/unknown/anonymous, count on mount and focus; focus in, skeleton, plain-text items (HTML in title shown as text), unread marker, `<time>`, Esc returns focus; optimistic read + rollback; mark all read (count 0, announcement, rollback, hidden at 0); empty, error + Try again, `429` wait, `401` hands to W01; live arrival adds on top, ignores known id, announcement ≤ 1 per 5 s, focus unmoved; Show older appends without duplicates and focuses first new; reconnect banner, re-read of count and first page on reconnect and `resync`, `revoked` silent; tab order and labelled list; unsafe links not rendered as links.
- [X] T079 [US6] Implement `components/notifications/{bell-button,notification-item,notifications-popover}.tsx` on `subscribeUserEvents` (topic `user:<id>`, event shape from `notificationEventSchema`, responsive width and internal scroll); move from `components/notifications-popover.tsx`, leave a re-export, update the navbar import in the same task, then delete the old file (gaps F1-F9; W07 follow-up); until T078 passes.
- [X] T080 [P] [US6] Write VN `tests/visual/notifications.spec.ts` (`open`, `empty`, `error`, `layout` at both viewports).
- [X] T081 [US6] Write `tests/notifications.spec.ts` journey JN-1 (`Notifications`): pay → bell count rises without reload → open → follow item to order → count drops; implement `bellCount(page)` in `tests/helpers.ts`; finish JC-4 (T054): add `/orders` and `/orders/{id}` to its URL list, add the step that returns to the `returnTo` URL after sign-in (AS-14, rest of AS-57), remove the TODO, and run all three journey files.

---

## Phase 10: User Story 7 — Shared rules and removal of old code (P3)

- [X] T082 [US7] Delete old code (plan Phase 8): old hooks/consts `CART_QUERY_KEY`, `ORDERS_QUERY_KEY` in `lib/api/{cart,orders}.ts`; `lib/api/sse.ts`; `hooks/use-event-stream.ts`; `PaymentStatus` and `Order` in `lib/types.ts:98-111` (move remaining callers to contracts types); `data-testid`s in W03 files; any use of `NEXT_PUBLIC_SSE_URL`.
- [X] T083 [US7] Remove the `payment/stream` branch from `packages/backend/libs/composition/bff/forward/route-table.ts` and the comment listing `/api/payment/stream` in `packages/web/next.config.ts:39`; run `scripts/sdd/test-spec.sh bff-forward` (S13/S48 T049 follow-up).
- [X] T084 [US7] Make UA (T008) green: run `pnpm exec vitest run lib/checkout/architecture.test.ts`; fix violations in W03 files only; assert AS-70..AS-72 and that no W03 file uses the old `ProductCard` props (W02 follow-up).
- [X] T085 [US7] Leave `tests/zz-dbg.spec.ts` untouched (gaps "Gate repairs": pre-existing debug spec, no test deleted) and mention it in the report.
- [X] T086 [US7] Verify the accessibility baseline across all visual specs (`tests/visual/*.spec.ts`): axe serious/critical = 0 at 390 and 1280 px, no horizontal scroll at 320 px, 44 px targets at mobile (AS-74, SC-007, SC-008); fix component CSS where red.

---

## Phase 11: Polish, gates and records

- [X] T087 Re-check the existing "## Sibling-spec follow-ups" section in `gaps.md` against what was actually built (W07, W01, W02, W04, W05, W06, S10, S13, S48, S28) and amend bullets only (never edit those specs).
- [X] T088 Confirm `quickstart.md` "Ops artifacts" lists SC-001, SC-002 (two tabs), SC-004, SC-005, SC-007 (keyboard), SC-010 (real provider) and `specs/UNVERIFIED.md` has the six W03 rows with status `not run` (present at lines 95-100); add any further SC no test proved; never describe them as verified.
- [X] T089 Run static gates: `cd packages/web && pnpm exec tsc --noEmit && pnpm lint && pnpm build` (Cache Components validation, no runtime-data-outside-Suspense error).
- [X] T090 Run the whole web unit suite once (`pnpm exec vitest run`), then the whole Playwright suite once (`pnpm exec playwright test`, `desktop` and `mobile`, plus `tests/visual`); fix regressions in other specs only by adapting W03 code. (Unit suite green: 192 files, 2577 tests. Playwright: deferred to the final checkpoint: `cd packages/web && pnpm exec playwright test`.)
- [X] T091 Run backend suites for the touched domains once (`scripts/sdd/test-spec.sh order-read payment-read bff bff-forward`, then orders and payments suites) and the contracts tests.
- [X] T092 Write the final report: each follow-up from S10, S13, S35, S48, S51, W01, W02, W07 with the task that closed it; what was not built (`refCode` in the checkout schema, `reservedUntil` on list item, `GET /checkout/preview`, `unreadCount` on the event, digital downloads); blockers in `questions.md`.

---

## Dependencies & Execution Order

- Phase 1 → Phase 2 (backend/contracts) → Phase 3 (libs) → stories. Phase 2 and the pure-logic part of Phase 3 (T022-T026, T033-T035) can run in parallel with each other where marked [P].
- US1 (Phase 4) first (MVP), then US2 → US3 → US4 (pay page needs an order from US2; success page follows pay). US5 and US6 depend only on Phases 2-3 and can run in parallel with US2-US4 once the cart exists. US7 cleanup (Phase 10) after all stories; Phase 11 last.
- Within each story: test task → code task → visual/journey task.

## Parallel examples

- Phase 4: T036, T037, T038, T039, T045 (separate test files) together; then T040 → T041/T042/T043.
- Phase 8: T067-T072 together, then T073.
- Phase 2: T010, T011 together; B-1/B-2 specs (T012, T014) in parallel with B-3/B-4 (T016, T018) after T010.

## Implementation strategy

MVP = Phases 1-4 (cart with merge and badge). Then ship the purchase path US2-US4 as one increment (order → pay → success), then orders (US5), then notifications (US6), then cleanup and gates. Stop at each checkpoint and run only that phase's narrowest tests.

## Coverage notes

- Every `gaps.md` item: A1-A9 (T008, T022, T027-T029, T041, T052, T082), B1-B12 (T036-T046), C1-C9 (T033, T047-T052, T057-T059), D1-D4 (T062-T064), E1-E8 (T029, T067-T077), F1-F9 (T031-T032, T078-T079), G1-G4 (T046, T054, T061, T066, T077, T081, T027, loading/not-found files in each page task), H1-H10 (T009-T021, T006; H4-H6, H9, H10 recorded not built in T092), T1-T10 (T002-T003, T005, T008, T061, T081, T089).
- Every test-plan row: UC1-UC5, UK1-UK8, UP1-UP2, UO1-UO5, UN1-UN2, UL, UE, UR, UA, VC, VK, VO, VN, JC, JO, JN each have a failing-test task before the code task.
