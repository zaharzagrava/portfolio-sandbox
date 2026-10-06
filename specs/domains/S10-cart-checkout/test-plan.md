# Test Plan: S10 — Cart, Checkout, Stock Reservation, Order State Machine, Payment Webhook (domain `orders`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md) (68 rows), each proven at the lowest layer that can prove it. A dash means the layer does not test that scenario.

- API e2e files live in `packages/backend/libs/domains/orders/`. Each file's top-level `describe` names its feature (VII.8). They boot the real `OrdersModule` and `OrdersWorkerModule` (jobs and the `payments.events` consumer are invoked through their handlers, as other specs do) with the production prefix, `ValidationPipe`, problem+json filter and interceptors, against real Postgres, Redis, DynamoDB Local and the outbox, with real migrations, and call HTTP through `supertest`:
  - `cart.e2e-spec.ts` — describe "Cart: guest, signed-in, merge and limits"
  - `checkout.e2e-spec.ts` — describe "Checkout: idempotency, validation, pricing and split"
  - `checkout-stock.e2e-spec.ts` — describe "Checkout: stock reservation, expiry and compensation"
  - `payment-webhook.e2e-spec.ts` — describe "Payment webhook: signature, dedupe, async processing and out-of-order events"
  - `payment-events.e2e-spec.ts` — describe "Orders: payment result consumer" (VII.4 duplicate and invalid-payload tests)
  - `order-lifecycle.e2e-spec.ts` — describe "Orders: state machine, cancel and fulfilment commands"
  - `order-read.e2e-spec.ts` — describe "Orders: reads, history and tenant isolation"
  - `order-events.e2e-spec.ts` — describe "Orders: events, realtime, observability and jobs"
- Products, shops and stock are seeded and read in tests only through the shared fixture helpers and the catalog's and tenancy's exported services (`ProductQueryService`, `ProductStockService`, `ShopQueryService`); no spec injects `ProductModel`, `PaymentModel`, `UserModel` or `ShopModel` (D-7). Every test asserts the response body **and** persisted state (order, items, shop orders, history, reservations, outbox rows, jobs, cart store, stock) and parses responses with the `packages/contracts` schema (VII.6). Users are created through the S01 fixture (`issueTokensFor` is gone).
- Only system edges are faked: identity token verification, the payment provider's signatures (events are signed with a test secret using the real scheme), the payments capability's `getPaymentStatus` (a contract-valid fake of S13 until S13's module is loadable; a switch to the real module is part of J01), the discount source (a contract-valid fake of S45 registered through the port; absent in tests that need catalogue prices), the realtime hub's transport, and the clock (frozen and advanced). Faults use real mechanisms: a gate (latch) inside the stock call for in-flight scenarios, a store rule refusing one cart write, one release or one outbox append, a delayed catalog read, a limiter store switched off.
- Consumers (`payments.events`) have the duplicate-delivery and invalid-payload tests of VII.4 (AS-50). The webhook job is a consumer of the inbox; AS-43 and AS-44 are its duplicate and failure tests.
- Unit specs sit beside the code under `domain/`, are table-driven (`it.each`), and exist only for pure logic (VII.5): `guest-cart-token.spec.ts`, `cart-merge.spec.ts`, `money-allocation.spec.ts` (with `fast-check` for the money invariants), `stock-operations.spec.ts`, `order-state.spec.ts`, `webhook-signature.spec.ts`. Controllers, repositories, jobs and glue get no unit tests.
- UI journey (Playwright): owned by W03, `packages/web/e2e/cart-checkout.spec.ts` — one happy path per client: a guest adds a product, logs in (cart merges), checks out, the provider's test event arrives, the order page shows `PAID`. It never repeats an edge case from this plan. Rows below mark the steps it covers; the API column still holds the deep proof.
- Static gates (VII.1): `tsc --noEmit` and ESLint for `packages/backend` and `packages/contracts`; `pnpm check:boundaries`; `pnpm --dir packages/backend check:table-ownership --strict` (AS-68).
- Gate 9 (VII.9): AS-26 (limiter store down), AS-29 (cart cleanup failure), AS-30 (timeouts), AS-38 (release failure), AS-39 (crash recovery), AS-44 (webhook retries and dead letter), AS-45 (status check not completed), AS-64 (outbox failure), AS-65 (realtime down) each force their fault.
- Concurrency tests use `Promise.all` and assert that exactly one succeeds and the invariant holds (VII.3): AS-06, AS-17, AS-27, AS-32, AS-34, AS-43, AS-51, AS-56.

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 guest cart and cookie | `cart.e2e-spec.ts`: empty GET without cookie, PUT issues cookie with all attributes, GET with cookie, store holds one `guest:<uuid>` cart, zero relational rows | W03 journey step "add to cart as guest" | — |
| AS-02 signed-in cart, isolation | `cart.e2e-spec.ts`: user `U` with guest cookie writes to own cart, guest cart and cookie untouched, `V` sees none | — | — |
| AS-03 set semantics and limits | `cart.e2e-spec.ts`: 2 then 5, 0 removes, every validation class `400`, 51st line `422 cart_line_limit`, existing line still writable at 50 | — | — |
| AS-04 forged or tampered cookie | `cart.e2e-spec.ts`: five bad cookies on GET, PUT, merge; no lookup of claimed ID, new cookie only on PUT | — | — |
| AS-05 merge adds up and caps | `cart.e2e-spec.ts`: `{A:4,B:20,C:2}`, guest cart gone, cookie cleared | W03 journey step "log in, cart merges" | — |
| AS-06 merge idempotent and race-safe | `cart.e2e-spec.ts`: `Promise.all` two merges, quantities added once, later replay no change | — | — |
| AS-07 line cap on merge | `cart.e2e-spec.ts`: 40 + 20 lines → 50, `droppedLines: 10`, which lines survive | — | — |
| AS-08 merge needs a session | `cart.e2e-spec.ts`: `401` and guest cart unchanged; signed-in without cookie `200` | — | — |
| AS-09 lines expire | `cart.e2e-spec.ts`: frozen clock, +30 d +1 s hides the line though the store still holds it, re-set restarts the deadline | — | — |
| AS-10 cart rate limit | `cart.e2e-spec.ts`: 121st write `429` with `Retry-After`, nothing written, reads unaffected | — | — |
| AS-11 guest token | — | — | `guest-cart-token.spec.ts`: seven token forms, constant-time, no throw |
| AS-12 merge rule | — | — | `cart-merge.spec.ts`: table plus `fast-check` (once per product, `min(20, u+g)`, ≤ 50 lines, user's lines survive, `droppedLines`) |
| AS-13 checkout, full effect | `checkout.e2e-spec.ts`: `202` + `Location` + body, order, items, shop orders, reservations, stock, history, outbox, expiry job, realtime push, empty cart, idempotency record | W03 journey step "pay" (sees reserved order) | — |
| AS-14 prices from the server | `checkout.e2e-spec.ts`: price rose, no `expectedTotalMinor` uses new price; mismatch `409 price_changed` creates nothing and key reusable; unknown properties `400` | — | — |
| AS-15 replay | `checkout.e2e-spec.ts`: same key after `PAID`, original body and `Idempotency-Replayed`, no new rows, cart keeps `C` | — | — |
| AS-16 in flight | `checkout.e2e-spec.ts`: gate in the stock call, second request `409 idempotency_in_flight` + `Retry-After: 1`, third replays `202` | — | — |
| AS-17 concurrent duplicates | `checkout.e2e-spec.ts`: `Promise.all` ×5 → `202` same id or `409`, one order, one stock deduction | — | — |
| AS-18 key misuse | `checkout.e2e-spec.ts`: reuse with other body and with no body `422 idempotency_key_reuse`; missing `…_required`; 5, 129 chars and space `…_invalid` | — | — |
| AS-19 keys are per buyer | `checkout.e2e-spec.ts`: buyer `V` with `U`'s key gets a new order | — | — |
| AS-20 what a key remembers | `checkout.e2e-spec.ts`: pre-order failures release the key (retry `202`); `out_of_stock` after the order exists is replayed as stored; new key retries | — | — |
| AS-21 access and validation | `checkout.e2e-spec.ts`: `401` (none, guest only), `cart_empty`, `product_unavailable` for missing/archived/sandbox/non-active shop listing all ids, `mixed_currency`, nothing created | — | — |
| AS-22 multi-shop split | `checkout.e2e-spec.ts`: 5 lines of 3 shops → 3 shop orders, subtotals, sum equals total, `shopId` on items, product without shop refused | — | — |
| AS-23 discount allocation | — | — | `money-allocation.spec.ts`: `100` over `3333,3333,3334` → `33,33,34`; ties; refusal over gross; `fast-check` exact sum and ±1 proportional share |
| AS-24 seller discounts, fail-safe | `checkout.e2e-spec.ts`: discount 300 applied and allocated; timeout, throw, negative, float, over gross, unknown shop → catalogue price, `202`, fallback metric, warning log without payload | — | — |
| AS-25 money invariants | — | — | `money-allocation.spec.ts`: `fast-check` 10,000 carts (integers, line total ≥ 0, shop subtotals, order total, recomputation) |
| AS-26 checkout rate limit | `checkout.e2e-spec.ts`: 11th `429` + `Retry-After`, no order; limiter store off → refused (fail closed) | — | — |
| AS-27 one checkout per buyer | `checkout.e2e-spec.ts`: `Promise.all` two keys → one `202`, one `409 checkout_in_progress` (or `422 cart_empty`), one order | — | — |
| AS-28 cart consumption | `checkout.e2e-spec.ts`: gate after cart read, change `A` to 3 and add `C`, finish → order `A × 2`, cart `{A:3, C:1}` | — | — |
| AS-29 cart cleanup failure | `checkout.e2e-spec.ts`: store refuses cleanup once → `202`, cleanup job removes lines, failing job counted | — | — |
| AS-30 time budgets | `checkout.e2e-spec.ts`: slow product read → `503 checkout_unavailable`, no order, key unused; slow stock → order `PENDING`, retry `409` until recovery, then replay | — | — |
| AS-31 reserve through the catalog | `checkout-stock.e2e-spec.ts`: operation `orders:<id>:reserve:A`, delta `-3`, stock 7, replay of the operation no effect, no product-table query | — | — |
| AS-32 no oversell under race | `checkout-stock.e2e-spec.ts`: 200 HTTP checkouts on 50 units → 50 `202`, 150 `422 out_of_stock`, stock 0, 50 `RESERVED`, 150 cancelled without reservations or events | — | — |
| AS-33 all or nothing | `checkout-stock.e2e-spec.ts`: `A×1`, `B×2` with `B` short → `422` `[B]`, `A` unchanged, `CANCELLED(out_of_stock)` | — | — |
| AS-34 no deadlock | `checkout-stock.e2e-spec.ts`: 100 + 100 opposite-order carts → 200 `202`, no `5xx`, stocks consistent | — | — |
| AS-35 stock operations sorted | — | — | `stock-operations.spec.ts`: any order, repeated product, 100 products; ascending IDs, summed quantity, operation ID form |
| AS-36 hold expiry | `checkout-stock.e2e-spec.ts`: −1 s no-op, at deadline cancelled `hold_expired`, stock back once, one event, one push, job twice no change | — | — |
| AS-37 sweeper backstop | `checkout-stock.e2e-spec.ts`: expiry job deleted, sweeper (twice, two instances) cancels once; ≤ 200 per run; skips unexpired | — | — |
| AS-38 release fails then succeeds | `checkout-stock.e2e-spec.ts`: forced failure → `RELEASE_PENDING`, gauge 1; retry restores once; lost answer → replayed operation, no double add | — | — |
| AS-39 recovery of `PENDING` | `checkout-stock.e2e-spec.ts`: stuck order >60 s recovered to `RESERVED` (also if first attempt applied) or `CANCELLED(out_of_stock)`; twice/two instances once; young order untouched | — | — |
| AS-40 buyer cancels | `checkout-stock.e2e-spec.ts`: `200 orderSchema`, `CANCELLED(user_cancelled)`, stock back once, one event; other user `404` | — | — |
| AS-41 success acknowledged first, applied after | `payment-webhook.e2e-spec.ts`: `200` while order still `RESERVED`, job → `PAID`, reservations `CONVERTED`, shop orders `PAID`, history, `order.paid` row, push, inbox `PROCESSED` | W03 journey step "order shows paid" | — |
| AS-42 signature | `payment-webhook.e2e-spec.ts`: seven bad forms → `400 invalid_signature`, nothing stored or queued; exactly 300 s accepted | — | — |
| AS-43 duplicate delivery | `payment-webhook.e2e-spec.ts`: sequential and `Promise.all` ×10 → one stored event, one job, one transition, `duplicate: true` | — | — |
| AS-44 failure after the acknowledgement | `payment-webhook.e2e-spec.ts`: S13 status unavailable → retries with backoff, recovery → `PAID` once; 8 failures → `FAILED`, dead letter, metric, order `RESERVED` | — | — |
| AS-45 amount or currency mismatch | `payment-webhook.e2e-spec.ts`: amount −100, currency, status not `COMPLETED` → `REJECTED` with reason, order unchanged, metric, warning | — | — |
| AS-46 unmatched and unhandled | `payment-webhook.e2e-spec.ts`: no `orderId`, unknown order → `UNMATCHED`; `customer.created` → `IGNORED`; all `200` | — | — |
| AS-47 out-of-order and late events | `payment-webhook.e2e-spec.ts`: failed after success `IGNORED`; success after `hold_expired` → stays `CANCELLED`, one `orders.refund_requested`, no second on repeat | — | — |
| AS-48 payment failed | `payment-webhook.e2e-spec.ts`: `RESERVED` → `CANCELLED(payment_failed)`, stock once, one event; `PENDING`/`CANCELLED` unchanged | — | — |
| AS-49 refund | `payment-webhook.e2e-spec.ts`: full refund → `REFUNDED` + event; partial → history row only; refund before success retried then applied or `FAILED` | — | — |
| AS-50 payment results from the payments capability | `payment-events.e2e-spec.ts`: message twice → one transition; four invalid payloads dead-lettered without effect; race with webhook → one `PAID`, one `order.paid`; failed and refunded follow AS-48/49 | — | — |
| AS-51 pay versus cancel race | `payment-webhook.e2e-spec.ts`: `Promise.all` cancel vs success ×50 → exactly one outcome, stock consistent, one of `order.paid`/`order.cancelled`, refund command when cancelled won | — | — |
| AS-52 transport limits and secret rotation | `payment-webhook.e2e-spec.ts`: 64 KiB+ `413`, non-JSON `400 invalid_payload`, previous secret accepted, other secret refused, `GET` `405`, 301 forged → `429` | — | — |
| AS-53 signature check | — | — | `webhook-signature.spec.ts`: header forms, clock edges ±300/301 s, one or two secrets, constant-time, typed error, injected clock |
| AS-54 transition table | — | — | `order-state.spec.ts`: every (status, command, reason) pair against the allowed list, terminals, "already applied" set, exhaustive-switch type test |
| AS-55 illegal transitions at the API | `order-lifecycle.e2e-spec.ts`: cancel on `PAID`/`FULFILLING`/`SHIPPED`/`DELIVERED`/`REFUNDED` → `409` + `currentStatus`; on `CANCELLED` `200` no change; unknown/other's `404` identical; bad id `400`; `401` | — | — |
| AS-56 history and guarded updates | `order-lifecycle.e2e-spec.ts`: one row and one version step per move through `DELIVERED`; 20 concurrent copies of one move → one applies | — | — |
| AS-57 lifecycle commands for fulfilment | `order-lifecycle.e2e-spec.ts`: `apply` through `startFulfilment`, `ship`, `deliver` with `order.fulfilment_changed`; illegal → `InvalidOrderTransitionError`; unknown → `OrderNotFoundError` | — | — |
| AS-58 read one order | `order-read.e2e-spec.ts`: owner body with timeline; other buyer, shop member, admin → `404` byte-identical to missing; `401`; `400`; no persistence fields | W03 journey step "order page" | — |
| AS-59 history, keyset | `order-read.e2e-spec.ts`: 45 orders (same instants) pages 20/20/5, no repeat or skip with concurrent inserts, hidden `out_of_stock`, default and max, bad limits and cursors `400` | — | — |
| AS-60 history is index-only | `order-read.e2e-spec.ts`: 10,000 orders, `VACUUM`, `EXPLAIN` shows index-only scan and no sort | — | — |
| AS-61 seller's list | `order-read.e2e-spec.ts`: every role of `S1` `200` with only `S1`'s slice; `S2`-only member and non-member `404`; anonymous `401`; non-active shop follows S03's gate; bad `status`/cursor `400` | — | — |
| AS-62 exported reads | `order-read.e2e-spec.ts`: `getOrdersForShop` equals the HTTP page; `getOrderLines` one query for ≤ 500 ids, unknown absent, 501 throws; no model returned | — | — |
| AS-63 is this order payable | `order-read.e2e-spec.ts`: owner and `RESERVED` returns DTO; expired and other states throw `OrderNotPayableError` with code; other user and missing throw `OrderNotFoundError` | — | — |
| AS-64 events atomic with the change | `order-events.e2e-spec.ts`: one outbox row per transition with envelope and `orderVersion`, parsed by `orderEventSchemas`; outbox append fails → full rollback and `503` | — | — |
| AS-65 realtime is best effort | `order-events.e2e-spec.ts`: hub down → transition and events commit, failure logged and counted, `GET` shows new status | — | — |
| AS-66 observability | `order-events.e2e-spec.ts`: captured logs have `requestId`/`traceId`, `orderId`, none of body, signature, secret, cookie, authorization, key; metrics exist | — | — |
| AS-67 jobs | `order-events.e2e-spec.ts`: each job twice and on two instances → one effect; inbox purge at 35 d + 1 s removes, at 35 d keeps | — | — |
| AS-68 boundaries (static) | static gates: `check:table-ownership --strict` 0 findings for `orders`, `check:boundaries` green, barrel has no `*Model`, no associations to foreign models, ownership registry complete | — | — |
