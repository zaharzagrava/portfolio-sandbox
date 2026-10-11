# Implementation Plan: W03 — Cart, checkout, pay step, success page, orders, notification popover (`packages/web` + the backend pieces it needs)

**Branch**: `W03-cart-checkout-orders` (spec directory only) | **Date**: 2026-10-11 | **Spec**: [spec.md](spec.md)

**Inputs**: `spec.md`, `test-plan.md`, `gaps.md`, `questions.md` (defaults accepted as written, no human edits found), constitution (`.specify/memory/constitution.md`), the follow-ups handed to W03 by S10, S13, S35, S48, S51, W01, W02, W07 (table below). Next.js guides to read before code: *Authentication with Cache Components*, *Rendering philosophy*, *Building interactive apps*, `instant`, *Server Functions / forms* (re-read at Phase 0; `packages/web/AGENTS.md` first).

## Summary

Replace the three client-only stand-ins (`app/cart`, `app/checkout`, `app/dashboard/orders`, plus the success page and the popover) with the flow of the spec: cart (optimistic, serialised writes, grouped by shop), review and idempotent **Place order** through a server function, a new pay step with a closed-phase reducer and live/polling payment status, a truthful success page, keyset order history and detail, and the notification popover on one shared `user:<id>` stream.

1. **Backend and contracts first** (verified 2026-10-11, `research.md` R-01): `GET /orders/:orderId` and `GET /payments?orderId=` are specified but **not routed**; the two BFF aggregates (`/bff/cart`, `/bff/orders/:orderId`) and the notification / stream-event schemas do not exist. They are built here (B-1…B-5), each with an e2e spec.
2. **Foundations** (`packages/web/lib`): query keys, `lib/api/{cart,checkout,orders,payments,notifications}.ts` parsing with `packages/contracts`, `lib/realtime/user-stream.ts`, order/pay attempt logic, pay-flow reducer, safe link, problem copy for the new surfaces.
3. **Screens** in dependency order: cart → review/place order → pay + success → history/detail/cancel/buy again → popover.
4. **Follow-ups from built specs** are requirements of this plan (table below), each with a phase and a test.
5. **Delete** what the spec replaces (`lib/types.ts` payment types, old cart/orders hooks, dashboard orders, stand-in badge/popover, `/api/payment/stream` remnants).

## Technical Context

**Language/Version**: TypeScript 5 strict, Node 20+, React 19.2, Next.js 16.3.8 (Cache Components on, per-request root layout because of the CSP nonce), NestJS backend (existing).
**Primary Dependencies**: `@tanstack/react-query` 5, `zod` 4 + `@marketplace-sandbox/contracts`, `sonner`, radix `ui/*`, `lucide-react`, `@microsoft/fetch-event-source` (existing, used by `sse-reader.ts`). Test tooling is **already installed** (RTL, user-event, jest-dom, `@vitejs/plugin-react`, `msw`, `@axe-core/playwright`; `vitest.config.ts` already includes `components/`, `app/`, `lib/`, `hooks/`) so gaps T1–T3 are closed; verified in Phase 0. **New**: `@stripe/stripe-js` (lazy, pay page only, behind the `PaymentFields` adapter, R-07).
**Storage**: browser: tab `sessionStorage` for the two attempt keys only (R-05); no other storage; query cache in memory. Backend: no new tables.
**Testing**: Vitest + RTL + MSW for every `U*` row of `test-plan.md`; Playwright `desktop`/`mobile` for `JC`, `JO`, `JN`; `tests/visual/*` for `VC`, `VK`, `VO`, `VN` with axe; backend e2e through `scripts/sdd/test-spec.sh`; static gates `tsc --noEmit`, ESLint, `next build`, `lib/checkout/architecture.test.ts` (UA).
**Target Platform**: evergreen browsers; Next on Node behind the same-origin rewrites.
**Project Type**: web application (`packages/web`) with backend additions (orders, payments, composition/bff) and shared schemas.
**Performance Goals**: SC-004/SC-005 timings are real-browser measurements → UNVERIFIED rows; structure (polling schedule ≤ 30 req/min, optimistic update, abort/serialise) is unit-tested.
**Constraints**: relative same-origin URLs only; no `Authorization`, no token in JS; no new Context or global store; server caches none of W03's data; no new direct `sequelize.transaction`.
**Scale/Scope**: 7 routes (`/cart`, `/checkout`, `/checkout/pay/[orderId]`, `/checkout/success/[orderId]`, `/orders`, `/orders/[orderId]`, redirect), ~45 components/modules, 5 `lib/api` modules, 1 stream module, 1 server function, 5 backend changes, ~30 unit files, 3 journey files, 4 visual files.

## Follow-ups from built specs (requirements of this plan)

| Source | Requirement | Plan home / test |
|---|---|---|
| S10 / S48 | `POST /checkout` `202`+`Location`, body `{orderId,status,totalMinor,currency,reservedUntil}`, no `paymentIdempotencyKey`; `Idempotency-Key` mandatory (`422 idempotency_key_*`); `POST /cart/merge` `200`; `GET /cart` sets no cookie; carts hold ids/quantities/`addedAt`; `…Minor`; keyset `{items,nextCursor}`; `404 order_not_found` for foreign | Phase 2 (`lib/api/*` parse `checkoutResponseSchema`, `cartSchema`, `orderPageSchema`), Phase 4 (`actions.ts` reads `orderId` from the body, ignores `Location`), Phase 6; UK3, UK2, UC5, UO1 |
| S13 / S48 (T049) | pay step posts `POST /payments/intents` with `Idempotency-Key`, follows `payment.status` on `user:<id>` or polls `GET /payments/:id`, `requiresAction` hands `clientSecret` to the provider library; replace `lib/types.ts` `PaymentStatus` (98-104) and `Order.paymentStatus` (111) by contracts schemas; routes `/payment/*` gone; `next.config.ts` no longer rewrites `/api/payment/stream` (verified: only a comment and the forwarder's `payment/stream` branch remain) | Phase 2 (`lib/api/payments.ts`; delete `PaymentStatus`/`Order` from `lib/types.ts` after callers move), Phase 5 (pay step), Phase 8 (remove the `payment/stream` branch in `composition/bff/forward/route-table.ts` and the comment in `next.config.ts`); UK5, UK6, UN2 |
| S35 / W02 | emit `add_to_cart` through `track()` with `product_id`, `category` | Phase 3 (`AddToCartButton`); UC3, UE; journey JC-1 checks `/api/events` receives it |
| S48 | BFF exposes none of these routes: W03 builds the two aggregates it needs (IX.7 R2) and a mutation forwards unchanged to one endpoint with its `Idempotency-Key` | Phase 1 (B-3, B-4); mutations (`PUT /cart/items`, `POST /checkout`, `POST /payments/intents`, cancel) go through the forwarder |
| S51 | handle `resync` (refetch) and `revoked` (drop topic); recreate the stream after a final `401`/`403` | Phase 2 (`user-stream.ts`), Phase 5/7 consumers; UN2, UN1 |
| W01 | adopt `returnTo`, `loginHref`, `requireServerSession`, read-only `useAuth()`; no `Authorization`, no `setAccessToken`/`refreshSession` | Phases 2-7 (guards at the top of every guarded page), Phase 8 deletes the old calls in W03 files; UP1, UP2, UO5, JC-4. W04 `useRefreshSession()` and W06 guard are theirs (bullets in `gaps.md`) |
| W02 | order creation reads `getRefCode()` (`lib/attribution/ref.server.ts`) | **Not in the tree** (verified: no `lib/attribution/`, no `getRefCode`). Phase 4 builds the server function to call a `readRefCode()` seam that returns `null` until W02 phase 6 lands, and to send it only if `checkoutRequestSchema` declares `refCode` (it is `.strict()` and does not today). UK3 forces both branches |
| W02 | `formatMoney(minor, currency)` required; W03 call sites adapted only to compile | Phases 3-6 replace every W03 call site with the object's own `currency` (UC1 integer subtotal, AS-73) |
| W02 | `components/product-card.tsx` re-exports the new `ProductCard` (props changed) | W03 uses `CardModel` nowhere in its own screens; Phase 8 checks no W03 file imports the old props |
| W02 | `<AddToCartButton productId category disabled />` receives `category` | Phase 3 (prop becomes required in behaviour, optional in type for other callers); UC3 |
| W07 | replace the stand-in `CartBadge` ("Cart" / "Cart, {n} items") and honour the `NotificationsPopover` contract; supply `PAYMENT_PROVIDER_HOSTS` | Phase 3 (`CartBadge` + `useCartCount`), Phase 7 (popover moved to `components/notifications/`, old path re-exports until the navbar import is updated in the same phase), Phase 0/9 (`PAYMENT_PROVIDER_HOSTS` documented in `.env.example`/README; `build:e2e` already sets it; checked by `lib/config.test.ts` addition) |
| gaps.md | every item A-I (code fixes and constitution debt) and "Gate repairs" | "Gap coverage" below |

## Constitution Check

*GATE: passes before research; re-checked after design (below).*

| Rule | Status | Note |
|---|---|---|
| I/II layering, routing | PASS (planned) | new endpoints are thin controller methods; logic stays in `OrderQueryService`/`PaymentQueryService` (already exist); BFF aggregates only compose |
| III transactions | PASS (planned) | no new transaction; B-1…B-4 are reads. Touched backend files are grepped for `// S54 T037 audit`; any direct `sequelize.transaction` found in a file this plan edits is migrated to `TransactionRunner.run`/`@Transactional` and the comment deleted (task B-6) |
| IV communication | PASS | BFF reads orders/payments/catalog/tenancy over HTTP clients (`upstream/endpoints/*`), never tables |
| V.1-V.4 contracts, errors | PASS (planned) | every new body has a schema in `packages/contracts` (B-5); stable problem codes; copy chosen by `code`, never `detail` |
| V.6 idempotency | PASS | UI half of P0414: one key per attempt, `Idempotency-Key` on `POST /checkout` and `POST /payments/intents`, replay is success |
| VI.1 Server Components first | PASS (planned) | pages and guards are Server Components; client leaves listed in `data-model.md` |
| VI.2 same origin, no tokens | PASS with a noted deviation | no token anywhere; the attempt key (random, not a credential) is in `sessionStorage` (Complexity Tracking) |
| VI.3 network only in `lib/api/*` / server modules | PASS (planned) | UA asserts; the order function is a server action in `app/checkout/actions.ts` calling a server-only module |
| VI.4 state homes | PASS | server data in TanStack Query; cursor in URL; pay phases `useReducer`; **no** Context, **no** store; `user-stream` is a module-level ref-counted connection with subscriber callbacks (not React state) |
| VI.5 authz not only in proxy | PASS | `requireServerSession` is convenience; the API and aggregates authorize again; `404` for foreign orders |
| VI.6 stable keys | PASS (planned) | ids as keys (FR-056); UA rejects index keys in W03 files |
| VI.7 text only | PASS (planned) | titles/notification text rendered as text; links via `safeNotificationLink`; no `dangerouslySetInnerHTML` |
| VI.8 minimal props | PASS (planned) | server pages pass display fields only |
| VI.9 no business rules in web | PASS | totals, stock, expiry, cancellability, payment state come from the API; the UI shows the "estimated total" labelled as such and lets the server decide (`price_changed`) |
| VII.1 static | gate | `tsc`, ESLint, `next build`, UA |
| VII.2/3 backend e2e | PASS (planned) | each of B-1…B-4 gets an e2e spec: happy, validation, `401`, cross-user `404`, partial-section degrade (BFF), rate limit where applicable |
| VII.7 UI testing | PASS (planned) | journeys happy path only against the dev stack; failure forms are MSW unit tests |
| VII.8 traceability | PASS | `test-plan.md` has one row per AS-01..AS-75 |
| VII.9 green run | gate | fallbacks forced: partial cart (AS-09), partial order (AS-56), polling (AS-39), stream reconnect (AS-45/68), pay lag (AS-44), merge failure (AS-12) |
| IX isolation | PASS | aggregates call domains over HTTP |
| X boundaries | PASS | web imports `@marketplace-sandbox/contracts` only |
| PR gate 6 contracts | PASS (planned) | schemas added with their endpoints |

**Complexity Tracking (justified deviations)**

| Deviation | Why needed | Simpler alternative rejected because |
|---|---|---|
| `sessionStorage` for the two attempt keys although VI.2 lists it | AS-20/AS-47: a reload must reuse the key or a second order/payment can be created | an in-memory key is lost on reload (the exact failure P0414 forbids); `localStorage` would survive tabs and sign-outs. Value is a random UUID + expected total + timestamp, never a credential; confined to `lib/checkout/attempt-store.ts` (outside `lib/api`, so W01's AS-29 walk is untouched), listed in `lib/browser-storage-keys.ts` (+ privacy page), deleted on success, final outcome, 24 h and the `auth` broadcast |
| Backend work inside a web plan (B-1…B-5) | the order page, history detail and pay step call routes that do not exist | shipping UI against `404` is a fake; waiting blocks the P1 stories |
| Module-level `user-stream` connection (not Context/store) | one `EventSource` per page shared by bell, order pages, pay step, usable outside React (reconnect timers) | a Context would be state with no render consumers; two connections would break S51 A-14 |
| `@stripe/stripe-js` dependency | hosted card fields and 3-D Secure are provider browser features | hand-loading the script duplicates its loader and typing; it is lazy and never in another route's bundle |

**Post-design re-check**: unchanged. One new risk found and resolved: the dev stack may not settle payments (R-08); handled by a Phase 0 probe and a recorded contingency, not by a code change.

## Project Structure

### Documentation (this feature)

```text
specs/web/W03-cart-checkout-orders/
├── spec.md  test-plan.md  gaps.md  questions.md  checklists/
├── plan.md            # this file
├── research.md        # decisions R-01..R-14 and verified facts
├── data-model.md      # entities, state homes, pay-phase transitions, storage
├── quickstart.md      # run guide + Ops artifacts
└── contracts/
    ├── backend-endpoints.md   # what W03 calls, B-1..B-5, schemas to add
    └── web-modules.md         # exported names, signatures, routes, events
```

### Source code (repository root)

```text
packages/web/
├── app/
│   ├── cart/{page.tsx,loading.tsx}                       # static shell + <CartView/> client (no request-time read)
│   ├── checkout/{page.tsx,loading.tsx,actions.ts}        # guard + first read; actions.ts = 'use server' placeOrder
│   ├── checkout/pay/[orderId]/{page.tsx,loading.tsx,not-found.tsx}
│   ├── checkout/success/[orderId]/{page.tsx,loading.tsx,not-found.tsx}   # replaces checkout/success/page.tsx
│   ├── orders/{page.tsx,loading.tsx,error.tsx}
│   ├── orders/[orderId]/{page.tsx,loading.tsx,not-found.tsx}
│   └── dashboard/orders/  → removed (redirect in next.config.ts); dashboard/view.tsx loses the buyer table
├── components/
│   ├── add-to-cart-button.tsx                            # keeps path and signature
│   ├── cart/{cart-badge.tsx,cart-view.tsx,cart-line.tsx,quantity-control.tsx,cart-summary.tsx,merge-notice.tsx,shop-group.tsx}
│   ├── checkout/{review.tsx,place-order.tsx,problem-alerts.tsx,progress.tsx,pay-panel.tsx,pay-form.tsx,payment-fields.tsx,
│   │             sandbox-card-picker.tsx,reservation-timer.tsx,payment-status.tsx,success-view.tsx,order-summary.tsx,stream-banner.tsx}
│   ├── orders/{orders-list.tsx,order-row.tsx,order-detail.tsx,order-timeline.tsx,payment-panel.tsx,cancel-order-dialog.tsx,buy-again.tsx,status-badge.tsx}
│   ├── notifications/{notifications-popover.tsx,notification-item.tsx,bell-button.tsx}
│   └── notifications-popover.tsx                         # re-export until navbar import moves (Phase 7), then deleted
├── hooks/{use-user-stream.ts,use-online.ts,use-pay-flow.ts}   # use-event-stream.ts deleted (Phase 8)
├── lib/
│   ├── query-keys.ts  routes.ts (+cartHref, checkoutHref, payHref, successHref, ordersHref, orderHref)
│   ├── api/{cart.ts,checkout.ts,orders.ts,payments.ts,notifications.ts}   # sse.ts deleted
│   ├── server/{checkout.server.ts,orders.server.ts,payments.server.ts}    # server-only reads/writes with the session
│   ├── realtime/user-stream.ts
│   ├── checkout/{attempt.ts,attempt-store.ts,pay-flow.ts,polling.ts,events.ts,problem-view.ts,architecture.test.ts}
│   ├── cart/{totals.ts,write-queue.ts}  lib/safe-link.ts  lib/api/problem-copy.ts (+surfaces)
│   └── types.ts  (PaymentStatus, Order removed)
├── next.config.ts (redirect /dashboard/orders → /orders permanent; comment cleanup)   lib/redirects.test.ts
└── tests/{cart-checkout.spec.ts (rewritten),orders.spec.ts,notifications.spec.ts,helpers.ts (+payWithSandboxCard,bellCount)}
    tests/visual/{cart,checkout,orders,notifications}.spec.ts

packages/contracts/src/{bff/cart-page.ts,bff/order-page.ts,notifications/index.ts,realtime-user.ts}  + index.ts exports
packages/backend/libs/domains/orders/api/orders.controller.ts            # B-1 GET :orderId
packages/backend/libs/domains/payments/api/payment.controller.ts         # B-2 GET payments?orderId
packages/backend/libs/composition/bff/{cart/,orders/,upstream/endpoints/{orders,payments,cart}.ts}   # B-3, B-4
packages/backend/libs/composition/bff/forward/route-table.ts             # Phase 8 cleanup
```

**Structure Decision**: keep W07/W01/W02 layout. Server-only modules end in `.server.ts` with `import 'server-only'`. Components are named by UI role; business-free helpers (totals, attempt, reducer, polling schedule, safe link) are pure modules with table-driven unit tests next to them.

## Decision tables

**Rendering and cache** (FR-057, AS-70): no W03 route uses `use cache`. `/cart` has a static shell and reads nothing at request time (client fetch). Guarded pages: `<Suspense>` around the part that reads `cookies()`/`params`/`searchParams`, shell (heading, skeleton) outside it; the first read is prefetched on the server with the session into a `HydrationBoundary`.

**Browser cache lifetimes** (FR-057): `cart.lines`/`cart.page` 0 s + refetch on focus; `orders.list` 15 s; `orders.detail`/`payments.detail` 0 s while non-terminal, 60 s after; `notifications.unreadCount` and `inbox` 30 s.

**Client/server split**: client leaves are `CartView`, `AddToCartButton`, `CartBadge`, `PlaceOrder`, `PayPanel` tree, `ReservationTimer`, `OrdersList`'s action cells, `CancelOrderDialog`, `BuyAgain`, `OrderLive` (stream bridge), `NotificationsPopover` tree. Everything else is Server.

## Phases (dependency order; each ends green on its narrowest test)

| Phase | Content | Proof |
|---|---|---|
| 0 | Re-read AGENTS.md + guides; verify tooling (T1-T3 closed); `lib/checkout/architecture.test.ts` (UA) with its rules failing first; `lib/browser-storage-keys.ts` + privacy page entries for `w03.attempt.*`; probe the dev stack: `POST /payments/intents` with `pm_card_visa` settles? (R-08); `.env.example`/README: `PAYMENT_PROVIDER_HOSTS`, `NEXT_PUBLIC_PAYMENT_PUBLISHABLE_KEY`, `NEXT_PUBLIC_PAYMENTS_SANDBOX` | `vitest run lib/checkout` (red for the right reason), `lib/config.test.ts` |
| 1 | **Contracts + backend**: B-5 schemas, B-1 `GET /orders/:orderId`, B-2 `GET /payments?orderId=`, B-3 `GET /bff/cart`, B-4 `GET /bff/orders/:orderId`, B-6 T037 audit | `test-spec.sh` for orders-read, payment-read, bff; contracts tests |
| 2 | Foundations: `query-keys.ts`, `routes.ts`, `lib/api/*` five modules, `lib/server/*`, `user-stream.ts`, `attempt.ts` + `attempt-store.ts`, `pay-flow.ts`, `polling.ts`, `safe-link.ts`, `events.ts`, problem copy surfaces, `use-online` | UK2, UK6, UN2, UL, UE, UC5, `query-keys.test.ts`, problem-copy tests |
| 3 | Cart: `/cart` shell, `CartView`, line, quantity control (write queue, optimistic, undo), summary, merge notice, `CartBadge`/`useCartCount`, `AddToCartButton` (toast, `track`), `mergeGuestCart` returning `{droppedLines}` | UC1-UC5; VC; journey JC-1/JC-3 |
| 4 | Checkout review: guard, review, progress, `placeOrder` server action, `PlaceOrder` (attempt, retries, all problem alerts), offline, `checkout_step` | UK1, UK3, UK4, UE; VK `review`, `price-changed` |
| 5 | Pay step + success: pay page access, `PayPanel`, `PaymentFields` adapter (sandbox picker, Stripe lazy), timer, status panel, polling, 3-D Secure, double submit, success view | UP1, UP2, UK5, UK6, UK7, UK8; VK pay states; JC-2 |
| 6 | Orders: list (cursor in URL), detail (timeline, shops, payment panel), cancel dialog, live status, buy again, `/dashboard/orders` redirect, dashboard loses buyer table | UO1-UO5, UR; VO; JO-1 |
| 7 | Popover: bell, inbox (infinite query), optimistic read, live arrival, reconnect, layout; move to `components/notifications/`, update navbar import | UN1, UL; VN; JN-1 |
| 8 | Delete old code: `lib/api/{cart,orders}.ts` old hooks/consts, `CART_QUERY_KEY`, `ORDERS_QUERY_KEY`, `lib/api/sse.ts`, `hooks/use-event-stream.ts`, `app/dashboard/orders`, `components/dashboard/orders-table.tsx` (if no W04 user), `lib/types.ts` payment/order types, `data-testid`s, `payment/stream` branch in the BFF forwarder + comment | `tsc`, ESLint, UA, `bff-forward` e2e, `tests/` grep |
| 9 | Journeys (`cart-checkout`, `orders`, `notifications`), visual baselines, UNVERIFIED rows, sibling bullets, whole web suite once, backend capability suites once | `playwright test`, `vitest run`, `next build`, `test-spec.sh` |

## Backend and contract tasks

| ID | Task | Owner spec | Where | Test |
|---|---|---|---|---|
| B-1 | `GET /orders/:orderId` → `orderSchema`; `400` malformed id (`ParseUUIDPipe`), `404 order_not_found` identical for unknown and foreign, `401`; reads `OrderQueryService.getOrderForUser` (exists) | S10 | `domains/orders/api/orders.controller.ts` | extend an orders e2e: happy (items, shopOrders, timeline), 400, 404 foreign, 401, parse with `orderSchema` |
| B-2 | `GET /payments?orderId&limit&cursor` → `paymentPageSchema`, owner only, newest first, `clientSecret` never non-null in a list; rate policy `payments.read.user` | S13 | `domains/payments/api/payment.controller.ts` + `PaymentQueryService.listOwned` | extend `payment-read.e2e-spec.ts`: happy, other user's order → empty page, 400 bad query, 401, 429 |
| B-3 | `GET /bff/cart` → `cartPageResponseSchema`: S10 lines (guest cookie forwarded, anonymous allowed) + `productsBatch` + `shopsBatch`; `product: null` when hidden; products failure → all `product:null` + `errors[{section:'products'}]`; shops failure → `shop:null` + `errors[{section:'shops'}]` | S48 | `composition/bff/cart/`, `upstream/endpoints/cart.ts` | extend `bff.e2e-spec.ts`: anonymous, member, hidden product, products down, shops down, 50 lines, no `Set-Cookie` |
| B-4 | `GET /bff/orders/:orderId` → `orderPageResponseSchema`: order (required) + latest payment (optional, no `clientSecret`); `404` passes through unchanged; payment failure → `payment:null` + `errors[{section:'payment'}]`; `401` | S48 | `composition/bff/orders/`, `upstream/endpoints/{orders,payments}.ts` | `bff.e2e-spec.ts`: happy, no payment, payment down, foreign `404`, malformed `400`, `401` |
| B-5 | Schemas: `cartPageResponseSchema`, `orderPageResponseSchema`, `notificationItemSchema`, `notificationPageSchema`, `unreadCountSchema`, `markReadRequestSchema`, `userStreamEventSchemas` (`order.status`, `payment.status`, `notification`) | S54/contracts | `packages/contracts/src` | contract tests parse real responses of the above e2e specs |
| B-6 | `// S54 T037 audit` grep over every backend file touched; migrate to `TransactionRunner.run` | S54 | touched files | existing suites of those domains |
| - | **Not built, recorded**: `refCode` in `checkoutRequestSchema` (S10 H4), `reservedUntil` on the list item (H5), `GET /checkout/preview` (H6), `unreadCount` on the event (H9), digital downloads (H10): see `research.md` R-02, R-03 and `gaps.md` | S10/S28/S31 | - | UK3 forces the "schema lacks `refCode`" branch |

## Gap coverage (gaps.md → phase)

| Gaps | Phase | Gaps | Phase |
|---|---|---|---|
| A1-A3, A5, A7 | 2, 4, 6, 8 | E1-E8 | 6, 8 |
| A4, A8 | 2 | F1-F9 | 2, 7, 8 |
| A6 | already closed by W01 (verified: relative URLs); re-asserted by UA | G1 | 9 |
| A9 | 0 (UA) | G2 | closed by W01/W02 (`helpers.ts` verified Phase 0) |
| B1-B12 | 3 | G3 | 3, 6 (tests rewritten with the code) |
| C1-C9 | 4, 5 | G4 | 3-7 (`loading.tsx`, `not-found.tsx` per route) |
| D1-D4 | 5 | H1-H3 | 1 (H3 already built by S48 forwarder: cart cookie + streams verified) |
| H4-H6, H9, H10 | recorded, not built | H7 | 0 probe (R-08), 5 |
| H8 | 1 (B-5; the package now has source) | T1-T3 | 0 (closed) |
| T4-T7 | 0, 5, 9 (visual config exists; add stubs `tests/stubs/*`, helpers, sandbox picker) | T8-T10 | 0, 9 |
