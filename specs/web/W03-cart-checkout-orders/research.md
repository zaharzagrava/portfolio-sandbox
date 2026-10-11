# W03 — Research (decisions and verified facts)

Verified against the tree on 2026-10-11. Format: Decision / Rationale / Alternatives. No `NEEDS CLARIFICATION` remains; `questions.md` defaults are accepted as written.

## Verified facts that change the work

| # | Fact (where checked) | Consequence |
|---|---|---|
| F-1 | `packages/backend/libs/domains/orders/api/orders.controller.ts` routes only `GET /orders` and `POST /orders/:orderId/cancel`. `OrderQueryService.getOrderForUser` exists; S10 `contracts/http.md:12` specifies `GET /orders/:orderId`. | B-1 |
| F-2 | `payment.controller.ts` routes `POST /payments/intents` and `GET /payments/:paymentId` only; `paymentListQuerySchema`/`paymentPageSchema` exist in contracts (`orderId` filter) but no route. | B-2 (needed by the order aggregate for "latest payment") |
| F-3 | `composition/bff` has `page/` (product page), `session/`, `forward/`, `graphql/`; no cart or order aggregate. `upstream/endpoints/` has `productsBatch` (S05 `GET /api/batch/products`, ≤ 100 ids, `null` for invisible) and `shopsBatch`; no cart, orders or payments endpoint. | B-3, B-4 add three endpoint declarations |
| F-4 | The forwarder already relays the guest `cart` cookie both ways and treats `streams` as an unbuffered stream (`forward.controller.ts:46-193`, `route-table.ts:22`). | S48/W01 C-FWD (spec H3) is **closed**; W03 only tests it through the journey |
| F-5 | `packages/contracts` has source now: `cartSchema`, `setCartLineRequestSchema`, `checkoutRequestSchema` (`.strict()`, only `expectedTotalMinor`), `checkoutResponseSchema`, `orderSchema`, `orderListItemSchema` (no `reservedUntil`), `orderPageSchema`, `paymentSchema`, `paymentAcceptedSchema`, `createPaymentIntentRequestSchema`, `paymentPageSchema`, `problem.ts`, `realtime.ts` (stream query/envelope/resync/revoked). **Missing**: notification schemas, `cartPageResponseSchema`, `orderPageResponseSchema`, payloads of `order.status` / `payment.status` / `notification`. | B-5 |
| F-6 | Test tooling (RTL, user-event, jest-dom, `@vitejs/plugin-react`, `msw`, `@axe-core/playwright`) is installed; `vitest.config.ts` includes `components/ app/ lib/ hooks/`; Playwright has `mobile` + `desktop` projects, `tests/visual/` exists with `axe.ts`. | gaps T1-T4 closed |
| F-7 | W01 built `requireServerSession(returnTo)`, `loginHref`, `safeReturnTo`, `problemFromError`, `csrfHeaders()`, `session-ended`, `session-sync`; W02 built `formatMoney(minor, currency)`, `productHref`, `searchHref`, `newIdempotencyKey`, `track()` (queue, GPC/DNT), `problem-copy.ts` with a `Surface` union, `ProblemAlert` use. `lib/attribution/` and `getRefCode` do **not** exist. | AS-34 via a seam (R-03) |
| F-8 | W01's architecture test AS-29 rejects `sessionStorage` in `lib/api/**` and the W01 files; W02's rejects it in W02 files. `lib/browser-storage-keys.ts` lists every storage key and a test checks the privacy page lists each. | attempt storage lives in `lib/checkout/attempt-store.ts`; keys added to the list and the privacy page |
| F-9 | `PAYMENT_PROVIDER` is bound to `StripePaymentProvider` unless `is_load_test`, which binds an always-succeeding `LoadTestPaymentProvider` (`payments-core.module.ts:74-85`). The scripted fake provider is a test double only (`testing/fake-payment-provider.ts`); `pm_card_visa` is the only token the e2e flows use. | R-08 |
| F-10 | CSP already allows `paymentProviderHosts` on `/checkout/pay/*` only (`lib/security/csp.ts:23-39`); `build:e2e` sets `PAYMENT_PROVIDER_HOSTS`. | W07 follow-up is a documentation/test item, not code |
| F-11 | `next.config.ts` has no `/api/payment/stream` rewrite any more (only generic rewrites and a comment); the BFF forwarder's `route-table.ts:23` still special-cases `payment/stream`. | cleanup in Phase 8 |
| F-12 | `components/cart/cart-badge.tsx` and `components/notifications-popover.tsx` are stand-ins mounted by W07's navbar; `lib/api/cart.ts` still hydrates N products from the browser. | Phases 3, 7, 8 |

## Decisions

### R-01 Backend additions live in this plan
- **Decision**: build B-1…B-5 (see `plan.md`). Each is a thin controller/section over existing services or upstream clients.
- **Rationale**: the order page, pay step and cart cannot work against missing routes; constitution IX.7 R2 puts composition in the BFF.
- **Alternatives**: compose in the browser (N+1, forbidden by VI.9 and rejected in `questions.md`); fake the routes with MSW only (a fake journey).

### R-02 Contract asks not built
- **Decision**: do **not** add `reservedUntil` to the order list item, `GET /checkout/preview`, `unreadCount` on the notification event, or a digital-download read.
- **Rationale**: each is an additive nice-to-have owned by S10/S28/S31 and is not needed for a correct flow. Consequences accepted: **Pay now** may show on a hold that just expired and lands on the AS-43 page (the server sweeps expired holds); the review total is labelled "Estimated total" and a seller discount surfaces through `price_changed` (AS-23); the bell re-reads the count on focus/reconnect.
- **Alternatives**: widen S10's strict schemas now (touches a built capability's contract and tests for no user-visible need).

### R-03 Referral code (AS-34)
- **Decision**: `placeOrder` calls `readRefCode()` (server-only seam in `lib/server/checkout.server.ts`) which returns `null` until W02's `lib/attribution/ref.server.ts` exists, and the body gets `refCode` **only if** `checkoutRequestSchema.shape` has the key. Today it has none, so nothing is sent. UK3 forces both branches (schema with and without the field, code present and absent).
- **Rationale**: S10's body is `.strict()`; sending an unknown field would turn every checkout into a `400`.
- **Alternatives**: add the field to S10 (cross-capability change, H4); read the cookie in the browser (it is HttpOnly).

### R-04 Order creation is a server action returning a typed result
- **Decision**: `app/checkout/actions.ts` (`'use server'`) `placeOrder(input)`: validates `{key, expectedTotalMinor}` with zod, calls `POST {BFF}/api/bff/f/checkout` server-to-server with the session cookie turned into the bearer by the BFF forwarder (same path the browser would use) and the CSRF/Idempotency headers, parses `checkoutResponseSchema` or the problem body, and returns `{ok:true, orderId, replayed} | {ok:false, problem}`; it never throws a raw error. `Location` is not parsed. Origin is checked by `serverActions.allowedOrigins` (already configured).
- **Rationale**: one hop keeps typed problems and is where the referral cookie can be read; a thrown error would lose `Retry-After` and `productIds`.
- **Alternatives**: browser `POST /api/checkout` through `lib/api/checkout.ts` (cannot read the HttpOnly ref cookie; problems arrive as thrown axios errors).
- **Check at Phase 4**: a server action serialises concurrent calls from one client in order. The "one request at a time" guard (AS-18) is therefore kept in the client (pending flag) as well; the server action is not the guard.

### R-05 Order attempt and pay attempt
- **Decision**: pure `attempt.ts` (`createAttempt`, `reuse`, `shouldRotate(reason)`, `isExpired`, 24 h) over a storage port; `attempt-store.ts` is the only `sessionStorage` user, keys `w03.attempt.checkout` and `w03.attempt.pay:{orderId}`, value `{key, expectedTotalMinor?, cartFingerprint?, paymentMethodId?, createdAt}`. The cart fingerprint is a hash of sorted `productId:quantity` pairs (not personal data). Cleared on success, final outcome (`out_of_stock`, `price_changed` accepted, `cart_empty`, `product_unavailable`, `mixed_currency`), the `auth` broadcast `signed-out`, and at 24 h. After `401` it survives (AS-32).
- **Rationale**: AS-19/20/47 and P0414; the table of rotate/keep reasons is the unit test.
- **Alternatives**: `localStorage` (leaks across sign-ins and tabs); memory only (loses key on reload).

### R-06 Cart state: one list entry, one aggregate entry, a write queue
- **Decision**: `queryKeys.cart.lines()` ← `GET /api/cart` (badge, add-to-cart, cheap), `queryKeys.cart.page()` ← `GET /api/bff/cart` (page, review), `cart.lastMerge()` set by `mergeGuestCart`. Writes go through `lib/cart/write-queue.ts`: per-product promise chain, last value wins, optimistic patch on both entries in `onMutate`, rollback on error, `invalidateQueries(queryKeys.cart.all)` when the queue for the product drains. `Remove`/`Undo` are writes of `0` / previous quantity; the Undo toast lives 8 s (sonner duration), expiry does nothing.
- **Rationale**: FR-001/002, AS-04/05; removes today's N requests per line.
- **Alternatives**: `useMutation` `scope.id` only (does not coalesce to the last value); a store (VI.4 forbids without justification).

### R-07 Pay step: reducer, adapter, secrets
- **Decision**: `lib/checkout/pay-flow.ts` is a pure reducer over the closed phase set `idle | tokenizing | submitting | processing | actionRequired | confirming | unknown | failed | completed | expired` with events (`fieldsComplete`, `payPressed`, `tokenReady`, `accepted`, `payment`, `order`, `abandoned`, `expired`, `problem`); a transition table makes impossible pairs unrepresentable; `useReducer` in `use-pay-flow.ts`. `PaymentFields` is an adapter interface `{mount, onChange(complete), createPaymentMethod(), confirmAction(clientSecret)}` with `SandboxCardPicker` (only when `NEXT_PUBLIC_PAYMENTS_SANDBOX=true` and `NODE_ENV !== 'production'`, tree-shaken from production) and `StripeFields` (dynamic `import('@stripe/stripe-js')`, publishable key from `NEXT_PUBLIC_PAYMENT_PUBLISHABLE_KEY`). `clientSecret` comes only from `GET /payments/:id` (never the aggregate), is held in a ref, never put in the query cache, a log, storage or the URL: the payment query uses `select` to drop the field before it is cached and the one read that needs it bypasses the cache.
- **Rationale**: FR-051, AS-37..AS-47, SC-010.
- **Alternatives**: a single `useState` per field (impossible-state bugs); loading the provider script by hand.
- **Unverifiable here**: the real Stripe frames (no keys in CI) → UNVERIFIED row; the sandbox picker proves the flow.

### R-08 Can the dev stack settle a payment?
- **Decision**: Phase 0 probes it: create a user, order, `POST /payments/intents` with `pm_card_visa`, poll `GET /payments/:id`. If the stack uses Stripe with no key, the call fails; the dev stack is then run with the load-test provider setting (`is_load_test`, which binds the always-succeeding provider) for web journeys, documented in `quickstart.md`. If neither is possible within the five-attempt rule, JC-2 ends at "Payment is being processed…" and the blocker is written to `questions.md`; the success page is then proven by the unit and visual layers plus a seeded `PAID` order, never by a stubbed backend.
- **Rationale**: the plan must not assume a provider the stack may not have (F-9).
- **Sandbox tokens**: only `pm_card_visa` is documented (spec H7). The picker offers it; decline / 3-D Secure tokens are used only in unit tests with MSW until S13 names them.

- **Probe result (2026-10-11, T006)**: not settled end to end. `packages/backend/.env` has `STRIPE_SECRET_KEY=sk_test_dummy` and no `IS_LOAD_TEST`, so the dev stack binds `StripePaymentProvider` with a dummy key and a charge cannot settle. The probe script also could not reach `POST /checkout` directly on `:8000` with a bearer token (`401 invalid_token`; only the cart, which allows guests, answered), so the intent call itself was not exercised. Contingency taken: JC-2 runs up to "Payment is being processed…" unless the stack is started with `IS_LOAD_TEST=true`; the settled-to-success leg is then proven by unit and visual tests, and recorded under Ops artifacts in `quickstart.md`.

### R-09 User stream
- **Decision**: `lib/realtime/user-stream.ts`: module-level, ref-counted; `subscribeUserEvents(handler)` opens one `EventSource('/api/streams?topics=user:<id>')` on the first subscriber and closes on the last. `EventSource` is allowed in `lib/realtime/` (VI.3 says "components and hooks never call"; the architecture test lists this folder as the permitted home alongside `lib/api`). Frames parsed with `streamEventEnvelopeSchema` and the payload schemas of B-5; unknown event types ignored. `resync` → handlers' `onResync` (callers invalidate their keys); `revoked` → close without banner; `readyState === CLOSED` (401/403) → call the session refresh once (`useRefreshSession` equivalent from W01), recreate once, else `endSession()`. Health (`connected | reconnecting | closed`) is exposed through a `useSyncExternalStore` hook. The user id comes from read-only `useAuth()`.
- **Alternatives**: `fetch-event-source` (supports headers we do not need and loses the browser's `Last-Event-ID` replay); per-component streams (breaks S51 A-14).

### R-10 Polling fallback
- **Decision**: `lib/checkout/polling.ts` is a pure schedule `(elapsedSinceSilenceMs) → nextDelayMs | stop` (2 s up to 30 s, then 5 s up to 5 min after 10 s of stream silence, ≤ 30 req/min) driven by a hook with fake-timer tests. It runs only while the stream health is not `connected` or no event arrived for 10 s, and stops on a terminal state.
- **Alternatives**: always poll (wastes the read budget of 120/min shared with other reads).

### R-11 Rendering model
- **Decision**: `/cart` has a static shell and a client query (member and guest differ by cookie, never cached). Guarded pages split into a static shell and a `<Suspense>` child that calls `requireServerSession(returnTo)` then reads `params`/`searchParams`, prefetches with the session, and renders `<HydrationBoundary>` with only rendered fields (VI.8). Invalid UUID → `notFound()` before any read. The root layout is per-request because of the CSP nonce (W01 R-02), so "static shell" means "shell streams before data" (same wording as W02 AS-69).
- **Next 16 check**: `instant` and `loading.tsx` per route, `cookies()` only inside Suspense; validated by `next build`.

### R-12 Problem copy
- **Decision**: extend `lib/api/problem-copy.ts` with surfaces `cart`, `checkout`, `pay`, `orders`, `notifications`; the table is FR-081 keyed by `(surface, status, code)`; `detail` is shown only per FR-082. Checkout-specific structured problems (`price_changed`, `out_of_stock`, `product_unavailable`) are parsed by `problem-view.ts` with zod from the problem extension fields before the generic path.

### R-13 Analytics
- **Decision**: `lib/checkout/events.ts` wraps W02's `track()` with the exact props of FR-090 (`add_to_cart {product_id, category}`, `checkout_step {step, items, order_id?}`); one emission per view via a ref guard; nothing under a privacy signal (`track` already enforces GPC/DNT). `CLIENT_EVENT_NAMES` already contains both names (verified in `contracts/src/events/client-events.ts`).

### R-14 Dashboard coupling (W04)
- **Decision**: remove the buyer `OrdersTable` and "Recent orders" card from `app/dashboard/view.tsx` and delete `components/dashboard/orders-table.tsx` and `app/dashboard/orders/`; keep the seller dashboard otherwise unchanged; sibling bullet for W04. `/dashboard/orders` becomes a permanent redirect in `next.config.ts`.
- **Alternatives**: keep the old hook alive for W04 (leaves the bare-array shape and USD default the spec forbids).

## Phase 0 re-read (T001, 2026-10-11)

Read: `packages/web/AGENTS.md`; the guides *Authentication with Cache Components*, *Rendering philosophy*, *Building interactive apps*, `instant` (API reference), *Forms* under `node_modules/next/dist/docs/01-app/`. Points that touch `plan.md`:

1. **`instant` is dev-only.** The `instant` reference says validation runs in development (dev overlay, level `warning`) and "a validation level that supports validation during build will be supported" later. `plan.md` R-11 / T089 say `next build` validates "no runtime-data-outside-Suspense". Only half is true: reading `cookies()` outside `<Suspense>` is still a **build error** with Cache Components (Authentication guide, Step 2), but the *instant navigation* check is not run by `next build`. Consequence: the static-shell claim (AS-70) is proven by `next build` (no error) plus the UA source rules (request reads inside `<Suspense>`), not by `instant` validation. Do not add `export const instant = ...` to W03 pages as a gate.
2. **Server Functions run one at a time per client** (Forms / Server Actions guides: "sequential dispatch"). `placeOrder` is therefore serialised by the framework as well as by the `PlaceOrder` guard (AS-18); the 409 `idempotency_in_flight` auto-retry must be a client loop that calls the action again, not a long wait inside the action. No contradiction, a constraint for T050/T051.
3. **Server Actions must re-check the session** ("verify authentication and authorization inside each Server Action"). `plan.md` says the action "forwards the session cookie" only; `lib/server/checkout.server.ts` therefore reads the session cookie and refuses (`401`-shaped problem) when it is absent instead of calling the API anonymously. Not a contradiction, an added step.
4. **`use cache: private` for the session read** is offered by the guide; `plan.md` bans `use cache` in W03 pages (FR-057). Kept: W01's `getServerSession` uses React `cache()` per request; W03 does not add `use cache: private`.
5. **Context + `use()` for sharing the user** (guide Step 3) conflicts with "no new Context"; W03 passes `userId` as a prop or reads read-only `useAuth()`.
6. `useOptimistic` + transition is the framework's pattern for optimistic UI; `plan.md` uses TanStack Query optimistic updates for the cart (server data lives in the query cache, VI.4). Kept, since the data is client-fetched and not a Server Component prop.
7. Next 16.3 dev tooling (Navigation Inspector, `@next/playwright` `instant()` helper) exist but are not in the dependency list; no task needs them.
