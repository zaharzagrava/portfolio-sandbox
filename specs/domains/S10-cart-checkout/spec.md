# Feature Specification: S10 — Cart (Guest + Merge), Idempotent Checkout, Stock Reservation, Multi-Shop Split, Order State Machine, Payment Webhook (domain `orders`)

**Feature Branch**: `S10-cart-checkout` (spec directory `specs/domains/S10-cart-checkout`)

**Created**: 2026-10-05

**Status**: Draft

**Input**: User description: "Cart (guest + merge), idempotent checkout, stock reservation, multi-shop split, order state machine, payment webhook (domain `orders`)". Sources: `docs/showcase/sections/SD-19-checkout-inventory.md`, note 10-System-Design/07 §19 (checkout and inventory), note 04-API-Design/03 §1 and §5 (idempotency keys, webhooks as consumer), constitution v3.1.0, `docs/architecture/domain-map.md` (`orders`), `docs/architecture/pattern-map.md` (rows naming S10: P0103, P0110, P0303, P0311, P0313, P0407, P0414, P0419, P0611, P1110).

## Scope

A buyer fills a cart (signed out or signed in), signs in, and checks out. The cart may hold products of several shops. Checkout turns the cart into **one order** that holds the stock for 15 minutes, splits into one **shop order** per seller, and waits for payment. The payment provider tells us the result through a signed webhook; only that signal (never the browser's redirect) marks the order paid. Unpaid holds expire and give the stock back. The buyer sees the order status, and other capabilities react to the order's events.

In scope:

- **Cart**: a signed-out (guest) cart kept under a signed cookie, a signed-in cart per user, merging the guest cart into the user's cart after login, line limits, expiry. The cart never touches the relational database.
- **Checkout**: one authenticated request that is safe to retry (`Idempotency-Key`), prices recomputed on the server, seller discounts applied and allocated exactly, one order split into shop orders, answer `202 Accepted`.
- **Stock reservation**: stock is held at checkout for 15 minutes through the catalog's exported stock command, never oversold, released exactly once on cancel or expiry, recovered after a crash between steps (a saga with compensation).
- **Order state machine**: `PENDING → RESERVED → PAID → FULFILLING → SHIPPED → DELIVERED`, `CANCELLED`, `REFUNDED`, guarded transitions with a history and an event per transition, the buyer's cancel.
- **Payment webhook**: the provider's signed event: signature over the raw body, 5-minute tolerance, de-duplication on the event ID, acknowledged before processing, processed asynchronously, tolerant of reordered and duplicated deliveries; plus the consumer of the payments capability's result events.
- **Reads**: the buyer's order and paginated history, a seller's paginated list of their shop orders, and the exported read services other capabilities use instead of reading order tables.

Out of scope (owners named):

- Flash sales (bucketed fast stock, admission, per-customer quota, drop prices) → **S11**. This capability defines the reservation seam S11 plugs into (see Cross-capability contracts) and proves regular stock only.
- Payment intents, the PSP call, unknown outcomes, the ledger, refunds execution → **S13**, **S14**. This capability only answers "is this order payable, for how much" and reacts to results.
- Order export (CSV, queue, routes) → **S12** (debt D-10).
- Product data, prices and stock arithmetic → **S05** (`catalog`). Shops and permissions → **S03**. Discount functions → **S45**. Authentication → **S01**. Notifications (mails, popovers) → **S28**. Realtime hub → **S51**. Outbox, inbox, consumers → **S53**. Jobs → **S49**. Rate limiter → **S50**. Platform toolkit (errors, idempotency facility, clock, config, metrics) → **S54**.
- Shipping address, shipping fees and taxes: not modelled (prices are final prices); fulfilment progress per shop (who ships, tracking) → fulfilment capabilities **S19**, **S20**, which call this capability's exported lifecycle service.
- Winning-bid checkout for auctions → **S21** will state what it needs (see `questions.md`).
- All screens (cart drawer, checkout page, success page, history) → **W03**; the product titles and images shown next to cart lines are composed by the BFF (**S48**, IX.7 R2).

## User Scenarios & Testing *(mandatory)*

Notation: `P`, `A`, `B`, `C` are products; `S1`, `S2`, `S3` shops; amounts are integer minor units (`1000` = 10.00 EUR). "The catalog" is S05's exported `ProductQueryService` and `ProductStockService`. "Time is frozen" means the tests control the clock. Every error is `application/problem+json` with `type`, `title`, `status`, `detail`, `instance`, `requestId` and a stable `code`.

### User Story 1 — A shopper keeps a cart, signed out or signed in, and it follows them through login (Priority: P1)

A visitor adds items without an account. After signing in, the guest cart merges into their own cart: quantities add up (capped), nothing is lost, and merging twice or from two tabs never doubles anything. Add-to-cart storms never reach the relational database.

**Why this priority**: the cart is the entry of the whole purchase flow; a lost or doubled line is a lost or wrong sale.

**Independent Test**: add lines as a guest, sign in, merge (twice, and concurrently), read the cart; assert the exact quantities and that no relational row was read or written.

**Acceptance Scenarios**:

1. **AS-01** (guest cart) — **Given** a request with no credentials and no cart cookie, **When** `GET /cart`, **Then** `200 {lines: [], droppedLines: 0}` and no `Set-Cookie`; **When** `PUT /cart/items/P {quantity: 2}`, **Then** `200 {lines: [{productId: P, quantity: 2, addedAt}], droppedLines: 0}` parsed by `cartSchema`, with one `Set-Cookie: cart=guest:<uuid>.<signature>; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000` (plus `Secure` outside local), and a following `GET /cart` with that cookie returns the same line; the cart store holds exactly one cart for `guest:<uuid>`, and zero relational rows exist in any orders table.
2. **AS-02** (signed-in cart, isolation) — **Given** users `U` and `V` and a guest cookie in `U`'s request, **When** `U` calls `PUT /cart/items/P {quantity: 5}` with the guest cookie attached, **Then** the line is stored in `U`'s cart, the guest cart is untouched and the cookie is not changed or cleared; `V`'s `GET /cart` shows none of it; no route takes a cart ID, so no request can name another identity's cart.
3. **AS-03** (set semantics and limits) — **Given** an empty cart, **When** `PUT P {quantity: 2}` then `PUT P {quantity: 5}`, **Then** the line is quantity `5` (set, not added) and `addedAt` of the first call is kept; **When** `PUT P {quantity: 0}`, **Then** the line is removed (`200`, no lines); **When** the body is `{quantity: 21}`, `{quantity: -1}`, `{quantity: 1.5}`, `{}`, `{quantity: 1, extra: 1}`, or the path ID is not a UUID, **Then** `400 validation_failed` naming the field and nothing changes; **Given** a cart with 50 distinct lines, **When** `PUT` of a 51st product, **Then** `422 cart_line_limit` and the cart is unchanged, while `PUT` of an existing line still works.
4. **AS-04** (forged or tampered cookie) — **Given** the cookies: valid token with one signature character changed, a token without a dot, a token whose cart ID starts with `user:` and carries a signature made with another secret, an empty value, and a 4 KB value, **When** `GET /cart`, **Then** each is treated as "no cart": `200` empty, no cookie set and the claimed ID is never looked up in the store; **When** `PUT`, **Then** a new guest cart and cookie are issued and the claimed cart is untouched; **When** a signed-in user calls `POST /cart/merge` with such a cookie, **Then** `200` with the user's own cart unchanged and the cookie cleared.
5. **AS-05** (merge adds up and caps) — **Given** user cart `{A: 1, B: 19}` and a guest cart `{A: 3, B: 5, C: 2}` (valid cookie), **When** the user calls `POST /cart/merge`, **Then** `200 {lines: [A: 4, B: 20, C: 2], droppedLines: 0}`, the guest cart is gone from the store, and the response clears the cookie (`Set-Cookie: cart=; Max-Age=0; Path=/`).
6. **AS-06** (merge is idempotent and race-safe) — **Given** the same cart as AS-05, **When** two merges with the same cookie run at once (`Promise.all`), **Then** both answer `200`, the user's cart is `{A: 4, B: 20, C: 2}` (the guest quantities were added exactly once); **When** the merge is repeated afterwards, **Then** `200` with the same lines and nothing changes.
7. **AS-07** (line cap on merge) — **Given** a user cart with 40 lines and a guest cart with 20 other products, **When** merging, **Then** the user's cart has exactly 50 lines: the 40 existing and the first 10 guest lines by (`addedAt`, `productId`); the response carries `droppedLines: 10`; the other 10 are discarded with the guest cart.
8. **AS-08** (merge needs a session) — **Given** no credentials, **When** `POST /cart/merge` with a valid guest cookie, **Then** `401` and the guest cart is unchanged; **Given** a signed-in user without any guest cookie, **Then** `200` with the user's cart and no cookie change.
9. **AS-09** (lines expire) — **Given** time frozen and a line set 30 days ago, **When** the clock moves by 1 second more than 30 days, **Then** `GET /cart` no longer returns the line even though the store may still hold it; a line set again (any `PUT` of that product) lives 30 days from that call; other lines keep their own deadline.
10. **AS-10** (cart rate limit) — **Given** one identity (a user, or for a guest the client address) that already made 120 cart writes in the last minute, **When** the 121st `PUT` or `POST /cart/merge` arrives, **Then** `429 rate_limited` with `Retry-After` and nothing is written; reads are not limited by this policy.
11. **AS-11** (guest token, pure) — **Given** the token functions, **When** table-driven over: a freshly issued token, a token with a changed signature, a missing dot, a `user:` prefix, an empty string, a different secret, a token of 4096 characters, **Then** only the freshly issued token verifies; comparison is constant-time and never throws.
12. **AS-12** (merge rule, pure) — **Given** the merge function over `(userLines, guestLines)`, **When** table-driven and property-checked, **Then** every product appears once, `quantity = min(20, user + guest)`, at most 50 lines, the user's lines always survive, `droppedLines` equals the guest lines left out, and merging with an empty guest cart returns the user's lines unchanged.

---

### User Story 2 — A buyer checks out once, however often the request is repeated (Priority: P1)

A signed-in buyer presses "Pay" with a flaky connection. The browser retries; the buyer double-clicks; two tabs fire. Exactly one order is created, the price is computed by the server, one order covers several shops, and the answer says "accepted, payment pending".

**Why this priority**: a double order or a wrong price is direct money loss and a support incident.

**Independent Test**: check out with one key five times at once and then again later; assert one order, one stock deduction and identical answers.

**Acceptance Scenarios**:

1. **AS-13** (checkout, full effect) — **Given** buyer `U`, time frozen at `T`, cart `{A: 2 (shop S1, price 1000), B: 1 (shop S2, price 500)}`, stock `A: 10`, `B: 4`, **When** `POST /checkout` with `Idempotency-Key: k-0001-abcd` and body `{expectedTotalMinor: 2500}`, **Then** `202` with `Location: /api/orders/<id>` and `{orderId, status: "RESERVED", totalMinor: 2500, currency: "EUR", reservedUntil: T+15 min}` parsed by `checkoutResponseSchema`; and exactly: one order (version 1, `RESERVED`), two items with snapshots (`title`, `unitPriceMinor`, `discountMinor: 0`, `lineTotalMinor`), two shop orders (`S1: 2000`, `S2: 500`, both `PENDING`), two reservations `HELD` expiring at `T+15 min`, stock `A: 8`, `B: 3`, two history rows (`∅ → PENDING`, `PENDING → RESERVED`), one `order.reserved` outbox row, one scheduled expiry job at `T+15 min`, one realtime push `order.status RESERVED`, an empty cart, and a completed idempotency record.
2. **AS-14** (prices come from the server) — **Given** `A` was 1000 when added and is 1200 at checkout, **When** the body has no `expectedTotalMinor`, **Then** the order totals 1200 per unit; **When** the body says `expectedTotalMinor: 2000` for `A × 2` while the server computes 2400, **Then** `409 price_changed` with `currentTotalMinor: 2400` and per-line current prices, no order, no stock change, the cart intact and the key unused (a retry with the new total and the same key succeeds); **When** the body carries `items`, `unitPriceMinor` or any other field, **Then** `400 validation_failed` (unknown properties are rejected).
3. **AS-15** (replay) — **Given** AS-13 completed and the order has since become `PAID`, and the buyer put `C` in the cart again, **When** the same key and the same body are sent, **Then** `202` with the original body byte for byte (status `RESERVED` as then) and `Idempotency-Replayed: true`; no new order, event, job or stock change; the cart still holds `C`.
4. **AS-16** (in flight) — **Given** a first request paused inside the stock step (a test gate), **When** a second request with the same key and body arrives, **Then** `409 idempotency_in_flight` with `Retry-After: 1`; **When** the gate opens and the first finishes, **Then** a third attempt replays `202`; one order exists.
5. **AS-17** (concurrent duplicates) — **Given** a cart and key `K`, **When** five identical requests run at once (`Promise.all`), **Then** every response is `202` with the same `orderId` or `409 idempotency_in_flight`, at least one is `202`, exactly one order exists and stock was deducted once.
6. **AS-18** (key misuse) — **Given** key `K` used with `{expectedTotalMinor: 2500}`, **When** it is reused with `{expectedTotalMinor: 3000}` or with no body, **Then** `422 idempotency_key_reuse` and nothing changes; **When** the header is missing, **Then** `422 idempotency_key_required`; **When** the key is `short` (5 characters), 129 characters long or contains a space, **Then** `422 idempotency_key_invalid`; a key is 8–128 characters of `[A-Za-z0-9_-]`.
7. **AS-19** (keys are per buyer) — **Given** buyer `U` used key `K`, **When** buyer `V` (with her own cart) uses the same `K`, **Then** `V` gets her own new order (`202`), not `U`'s answer.
8. **AS-20** (what a key remembers) — **Given** a checkout that failed before any order existed (`cart_empty`, `product_unavailable`, `price_changed`, `checkout_unavailable`), **When** the buyer fixes the cause and retries with the same key, **Then** it is processed afresh (`202`); **Given** a checkout that created an order and then failed on stock (`422 out_of_stock`), **When** the same key is sent again, **Then** the same `422 out_of_stock` problem is replayed with `Idempotency-Replayed: true` (the outcome is final for that key, and no new attempt is made), and a new key attempts again.
9. **AS-21** (access and validation) — **Given** no credentials, **Then** `401`; **Given** only a guest cookie, **Then** `401`; **Given** an empty cart, **Then** `422 cart_empty`; **Given** a line whose product does not exist, is archived, belongs to a sandbox shop, or belongs to a shop that is not `ACTIVE`, **Then** `422 product_unavailable` with `productIds` listing every such product and nothing is reserved; **Given** lines of two currencies, **Then** `422 mixed_currency`; in every case no order, no stock change, and the cart is intact.
10. **AS-22** (multi-shop split) — **Given** a cart with 5 lines from shops `S1` (2 lines), `S2` (2), `S3` (1), **When** checking out, **Then** one order and exactly three shop orders; each shop order's `subtotalMinor` equals the sum of its own lines' `lineTotalMinor`; the three subtotals add up to the order `totalMinor`; every item carries its `shopId`; a product without a shop is `product_unavailable`.
11. **AS-23** (discount allocation, pure) — **Given** a shop discount of `100` over lines with gross amounts `3333, 3333, 3334`, **When** allocated, **Then** the lines receive `33, 33, 34` (largest remainder, ties by line position), the sum is exactly `100`, no line gets more than its gross amount, and a discount larger than the shop's gross total is refused by the allocator (property: for random gross vectors and discounts, the sum is exact, each share is within one minor unit of the exact proportional share, and the result is deterministic).
12. **AS-24** (seller discounts, fail-safe) — **Given** a discount source returning `{shopId: S1, discountMinor: 300}` for a shop whose lines grossed 2000, **When** checking out, **Then** the shop subtotal is 1700, the order total is reduced by 300, items store their allocated `discountMinor`, and the order total is the sum of the shop subtotals; **Given** the source times out (over 250 ms), throws, or returns a negative, non-integer, larger-than-gross or unknown-shop amount, **Then** the order uses catalogue prices for the affected shops (or all, on timeout or error), still answers `202`, increments `orders_discount_fallback_total{reason}` and logs a warning without the discount payload.
13. **AS-25** (money invariants, pure) — **Given** random carts (property test, 10,000 cases) with random prices, quantities up to 20, up to 50 lines, up to 10 shops and random shop discounts, **Then** all amounts are integers, `lineTotal = unitPrice × quantity − discount ≥ 0`, each shop subtotal equals the sum of its lines, the order total equals the sum of the shop subtotals, and re-computing from the stored snapshots gives the same numbers.
14. **AS-26** (checkout rate limit) — **Given** a buyer who made 10 checkout requests in the last minute (any outcome), **When** the 11th arrives, **Then** `429 rate_limited` with `Retry-After` and no order is created; **Given** the limiter's store is down (forced), **Then** the request is refused the same way (fail closed).
15. **AS-27** (one checkout per buyer at a time) — **Given** two tabs with the same cart, **When** two checkouts with different keys run at once, **Then** exactly one answers `202` and the other `409 checkout_in_progress` (or, if it ran after the first finished, `422 cart_empty`); exactly one order exists.
16. **AS-28** (cart consumption) — **Given** cart `{A: 2}` and a checkout paused after the cart was read, **When** the buyer changes `A` to 3 and adds `C: 1` and the checkout then completes, **Then** the order holds `A × 2` and the cart still holds `{A: 3, C: 1}` (a line is removed only if its quantity still equals what the order took).
17. **AS-29** (cart cleanup failure) — **Given** the cart store refuses the cleanup after the order was created (forced), **When** the checkout finishes, **Then** it still answers `202` and the order is valid; a cleanup job retries (at most 5 attempts, backoff) and removes the consumed lines; a failing job is logged and counted (`orders_cart_cleanup_failed_total`), never silent.
18. **AS-30** (time budgets) — **Given** the catalog's product read takes longer than 1 s (forced), **When** checking out, **Then** `503 checkout_unavailable` with `Retry-After: 2`, no order exists and the key is unused; **Given** the stock call takes longer than 2 s (forced), **Then** `503 checkout_unavailable`, the order stays `PENDING` (recovered by AS-39) and a retry with the same key answers `409 idempotency_in_flight` until it is resolved, then replays the resolved outcome; the whole request never runs longer than 10 s.

---

### User Story 3 — Stock is never oversold and always comes back (Priority: P1)

Two hundred buyers want the last 50 units. Exactly 50 get a hold; nobody ends with a negative stock; a hold that is not paid within 15 minutes returns its units once, even if jobs crash, run twice or the stock service hiccups.

**Why this priority**: "never sell stock you don't have" is the key invariant of the whole design (note 10/07 §19).

**Independent Test**: 200 concurrent checkouts on 50 units; then let holds expire with the clock; assert counts and the stock level.

**Acceptance Scenarios**:

1. **AS-31** (reserve through the catalog) — **Given** stock `A: 10` and a cart `A × 3`, **When** checking out, **Then** the catalog receives one stock command with operation `orders:<orderId>:reserve:A`, delta `-3`, reason `order.reserve`; stock is 7; replaying that operation (as the recovery does) changes nothing; no query of this domain touches the product table.
2. **AS-32** (no oversell under race) — **Given** stock `A: 50` and 200 buyers, each with `A × 1` and a distinct key, **When** the 200 checkouts run at once over HTTP, **Then** exactly 50 answer `202` and 150 answer `422 out_of_stock` with `productIds: [A]`; stock is exactly 0 and never observed below 0; exactly 50 orders are `RESERVED`; the 150 others are `CANCELLED` with reason `out_of_stock` (never reserved), have no reservation, and emit no `order.reserved`.
3. **AS-33** (all or nothing) — **Given** stock `A: 5`, `B: 1` and a cart `A × 1, B × 2`, **When** checking out, **Then** `422 out_of_stock` with `productIds: [B]`, stock `A` is still 5 (no partial hold), the order is `CANCELLED(out_of_stock)` with no `HELD` reservation and no `order.reserved` event.
4. **AS-34** (no deadlock) — **Given** two groups of buyers whose carts hold products `A` and `B` added in opposite order, stock large enough, **When** 100 checkouts of each group run at once, **Then** all 200 answer `202`, none answers `5xx`, and both stocks equal the initial value minus the total sold.
5. **AS-35** (stock operations sorted, pure) — **Given** the function that builds the stock command from order lines, **When** given lines in any order, with a repeated product and with 100 products, **Then** operations are sorted by ascending product ID, each product appears once with the summed quantity, operation IDs follow `orders:<orderId>:reserve:<productId>`, and the count never exceeds the catalog's 100-operation limit (carts are limited to 50 lines).
6. **AS-36** (hold expiry) — **Given** a `RESERVED` unpaid order with `reservedUntil = T+15 min`, **When** time is frozen at `T+15 min − 1 s` and the expiry job runs, **Then** nothing changes; **When** at `T+15 min` it runs, **Then** the order is `CANCELLED(hold_expired)`, reservations are released (`RELEASED`), stock is back (+qty per line, operations `orders:<orderId>:release:<productId>`), one `order.cancelled` event exists, the buyer gets one realtime push; **When** the job runs again, **Then** nothing changes (no second event, no second stock change).
7. **AS-37** (sweeper backstop) — **Given** an expired `RESERVED` order whose expiry job was lost (deleted), **When** the periodic sweeper runs (also twice at once on two instances), **Then** the order is cancelled exactly once as in AS-36; the sweeper takes at most 200 orders per run and skips orders that are not expired.
8. **AS-38** (release fails, then succeeds) — **Given** an order being cancelled and the stock command failing once (forced), **When** the cancel is committed, **Then** the order is `CANCELLED`, its reservations are `RELEASE_PENDING`, `orders_reservations_release_pending` is 1 and the caller still gets its answer; **When** the release job runs again, **Then** the stock is restored exactly once and the reservations are `RELEASED`; **Given** the first release actually reached the catalog but its answer was lost, **When** the job retries, **Then** the catalog reports the operation as replayed and stock is not added twice.
9. **AS-39** (recovery of `PENDING`) — **Given** an order stuck in `PENDING` for more than 60 s (the process died after the order was written but before or after the stock command), **When** the recovery job runs (twice, and on two instances), **Then** it repeats the stock command with the same operation IDs: the order becomes `RESERVED` with stock deducted once (also when the first attempt had applied), or `CANCELLED(out_of_stock)` when stock is gone; an order younger than 60 s is untouched.
10. **AS-40** (buyer cancels) — **Given** a `RESERVED` order, **When** its buyer calls `POST /orders/<id>/cancel`, **Then** `200 orderSchema` with `status: CANCELLED`, reason `user_cancelled`, stock restored once, one `order.cancelled` event; another user's call gets `404 order_not_found` and changes nothing.

---

### User Story 4 — The payment provider's signed webhook, and only it, marks an order paid (Priority: P1)

The provider calls back, possibly twice, late, out of order or with a forged body. A genuine "payment succeeded" turns the reserved order into a paid one exactly once; everything else leaves the order alone and is accounted for.

**Why this priority**: marking an order paid from an unverified or repeated signal ships goods for free or double-processes a sale.

**Independent Test**: post a correctly signed success event ten times at once and a forged one; assert one `PAID` transition, one event, and a rejected forgery.

**Acceptance Scenarios**:

1. **AS-41** (success is acknowledged first, applied after) — **Given** a `RESERVED` order of total 2500 EUR and a signed `payment_intent.succeeded` event whose intent metadata carries `orderId`, `amount_received: 2500`, `currency: "eur"`, **When** it is posted to `POST /webhooks/stripe`, **Then** `200 {received: true}` is returned after the event was stored and its processing queued, and while the processing has not yet run the order is still `RESERVED`; **When** the processing job runs, **Then** it asks the payments capability for the payment's status (`COMPLETED`, same amount and currency), the order becomes `PAID` (version +1), reservations `CONVERTED`, shop orders `PAID`, one history row, one `order.paid` outbox row (with the lines and the shop split), one realtime push, and the stored event is `PROCESSED`.
2. **AS-42** (signature) — **Given** a valid body, **When** sent with: no `Stripe-Signature` header; a signature made with another secret; the right signature over a body changed by one byte; a right signature over a re-serialised (different whitespace) copy of the body; a timestamp 301 s in the past; a timestamp 301 s in the future; or a malformed header, **Then** each answers `400 invalid_signature`, nothing is stored, no job is queued; **When** the timestamp is exactly 300 s old, **Then** it is accepted.
3. **AS-43** (duplicate delivery) — **Given** an event `evt_1` already stored, **When** it is posted again, sequentially or ten times at once, **Then** each answers `200 {received: true, duplicate: true}` except the first, there is one stored event, one queued job and one transition.
4. **AS-44** (failure after the acknowledgement) — **Given** the status check at the payments capability is unavailable (forced), **When** the job runs, **Then** the event stays `RECEIVED`, the job is retried with exponential backoff and jitter (at most 8 attempts); **When** the capability recovers, **Then** the order becomes `PAID` once; **When** all 8 attempts fail, **Then** the event is `FAILED`, the job is dead-lettered, `orders_webhook_events_total{result="failed"}` increments and the order stays `RESERVED` (the hold then expires normally); the webhook response was `200` in every case.
5. **AS-45** (amount or currency mismatch) — **Given** a signed success event whose amount is 100 less than the order total, or whose currency differs, or whose payment status at the payments capability is not `COMPLETED` after the retries, **When** processed, **Then** the order is not paid, the stored event is `REJECTED` with reason `amount_mismatch`, `currency_mismatch` or `payment_not_completed`, a warning is logged and `orders_webhook_events_total{result="rejected"}` increments; the response was `200` and the event is not retried by the provider.
6. **AS-46** (unmatched and unhandled events) — **Given** a signed event whose metadata has no `orderId`, or an `orderId` that matches no order, **Then** it is stored as `UNMATCHED` (`200`, no retry); **Given** a signed event of an unhandled type (`customer.created`), **Then** it is stored as `IGNORED` (`200`).
7. **AS-47** (out-of-order and late events) — **Given** an order already `PAID`, **When** a stored `payment_intent.payment_failed` is processed afterwards, **Then** nothing changes and the event is `IGNORED` with reason `order_already_paid`; **Given** an order that was `CANCELLED` by hold expiry, **When** a genuine `payment_intent.succeeded` for it is processed, **Then** the order stays `CANCELLED`, exactly one command `orders.refund_requested {orderId, paymentRef, amountMinor, currency, reason: "order_cancelled"}` is emitted through the outbox, the event is `PROCESSED`, and processing the same payment again (a second event or the consumer of AS-50) emits no second command.
8. **AS-48** (payment failed) — **Given** a `RESERVED` order, **When** a genuine `payment_intent.payment_failed` is processed, **Then** the order is `CANCELLED(payment_failed)`, stock released once, one `order.cancelled` event; **Given** `PENDING` or already `CANCELLED`, **Then** nothing changes.
9. **AS-49** (refund) — **Given** a `PAID` or `FULFILLING` order, **When** a genuine `charge.refunded` for the full amount is processed, **Then** the order is `REFUNDED`, one `order.refunded` event, reservations stay `CONVERTED` (stock is not restocked here); a partial amount leaves the status and records a history row `partial_refund` with the amount; **Given** a refund event for a `RESERVED` order (arrived before the success), **Then** the job is retried (AS-44 rules) and applies after the order becomes `PAID`, or ends `FAILED` after 8 attempts.
10. **AS-50** (payment results from the payments capability) — **Given** the topic `payments.events` carrying `payments.payment_succeeded {paymentId, orderId, userId, amountMinor, currency, occurredAt}`, **When** the same message is delivered twice, **Then** one transition and one `order.paid`; **When** the message has a missing `orderId`, a negative amount, a non-UUID `orderId` or an unknown type, **Then** it is dead-lettered without effect and the next message is processed; **When** the webhook of AS-41 and this message for the same payment race, **Then** exactly one `PAID` transition and one `order.paid` exist; `payments.payment_failed` and `payments.payment_refunded` follow AS-48 and AS-49.
11. **AS-51** (pay versus cancel race) — **Given** a `RESERVED` order, **When** the buyer's cancel and the success processing run at once (`Promise.all`, repeated 50 times), **Then** each run ends with exactly one outcome: `PAID` (and the cancel answers `409 order_not_cancellable`) or `CANCELLED` (and a refund command was requested for the payment); never both, the stock is consistent with the outcome (kept if paid; restored exactly once if cancelled), and exactly one of `order.paid` or `order.cancelled` exists.
12. **AS-52** (transport limits and secret rotation) — **Given** a body larger than 64 KiB, **Then** `413`, nothing stored; **Given** a valid signature over a body that is not JSON or lacks `id` and `type`, **Then** `400 invalid_payload`, nothing stored; **Given** the previous webhook secret is still configured during rotation, **Then** a signature made with it is accepted and one made with any other secret is refused; **Given** a `GET` to the route, **Then** `405`; **Given** 301 forged requests from one address within a minute, **Then** further ones are answered `429`.
13. **AS-53** (signature check, pure) — **Given** the verification function over `(rawBody, header, secrets, now)`, **When** table-driven over header forms (`t=…,v1=…`, several `v1`, unknown scheme tags, repeated `t`, non-numeric `t`, empty), clock edges (−300 s, −301 s, +300 s, +301 s) and one or two secrets, **Then** it accepts exactly the valid combinations, compares in constant time, never throws other than its typed error, and never reads the clock itself.

---

### User Story 5 — The order only moves along legal paths, and every move is recorded (Priority: P2)

An order is a state machine: every command is allowed from specific states only, a move is a conditional change with one history row and one event, and a stale or duplicate trigger loses cleanly.

**Why this priority**: it is the contract between payment, stock, fulfilment, notifications and the ledger.

**Independent Test**: table-driven pure test over every (state, command) pair, then API tests for the guarded endpoints and a concurrent-trigger test.

**Acceptance Scenarios**:

1. **AS-54** (transition table, pure) — **Given** the 8 statuses and the commands `reserve`, `markPaid`, `cancel(reason)`, `startFulfilment`, `ship`, `deliver`, `refund`, **When** table-driven over every (status, command, reason) combination, **Then** exactly these are allowed: `reserve: PENDING → RESERVED`; `markPaid: RESERVED → PAID`; `cancel(out_of_stock): PENDING → CANCELLED`; `cancel(payment_failed | hold_expired | user_cancelled): RESERVED → CANCELLED`; `startFulfilment: PAID → FULFILLING`; `ship: FULFILLING → SHIPPED`; `deliver: SHIPPED → DELIVERED`; `refund: PAID | FULFILLING → REFUNDED`; every other combination is illegal; `CANCELLED`, `REFUNDED`, `DELIVERED` are terminal; a command whose target equals the current status is reported as "already applied" (not illegal) only for `markPaid`, `cancel`, `refund`; the exhaustive switch over commands and statuses fails type-checking when a new member is added without handling.
2. **AS-55** (illegal transitions at the API) — **Given** a `PAID` order, **When** its buyer posts `/orders/<id>/cancel`, **Then** `409 order_not_cancellable` with `currentStatus: "PAID"` and nothing changes; the same for `FULFILLING`, `SHIPPED`, `DELIVERED`, `REFUNDED`; **Given** an already `CANCELLED` order, **Then** `200` with the order unchanged and no second event or stock change; **Given** an unknown or other user's order, **Then** `404 order_not_found` (identical bodies); a non-UUID id answers `400`; no credentials answer `401`.
3. **AS-56** (history and guarded updates) — **Given** the order of AS-13 taken through `PAID → FULFILLING → SHIPPED → DELIVERED`, **Then** each move has exactly one history row `{fromStatus, toStatus, reason, actor, at}` in order and the order's `version` rises by exactly 1 per move; **When** two triggers of the same move run at once (`Promise.all`, 20 copies), **Then** one applies, the others report "already applied" or `409`, and there is one history row, one version step and one event.
4. **AS-57** (lifecycle commands for fulfilment) — **Given** `OrderFulfilmentService.apply(orderId, command)` and a `PAID` order, **When** called with `startFulfilment`, `ship {trackingCode}`, `deliver` in order, **Then** the statuses follow and each emits `order.fulfilment_changed {orderId, status, orderVersion, trackingCode?}`; **When** called with `ship` on a `PAID` order or any command on a `CANCELLED` order, **Then** it throws `InvalidOrderTransitionError {orderId, currentStatus, command}` and nothing changes; an unknown order throws `OrderNotFoundError`.

---

### User Story 6 — Buyers see their orders; sellers see their shop's orders; nobody sees anyone else's (Priority: P2)

A buyer follows an order and browses a long history. A seller lists the orders that contain their products without seeing other shops' lines. Other capabilities read orders through exported services, never through the tables.

**Why this priority**: orders contain money and personal data; tenancy mistakes here are incidents.

**Independent Test**: create orders for two buyers and two shops; call every read with every principal; assert bodies and counts.

**Acceptance Scenarios**:

1. **AS-58** (read one order) — **Given** an order of buyer `U`, **When** `U` calls `GET /orders/<id>`, **Then** `200 orderSchema` with `status`, `totalMinor`, `currency`, `reservedUntil`, `items` (snapshots), `shopOrders`, and `timeline` (history, oldest first, `{status, reason, at}`); **When** buyer `V`, a member of one of the shops, or an admin without being the buyer calls it, **Then** `404 order_not_found`, byte-identical to the answer for a non-existing id; no credentials → `401`; a malformed id → `400`; no ORM field (internal IDs, idempotency key, request hash) appears.
2. **AS-59** (history, keyset) — **Given** 45 orders of one buyer, some with the same creation instant, plus orders of others and 5 `CANCELLED(out_of_stock)` ones, **When** `GET /orders?limit=20` is followed through `nextCursor`, **Then** pages hold 20, 20, 5 items ordered newest first with the order ID as tiebreaker, no repeat or skip even when new orders appear meanwhile, `nextCursor: null` at the end, each item `{id, status, totalMinor, currency, createdAt}`, only the buyer's own orders, never the `out_of_stock` ones; a default of 20 and a maximum of 100; `limit=0`, `101`, `abc`, a tampered or another buyer's cursor → `400` (`validation_failed` or `invalid_cursor`).
3. **AS-60** (history is index-only) — **Given** 10,000 orders of one buyer in a prepared database, **When** the history query's plan is read, **Then** it is an index-only scan on the buyer's history index (no sort node, no heap fetch for `status` and `totalMinor`).
4. **AS-61** (seller's list) — **Given** one order with items of shops `S1` and `S2`, members of `S1` in every role, a member of `S2` only, a non-member and an anonymous caller, **When** each calls `GET /shops/S1/orders?status=PAID&limit&cursor`, **Then** every role of `S1` gets `200 shopOrderPageSchema` (items ordered newest first with ID tiebreaker, `{shopOrderId, orderId, status, subtotalMinor, currency, buyerId, createdAt, items}`) with only `S1`'s items and subtotal (nothing of `S2`'s lines or the order's total), the `S2`-only member and the non-member get `404 shop_not_found`, anonymous gets `401`, and a shop that is not `ACTIVE` follows the status gate of S03; `status` outside the list and a bad cursor answer `400`.
5. **AS-62** (exported reads) — **Given** `OrderQueryService`, **When** `getOrdersForShop(S1, {status?, limit ≤ 100, cursor?})` is called, **Then** it returns the same page as AS-61; **When** `getOrderLines(orderIds)` is called with up to 500 IDs, **Then** it returns `Map<OrderId, OrderLineDto[]>` from one query (`{orderId, shopOrderId, productId, shopId, title, quantity, unitPriceMinor, discountMinor, lineTotalMinor}`), unknown IDs are absent, more than 500 throws `TooManyIdsError`; neither method returns a model; the barrel exports no `*Model`.
6. **AS-63** (is this order payable?) — **Given** `OrderQueryService.getPayableOrder(orderId, userId)`, **When** the order is the user's, `RESERVED` and not expired, **Then** it returns `{orderId, userId, totalMinor, currency, reservedUntil, shopAllocations: [{shopId, subtotalMinor}]}`; **When** the order is expired, `PENDING`, `PAID`, `CANCELLED` or other states, **Then** it throws `OrderNotPayableError {orderId, status, code: 'order_not_reserved' | 'hold_expired'}`; **When** it belongs to another user or does not exist, **Then** it throws `OrderNotFoundError` (same error for both).

---

### User Story 7 — Everything else in the platform can rely on the order's events and on clean boundaries (Priority: P3)

Fulfilment, receipts, the ledger saga, sales dashboards and webhooks to sellers react to order events that are never lost and never invented; this domain touches nothing it does not own.

**Why this priority**: it is what lets other capabilities stay decoupled; it is verified once, here.

**Independent Test**: parse every emitted event with the contracts schema, force a failure inside a transition, and run the ownership check.

**Acceptance Scenarios**:

1. **AS-64** (events are atomic with the change) — **Given** each transition (reserve, paid, cancel, refund, fulfilment moves), **Then** exactly one outbox row `order.reserved | order.paid | order.cancelled | order.refunded | order.fulfilment_changed` exists per transition with the envelope `{eventId, type, version: 1, occurredAt, aggregateId: orderId}` and a payload parsed by `orderEventSchemas`, including a strictly increasing `orderVersion`; **When** the outbox write fails inside a transition (forced), **Then** the order status, history, reservations and stock are unchanged (the whole transition rolled back) and the caller gets a retryable `503`.
2. **AS-65** (realtime is best effort) — **Given** the realtime hub is down (forced), **When** an order is paid, **Then** the transition and its events commit and the failure is only logged and counted; the buyer's `GET /orders/<id>` shows the new status.
3. **AS-66** (observability) — **Given** captured logs and metrics of AS-13, AS-41, AS-42 and AS-44, **Then** every log line is JSON with `requestId` or `traceId`, checkout and webhook lines carry `orderId`; no line contains the webhook body, the signature header, a secret, a cookie, an authorization header or an idempotency key; metrics exist for `orders_checkout_total{outcome}`, `orders_reservation_expired_total`, `orders_reservations_release_pending`, `orders_webhook_events_total{result}`, `orders_discount_fallback_total{reason}`, `orders_cart_cleanup_failed_total`, and `orders_paid_after_cancel_total`.
4. **AS-67** (jobs) — **Given** the scheduled work (expiry per order, sweeper every 60 s, `PENDING` recovery every 30 s, release retry every 30 s, cart cleanup per order, webhook processing per event, inbox purge daily), **When** each is triggered twice or on two instances at once, **Then** each effect happens once; the inbox purge removes stored webhook events older than 35 days (frozen time: 35 d + 1 s removed, 35 d kept) and nothing else.
5. **AS-68** (boundaries, static) — **Given** the repository after the change, **Then** `pnpm --dir packages/backend check:table-ownership --strict` reports 0 findings for `orders`; the domain's modules register only models of tables it owns; the models have no associations to `User`, `Product` or `Payment` models; `pnpm check:boundaries` is green; the barrel exports no `*Model`, no infra class and no job handler; every table owned is in the ownership registry.

---

### Edge Cases

- **Double submit and retries**: AS-15, AS-16, AS-17, AS-18, AS-19, AS-20, AS-27.
- **Concurrency on stock and state**: AS-32, AS-34, AS-39, AS-51, AS-56.
- **Prices and money**: AS-14, AS-23, AS-24, AS-25.
- **Illegal transitions**: AS-54, AS-55, AS-57.
- **Cross-tenant and cross-user access**: AS-02, AS-40, AS-58, AS-61, AS-63.
- **Limits**: AS-03, AS-07, AS-10, AS-26, AS-52, AS-59.
- **Timeouts and partial failure**: AS-29, AS-30, AS-38, AS-39, AS-44, AS-64.
- **Duplicate, late and out-of-order events**: AS-43, AS-47, AS-49, AS-50.
- **Forged and tampered input**: AS-04, AS-11, AS-42, AS-53.
- **Expiry**: AS-09, AS-36, AS-37.
- **Payment after the hold expired**: AS-47 (refund request instead of resurrecting the order).
- **Cart changed during checkout**: AS-28.
- **Seller deletes or archives a product while it is in a cart**: the cart keeps the line; checkout answers `product_unavailable` (AS-21).
- **A shop is suspended after a reservation**: the order is not touched; payment and fulfilment follow their own rules.
- **Provider outage**: no signal arrives; the hold expires (AS-36); late signals are handled (AS-47).

## Requirements *(mandatory)*

### Functional Requirements

**Cart**

- **FR-001**: A cart belongs to exactly one identity: a signed-in user, or a guest identified by a signed cookie. No route accepts a cart ID (AS-01, AS-02).
- **FR-002**: Cart reads and writes use only the cart store; no relational query happens on these routes (AS-01).
- **FR-003**: `PUT /cart/items/:productId` sets (not adds) a quantity of 0–20; `0` removes the line; a cart has at most 50 lines; violations answer `400` or `422 cart_line_limit` (AS-03).
- **FR-004**: A guest cart is addressed by a cookie that is HttpOnly, `SameSite=Lax`, `Secure` outside local, 30 days, carrying a random ID and an HMAC signature made with a dedicated secret that startup validation requires; the secret is never shared with token signing. A cookie that fails verification is the same as no cookie (AS-01, AS-04, AS-11).
- **FR-005**: `GET /cart` never issues a cookie; the first write by a guest issues it. A signed-in caller always uses the user's cart and the guest cookie is left alone except by merge (AS-01, AS-02).
- **FR-006**: Cart lines expire 30 days after they were last set, and expired lines are never returned even if the store still holds them (AS-09).
- **FR-007**: `POST /cart/merge` requires a session, adds the guest quantities to the user's (cap 20 per line), enforces 50 lines (user's lines win, guest lines in `addedAt, productId` order), reports `droppedLines`, deletes the guest cart, and always clears the cookie (AS-05, AS-07, AS-08, AS-12).
- **FR-008**: Merge is idempotent and race-safe: the guest quantities are added exactly once however many merges run, in any interleaving (AS-06).
- **FR-009**: Cart writes are rate limited per identity (policy `orders.cart-write.identity`, 120 per minute, fail open) with `429` and `Retry-After` (AS-10).
- **FR-010**: The cart returns product IDs, quantities and `addedAt` only; titles, prices and images are composed by the BFF (IX.7 R2) and never copied into the cart (AS-01).

**Checkout**

- **FR-011**: `POST /checkout` requires a session (`401` otherwise), the `Idempotency-Key` header (8–128 characters of `[A-Za-z0-9_-]`) and an optional body `{expectedTotalMinor}`; unknown body properties are rejected with `400` (AS-14, AS-18, AS-21).
- **FR-012**: Idempotency follows the platform contract (V.6): a replay of a completed request returns the stored status, body and `Idempotency-Replayed: true`; a duplicate while the first is running answers `409 idempotency_in_flight` with `Retry-After: 1`; the same key with a different body (or none) answers `422 idempotency_key_reuse`; a missing or malformed key answers `422 idempotency_key_required` / `idempotency_key_invalid`; keys live 24 hours and are scoped per buyer (AS-15–AS-19).
- **FR-013**: A failure before an order exists releases the key; once an order exists for a key, the outcome (including `out_of_stock`) is final for that key and replayed as stored (AS-20).
- **FR-014**: Every price, currency and shop is read from the catalog on the server in one batched call; client prices are never accepted; when `expectedTotalMinor` is present and differs from the server's total the answer is `409 price_changed` with `currentTotalMinor` and nothing is created (AS-14).
- **FR-015**: A line is purchasable only if the product exists, is `ACTIVE`, is not sandbox, has a shop, and the shop is `ACTIVE` (checked through the tenancy capability's exported lookup); otherwise `422 product_unavailable` lists every unpurchasable product; an empty cart is `422 cart_empty`; one order has one currency (`422 mixed_currency`) (AS-21).
- **FR-016**: Checkout answers `202` with `Location` and `{orderId, status: "RESERVED", totalMinor, currency, reservedUntil}`; the payment follows asynchronously (AS-13).
- **FR-017**: One order splits into one shop order per distinct shop; each shop order's subtotal equals the sum of its lines; the order total equals the sum of the subtotals (AS-22, AS-25).
- **FR-018**: Seller discounts are requested through the discount port as shop-level amounts, validated (integer, ≥ 0, ≤ shop gross, known shop), allocated to lines by the largest-remainder method (ties by line position), and applied; on timeout (250 ms), error or invalid result catalogue prices are used for the affected shops and the fallback is counted (AS-23, AS-24).
- **FR-019**: Money is integer minor units everywhere (order, items, shop orders, events, API); line total = unit price × quantity − discount ≥ 0; totals never come from floating-point arithmetic (AS-23, AS-25).
- **FR-020**: Items store a snapshot of title, unit price, discount and shop at purchase; no later catalog change alters an order (AS-13, AS-58).
- **FR-021**: Checkout is rate limited per buyer (`checkout.create`, 10 per minute, fail closed) with `429` and `Retry-After` (AS-26).
- **FR-022**: At most one checkout per buyer runs at a time; a concurrent one with another key answers `409 checkout_in_progress` (AS-27).
- **FR-023**: After the order is reserved, only the lines whose quantity still equals what the order took are removed from the cart; failed cleanup is retried by a job and counted (AS-28, AS-29).
- **FR-024**: Checkout runs within a 10 s budget; the catalog read has a 1 s timeout, the stock call 2 s; timeouts answer `503 checkout_unavailable` with `Retry-After: 2` (AS-30).

**Stock reservation (saga)**

- **FR-025**: The order is written first (`PENDING`, lines, shop orders, reservation rows) and committed; then the stock is reserved through the catalog's stock command; then the order moves to `RESERVED` with its events and expiry job in one transaction. No transaction spans two domains (AS-13, AS-31).
- **FR-026**: Stock changes only through `applyStockDelta` with operation IDs `orders:<orderId>:reserve:<productId>` and `orders:<orderId>:release:<productId>` (reasons `order.reserve`, `order.release`); all lines of an order go in one call sorted by ascending product ID (AS-31, AS-34, AS-35).
- **FR-027**: A rejected reservation (any line short) holds nothing and cancels the order with reason `out_of_stock`; the buyer gets `422 out_of_stock` with `productIds` (AS-32, AS-33).
- **FR-028**: The hold lasts 15 minutes from the time of reservation (`reservedUntil`); `reservedUntil` is exposed to the buyer (AS-13).
- **FR-029**: Expiry: a per-order delayed job and a periodic sweeper (every 60 s, ≤ 200 orders per run, claimed so two instances never take the same order) cancel unpaid `RESERVED` orders with reason `hold_expired` (AS-36, AS-37).
- **FR-030**: Cancelling moves `HELD` reservations to `RELEASE_PENDING` in the same transaction as the order move; the stock release (new operation IDs, idempotent) follows; a retrying job releases what failed; stock is restored exactly once (AS-36, AS-38, AS-40).
- **FR-031**: An order stuck in `PENDING` for more than 60 s is recovered by repeating the same stock operations: it becomes `RESERVED` or `CANCELLED(out_of_stock)`; recovery is safe to repeat and to run concurrently (AS-39).
- **FR-032**: The seam for flash-sale stock: a reservation has a source (`CATALOG` here), and reserve, release and convert are performed by the source's port; this capability implements the `CATALOG` source and provides the port to S11 (AS-31).

**Payment webhook and payment results**

- **FR-033**: `POST /webhooks/stripe` needs no session; it verifies the signature over the raw body with constant-time comparison, accepts a timestamp within ±300 s, and accepts the current and, during rotation, the previous secret; secrets are configuration validated at startup (AS-42, AS-52, AS-53).
- **FR-034**: Verified events are stored once per provider event ID and queued for processing in the same transaction; the route answers `200` after that, never after processing; a duplicate answers `200 {received: true, duplicate: true}` (AS-41, AS-43).
- **FR-035**: Processing finds the order from the intent metadata `orderId` (never from a payment table of another domain), confirms the payment's status, amount and currency through the payments capability's exported status service, and only then applies `markPaid` (AS-41, AS-45).
- **FR-036**: Processing failures are retried with exponential backoff and full jitter (≤ 8 attempts), then the event is `FAILED` and dead-lettered; a failure never loses the event and never blocks other events (AS-44).
- **FR-037**: Stored events end in one of `PROCESSED`, `IGNORED`, `UNMATCHED`, `REJECTED`, `FAILED`, each counted in a metric (AS-44–AS-46).
- **FR-038**: Late or out-of-order events never corrupt the order: a failure after success is ignored; a success after cancellation leaves the order cancelled and requests a refund exactly once per payment; a refund before success is retried (AS-47, AS-49).
- **FR-039**: `payment_intent.payment_failed` cancels a `RESERVED` order (reason `payment_failed`) and releases its stock; `charge.refunded` refunds a `PAID` or `FULFILLING` order (partial amounts only add a history row) (AS-48, AS-49).
- **FR-040**: The consumer of `payments.events` validates every message against its schema, is idempotent, dead-letters invalid messages, and converges with the webhook on the same guarded transitions (AS-50).
- **FR-041**: A payable order is answered through `OrderQueryService.getPayableOrder`, so the payments capability takes amount and currency from the order, never from the client (AS-63).
- **FR-042**: The webhook route's body is capped at 64 KiB and its failed-signature traffic is rate limited per address (`orders.webhook.ip`, 300 per minute, fail open) (AS-52).

**State machine**

- **FR-043**: The order's status is one of 8 values and moves only by the commands of AS-54; every move is a conditional change from the expected status, one history row (from, to, reason, actor, time) and an incrementing `version`, plus the events of AS-64, in one transaction (AS-54, AS-56).
- **FR-044**: Triggers that race (webhook, consumer, expiry, buyer cancel) cannot apply a move twice; the loser reports "already applied" (idempotent commands) or `409` (illegal) (AS-51, AS-56).
- **FR-045**: The buyer can cancel only a `RESERVED` order; cancelling a `CANCELLED` order is a no-op `200`; any other status answers `409 order_not_cancellable` (AS-40, AS-55).
- **FR-046**: Shop orders follow the order: `PENDING` while `PENDING` or `RESERVED`, `PAID`, `CANCELLED`, `REFUNDED`; fulfilment commands move the order only (AS-41, AS-57).
- **FR-047**: Fulfilment commands are available only through `OrderFulfilmentService.apply` with the same guards and events (AS-57).

**Reads and exports**

- **FR-048**: `GET /orders/:orderId` returns the buyer's own order only; every other principal gets the same `404 order_not_found` as for a missing order (AS-58).
- **FR-049**: `GET /orders` is keyset paginated with an opaque cursor, a deterministic order ending in the order ID, default 20, maximum 100, only the buyer's orders, excluding `CANCELLED(out_of_stock)`; it is served by a covering index (AS-59, AS-60).
- **FR-050**: `GET /shops/:shopId/orders` requires membership with `orders.read`; it returns only that shop's slice; answers follow S03's order (`401`, `404`, `403`, status gate) (AS-61).
- **FR-051**: Exported reads are `getOrdersForShop`, `getOrderLines` (batch, ≤ 500) and `getPayableOrder`; they return DTOs, never models (AS-62, AS-63).
- **FR-052**: Responses are explicit DTOs parsed by `packages/contracts` schemas; no persistence field is serialised (AS-58).

**Events, operations, boundaries**

- **FR-053**: Every transition appends its event to the outbox in the same transaction; events carry the envelope and `orderVersion`; their payload schemas are in `packages/contracts` (AS-64).
- **FR-054**: After commit, a best-effort realtime push `order.status {orderId, status, orderVersion}` goes to the buyer's topic; its failure never affects the transition (AS-65).
- **FR-055**: Logs and metrics follow AS-66; no secret, signature, cookie or webhook body is logged.
- **FR-056**: Every job is single-run per schedule across replicas and idempotent; the inbox purge removes events older than 35 days (AS-67).
- **FR-057**: This domain reads and writes only the tables it owns (`BisOrder`, `BisOrderItem`, `ShopOrder`, `OrderEvent`, `StockReservation`, and the webhook inbox rows through the inbox service of S53); products, stock, shops and payments are reached only through R1 exports; user IDs are plain IDs without associations (AS-68).
- **FR-058**: Time comes from an injected clock; all timeouts, hold length, limits and retry counts are configuration with the defaults of this spec, validated at startup (AS-13, AS-36).
- **FR-059**: Every state-changing route has the mandatory API cases of constitution VII.3 (401, validation classes, IDOR, idempotency, rate limit, illegal transition, concurrency) as the scenarios above (AS-03, AS-10, AS-18, AS-21, AS-26, AS-32, AS-55, AS-58).

### Key Entities *(include if feature involves data)*

- **Cart**: the set of lines of one identity (guest or user); each line `{productId, quantity 1–20, addedAt}` with its own 30-day deadline. Owned by `orders`, kept in the cart store.
- **Order**: the buyer's purchase: buyer ID (plain ID), status, total, currency, reservation deadline, version, the idempotency key and request fingerprint it was created with, cancel reason, creation time. The aggregate root.
- **Order item**: one line of an order: product ID, shop ID, title snapshot, quantity, unit price, discount, line total.
- **Shop order**: the slice of an order belonging to one shop: shop ID, subtotal, status (`PENDING`, `PAID`, `CANCELLED`, `REFUNDED`).
- **Order event (history)**: append-only record of a transition: from, to, reason, actor, time.
- **Stock reservation**: one per order line: product, quantity, source (`CATALOG`; flash-sale sources are S11's), status `REQUESTED`/`HELD`/`CONVERTED`/`RELEASE_PENDING`/`RELEASED`, expiry.
- **Webhook inbox entry**: one provider event: provider, event ID, type, order reference, result, attempts, times. Owned through the shared inbox service (IX.3 allowlist).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In a race of 200 buyers for 50 units, exactly 50 are accepted, 0 units are oversold, and the stock never drops below zero — in 100% of 50 repeated runs.
- **SC-002**: Under any retry pattern of one checkout (sequential, simultaneous, after a timeout, after the order is paid), exactly 1 order and 1 stock deduction exist — 0 double orders in 100% of test runs; replays return the identical answer.
- **SC-003**: 99% of checkouts return their answer in under 800 ms with 200 buyers checking out at the same time; no checkout runs longer than 10 s.
- **SC-004**: 100% of cart operations complete without any relational database access, and 99% finish in under 50 ms.
- **SC-005**: 100% of forged, stale or altered webhooks are refused; 99% of genuine ones are acknowledged in under 1 s; a duplicate delivery changes nothing in 100% of cases.
- **SC-006**: 100% of unpaid holds are cancelled and their stock restored exactly once within 16 minutes of the reservation, including when a job is lost, repeated or fails midway.
- **SC-007**: Across 10,000 random carts, the shop subtotals add up to the order total to the minor unit in 100% of cases.
- **SC-008**: In a matrix of every read and cancel route against every other buyer, shop and anonymous caller, 100% of attempts to reach someone else's order return "not found" with identical bodies and change nothing.
- **SC-009**: A payment that arrives after the hold expired never leaves goods reserved or an order paid wrongly: 100% of such payments produce exactly one refund request.
- **SC-010**: The ownership check reports 0 cross-domain accesses for `orders` (today 12), and no other capability needs to read an order table.

## Assumptions

- Decisions marked `[BREAKING]`, `[CONTRACT]`, `[LOCAL]` are listed one per line in `questions.md`; this spec adopts each default stated there. Defaults most visible here: `202` for checkout; `409` for an in-flight duplicate; stock only through the catalog's stock command with a recoverable `PENDING` step; webhook acknowledged before processing; order and event amounts in `…Minor` fields.
- **Pattern coverage**: P0103 and P1110 → AS-23–AS-25; P0110 → AS-54, AS-57; P0303 → AS-59, AS-60; P0311 → AS-51, AS-56, AS-32; P0313 → AS-34, AS-35; P0407 → AS-13, AS-41, AS-65 (accepted now, paid later, status by read and push); P0414 → AS-15–AS-20; P0419 → AS-41–AS-47, AS-52, AS-53; P0611 → AS-33, AS-36–AS-39, AS-47, AS-51.
- Checkout requires an account; guest checkout is not offered (the guest cart is merged at login). Buyers of any platform role may check out.
- Prices are final prices in the product's currency; there is no tax, shipping or coupon engine. Seller discount functions (S45) are the only discount source; a shop's discount is one amount per shop.
- The platform runs in one currency per order; products of different currencies cannot be bought together.
- One order total is the sum of integer line totals and stays far below the largest exactly representable integer of the client (lines ≤ 50, quantity ≤ 20, product price limits are S05's).
- The 15-minute hold, 60 s sweeper, 60 s recovery age, 8 webhook attempts, 5 cleanup attempts, 35-day inbox retention, 250 ms discount timeout, 64 KiB webhook cap, 50-line and 20-unit cart limits are configuration defaults of this spec.
- A payment that completes while the hold expires (the last seconds) is refunded rather than the stock being taken back; the window is accepted (SC-009).
- Re-reading the payment at the provider is delegated to the payments capability (`getPaymentStatus`); this capability never calls the provider itself.
- Seller-side fulfilment progress per shop order (shipping each shop's part separately) is a fulfilment concern; here the order moves as a whole through the commands of `OrderFulfilmentService`.
- Orders are financial records: they are not deleted on shop deletion or user deletion; retention and anonymisation follow the finance rules owned by S14/S16. Carts and guest carts disappear by their 30-day expiry.
- The cart cookie identifies a cart, not a person: it never grants access to orders, and cookie-authenticated CSRF rules (VI.2) do not apply to it because it carries no authority beyond one anonymous cart.
- Approximate stock for product pages ("only 3 left") is the catalog's `inStock` and `quantity` shown through the BFF; this capability checks exact stock only at checkout.

## Cross-capability contracts

Earlier specs searched (`grep -rl` over `specs/domains`, `specs/web`, `specs/journeys` for `S10` and `orders`; `specs/web` and `specs/journeys` do not exist yet). Contracts they require from this capability and how they are honoured:

- **S05**: callers use only `getProductsByIds` and `applyStockDelta` with `operationId` `<service>:<aggregate-id>:<step>` and compensation as a new opposite operation (honoured: `orders:<orderId>:reserve:<productId>` / `…:release:<productId>`); order items keep a title and price snapshot and drop the product association (honoured, FR-020, FR-057).
- **S03**: `orders.read` exists for all roles and `ShopScoped` carries the status gate (honoured, FR-050); products of non-active shops are not purchasable (FR-015, one addition asked of S03, see `questions.md`).
- **S01**: `orders` stops reading the `User` model (association dropped, user ID is a plain ID), and its e2e specs switch to the identity fixture (honoured, FR-057; see `gaps.md`).
- **S08**: stock changes through `applyStockDelta` reach the provider without this capability calling `catalog-sync` (honoured).
- **S07**: order export routes and queue are not in this capability (honoured; S12).

**Provides** (exact names; exported from `@app/domains/orders` unless it is an HTTP endpoint):

- HTTP under `/api`, problem+json errors with `code`, schemas in `packages/contracts` (`cartSchema`, `setCartLineRequestSchema`, `checkoutRequestSchema`, `checkoutResponseSchema`, `orderSchema`, `orderListItemSchema`, `orderPageSchema` = `{items, nextCursor}`, `shopOrderPageSchema`, `orderEventSchemas`, `webhookAckSchema`):
  - `GET /cart` → `cartSchema` `{lines: [{productId, quantity, addedAt}], droppedLines}` (anonymous allowed); `PUT /cart/items/:productId {quantity: 0..20}` → `200 cartSchema` (anonymous allowed); `POST /cart/merge` (session) → `200 cartSchema` with `droppedLines`.
  - `POST /checkout` (session; `Idempotency-Key` required; body `{expectedTotalMinor?}`) → `202 checkoutResponseSchema` `{orderId, status: "RESERVED", totalMinor, currency, reservedUntil}` with `Location`; problem codes `cart_empty`, `product_unavailable {productIds}`, `out_of_stock {productIds}`, `mixed_currency`, `price_changed {currentTotalMinor, lines}`, `idempotency_in_flight`, `idempotency_key_reuse`, `idempotency_key_required`, `idempotency_key_invalid`, `checkout_in_progress`, `checkout_unavailable`, `rate_limited`.
  - `GET /orders?limit&cursor` → `orderPageSchema` of `{id, status, totalMinor, currency, createdAt}`; `GET /orders/:orderId` → `orderSchema` `{id, status, totalMinor, currency, reservedUntil, createdAt, items: [{productId, shopId, title, quantity, unitPriceMinor, discountMinor, lineTotalMinor}], shopOrders: [{id, shopId, subtotalMinor, status}], timeline: [{status, reason, at}]}`; `POST /orders/:orderId/cancel` → `200 orderSchema` (`order_not_cancellable` 409, `order_not_found` 404).
  - `GET /shops/:shopId/orders?status&limit&cursor` (`orders.read`) → `shopOrderPageSchema` `{items: [{shopOrderId, orderId, status, subtotalMinor, currency, buyerId, createdAt, items}], nextCursor}`.
  - `POST /webhooks/stripe` (no session, `Stripe-Signature`) → `200 {received: true, duplicate?: true}`; `400 invalid_signature | invalid_payload`; `413`.
  - Realtime: topic `user:<userId>`, event `order.status` `{orderId, status, orderVersion}` (hub: S51).
  - Not provided here (S11): `POST /shops/:shopId/flash-sales`.
- `OrderQueryService` (R1): `getOrdersForShop(shopId: ShopId, query: { status?: ShopOrderStatus; limit?: number (≤ 100); cursor?: string }): Promise<{ items: ShopOrderDto[]; nextCursor: string | null }>`; `getOrderLines(orderIds: OrderId[]): Promise<Map<OrderId, OrderLineDto[]>>` (≤ 500; one query); `getPayableOrder(orderId: OrderId, userId: UserId): Promise<PayableOrderDto>` where `PayableOrderDto = { orderId, userId, totalMinor, currency, reservedUntil, shopAllocations: { shopId, subtotalMinor }[] }`; throws `OrderNotFoundError`, `OrderNotPayableError { orderId, status, code }`, `TooManyIdsError`. **Consumers: S13 (`getPayableOrder` when creating an intent, with intent idempotency key = `orderId`), S42 (public orders), S21 and S31 and S16 (lines and shop orders, replacing their joins), S43 (webhook payloads).**
- `OrderFulfilmentService` (R1): `apply(orderId: OrderId, command: { type: 'startFulfilment' } | { type: 'ship'; trackingCode: string } | { type: 'deliver' }): Promise<{ status: OrderStatus; orderVersion: number }>`; throws `InvalidOrderTransitionError`, `OrderNotFoundError`. **Consumers: S19, S20.**
- Events (outbox → topic `orders.events`, key `orderId`; envelope `{eventId, type, version: 1, occurredAt, aggregateId}`; every payload includes `orderVersion`; money in `…Minor`):
  - `order.reserved` `{orderId, userId, totalMinor, currency, shopIds: ShopId[], reservedUntil, orderVersion}`.
  - `order.paid` `{orderId, userId, totalMinor, currency, paymentRef, paidAt, lines: [{productId, shopId, title, quantity, unitPriceMinor, discountMinor, lineTotalMinor}], shopOrders: [{shopOrderId, shopId, subtotalMinor}], orderVersion}`.
  - `order.cancelled` `{orderId, userId, reason: 'out_of_stock' | 'payment_failed' | 'hold_expired' | 'user_cancelled', previousStatus, orderVersion}`.
  - `order.refunded` `{orderId, userId, amountMinor, currency, reason, orderVersion}`.
  - `order.fulfilment_changed` `{orderId, status: 'FULFILLING' | 'SHIPPED' | 'DELIVERED', trackingCode?, orderVersion}`.
  - **Consumers: S19 (`order.paid` → dispatch), S31 (`order.paid` → entitlement), S28 (all → mails and popover), S40 (`order.paid` → sales and leaderboards), S43 (webhook router: `order.*`), S34 (`order.paid` lines → co-occurrence), S36 (conversion), S14/S16 (R3 via CDC/ClickHouse for statements), J01.**
- Single-consumer message (SQS): `orders.refund_requested` v1 `{orderId, paymentRef, amountMinor, currency, reason: 'order_cancelled'}`. **Consumer: S13.**
- Domain port for S11 (inside this domain): `ReservationSource` with `reserve(order, lines)`, `release(reservation)`, `convert(reservation)`; the `CATALOG` source is this capability's.
- Rate-limit policies (declared in S50's registry): `orders.cart-write.identity` 120/minute per user or per client address (fail open); `checkout.create` 10/minute per user, token bucket (fail closed, existing name); `orders.cancel.user` 20/minute per user (fail closed); `orders.webhook.ip` 300/minute per address (fail open).
- Scheduled and queued jobs (registered with S49): `orders.expire-reservation` (per order, `runAt = reservedUntil`), `orders.sweep-expired-reservations` (every 60 s, concurrency 1), `orders.recover-pending` (every 30 s), `orders.release-stock` (every 30 s, per-row backoff), `orders.clear-cart` (per order, ≤ 5 attempts), `orders.process-webhook` (per event, ≤ 8 attempts), `orders.purge-webhook-inbox` (daily).
- Modules for the apps: `OrdersModule` (core: HTTP, R1 services), `OrdersWorkerModule` (worker: jobs, `payments.events` consumer). Nothing else is exported: no model, repository, job class, port implementation or flash-sale class (those move behind S11).

**Requires**:

- **S05** (`catalog`): `ProductQueryService.getProductsByIds(ids ≤ 500, options?)` using `{id, shopId, title, category, priceMinor, currency, status: 'ACTIVE' | 'ARCHIVED', isSandbox}`; `ProductStockService.applyStockDelta(ops)` with `StockOperation = { operationId: 'orders:<orderId>:reserve:<productId>' | 'orders:<orderId>:release:<productId>', productId, shopId, delta, reason: 'order.reserve' | 'order.release' }`, all-or-nothing, never below zero, idempotent per `operationId` for 30 days (this spec needs ≥ 2 days), outcomes `applied | rejected {failures: [{operationId, productId, code}]}`, `replayed` flag.
- **S03** (`tenancy`): `ShopScoped('orders.read')` with the status gate; `ShopQueryService.getShopsByIds(ids ≤ 500)` with `status`, `isSandbox` (asked: used to refuse products of non-`ACTIVE` shops).
- **S01** (`identity`): `Firewall({ anonymous?, … })`, `@User()` and `AuthenticatedUser = { id, role, sessionId, amr }`; the access token contract.
- **S13** (`payments`): `PaymentQueryService.getPaymentStatus(paymentRef: string): Promise<{ paymentId, paymentRef, orderId, status: 'PENDING' | 'COMPLETED' | 'FAILED' | 'REFUNDED', amountMinor, currency } | null>`; the intent's provider metadata carries `orderId`; events `payments.payment_succeeded`, `payments.payment_failed`, `payments.payment_refunded` v1 `{paymentId, paymentRef, orderId, userId, amountMinor, currency, occurredAt}` on topic `payments.events` (key `paymentId`); a consumer for `orders.refund_requested`; S13 creates an intent only for an order that `getPayableOrder` returns, with idempotency key = `orderId`.
- **S45** (`shop-functions`): `evaluateDiscounts(cart: { currency, lines: { productId, shopId, category, quantity, unitPriceMinor }[] }): Promise<{ shopDiscounts: { shopId, discountMinor }[] }>` (R1); absent or failing → no discounts.
- **S11** (`orders`, same domain): implements flash-sale sources of `ReservationSource` and owns the flash-sale routes, jobs and stock keys.
- **S53** (events): `outbox.append(event)` inside the domain's transaction (IX.6); the inbox service (`claim(provider, eventId)`, processing status, purge) as the only access to the webhook inbox rows; the consumer framework (envelope check, schema validation, DLQ, idempotency) for `payments.events`; single-consumer messages for `orders.refund_requested`.
- **S49** (jobs): the delayed per-order jobs, the periodic jobs above with single-run leases, retry with backoff and a dead-letter state.
- **S50** (rate limiter): the four policies above with `Retry-After`.
- **S51** (realtime): `RealtimePublisher.publish(topic, event, payload)` and the `user:<id>` topic registration.
- **S54** (platform toolkit): problem+json filter with `code` and `requestId`; the `Idempotency-Key` facility (stored replay, in-flight `409`, different body `422`, 24 h TTL, per-principal scope, release on failure before an order exists); raw-body capture limited to the webhook route (64 KiB); injected clock; config validation (cart cookie secret, webhook secrets, hold, limits, timeouts); metrics registry; graceful shutdown.
- **S48** (BFF) and **W03** (web): compose cart lines with product data through the batch product endpoint (R2); show the problem codes above; poll `GET /orders/:id` or listen to `order.status`.
