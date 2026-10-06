# Commerce and Transaction Designs

Designs 19–24 of the practice catalog (`03-practice-catalog.md`). Common themes: **correctness under concurrency**, money, state machines, idempotency, and contention.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`ORDER_STATUSES`](../../packages/backend/libs/domains/orders/domain/order-state.ts#L11): ORDER_STATUSES enumerates the order state machine states (PENDING, RESERVED, PAID, FULFILLING, SHIPPED, DELIVERED, CANCELLED, REFUNDED). _(order-state.ts)_
> - [`canTransition`](../../packages/backend/libs/domains/orders/domain/order-state.ts#L49): canTransition checks whether a command is allowed from the current order status and returns 409 if not. _(order-state.ts)_
> - [Idempotent creation of the payment row](../../docs/humans/concepts/domain-payments/idempotent-payment-insert.md): Payment row is created with an ON CONFLICT DO NOTHING insert on idempotencyKey so retries share one row. [`PaymentService.executePayment`](../../packages/backend/libs/domains/payments/application/payment.service.ts#L65)
<!-- theory-links:end -->

---

## 19. E-commerce checkout and inventory

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`CheckoutService`](../../packages/backend/libs/domains/orders/application/checkout.service.ts#L61): CheckoutService orchestrates stock reservation, order creation and event emission atomically. _(checkout.service.ts)_
> - [`OrdersController`](../../packages/backend/libs/domains/orders/api/orders.controller.ts#L26): OrdersController exposes the checkout, order history and cancellation endpoints. _(orders.controller.ts)_
<!-- theory-links:end -->

### Clarify
- Catalog size, orders per day, flash sales? Multiple warehouses? Guest checkout? Payment provider?
- The key invariant: **never sell stock you don't have** (or decide explicitly to allow backorders).
- Assumptions: 1M products, 100k orders/day, flash sales with 50× normal traffic on a few items.

### Design
```
Browse: CDN + catalog service (read replicas, search index, cache)
Cart:   cart service (Redis or DB; guest carts keyed by cookie, merged on login)
Checkout ─► Order service (Postgres) ─► state machine:
   PENDING ─reserve stock─► RESERVED ─payment ok─► PAID ─► FULFILLING ─► SHIPPED ─► DELIVERED
      │                        │ payment failed / hold expired
      └────────────────────────┴─► CANCELLED (release stock)
Payment: provider (Stripe) with idempotency key; result via webhook
Events (outbox) ─► email, warehouse, analytics
```
### Deep dives
- **Preventing overselling**:
  - Atomic conditional update: `UPDATE inventory SET available = available - $q WHERE sku = $s AND available >= $q` → 0 rows = out of stock. Simple and correct under concurrency.
  - **Reservations with expiry**: at checkout start, reserve (`reservations(order_id, sku, qty, expires_at)`), decrement `available`; a sweeper releases expired holds (or a delayed message). Payment success converts the reservation into a sale.
  - Flash sales: a single hot inventory row becomes a lock bottleneck → pre-split stock into N buckets (rows) and pick one randomly, or move the counter to Redis (`DECRBY` + Lua check), with the DB updated asynchronously and reconciled.
- **Payment flow**: create order (PENDING) → create a payment intent with an **idempotency key = order ID** → the client confirms with the provider (3-D Secure) → the **webhook** (signed, idempotent) marks the order PAID. Never trust the client's "payment succeeded" redirect alone.
- **Order state machine**: explicit allowed transitions, enforced with conditional updates (`UPDATE orders SET status='PAID' WHERE id=$1 AND status='RESERVED'`), each transition recorded in an `order_events` history table.
- **Cart**: anonymous carts (cookie ID) merged into the user cart on login; prices recalculated at checkout (never trust prices from the client).
- **Consistency across services**: inventory, payment, and shipping as a **saga** with compensations (release stock, refund) and the outbox for events.
- **Read scaling**: product pages cached at the CDN; stock levels shown approximately ("only 3 left") from a cache; exact check only at checkout.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [Guarded stock update after a successful charge](../../docs/humans/concepts/domain-payments/guarded-stock-update.md): After the charge, one guarded UPDATE on stock only succeeds if enough quantity remains, which prevents overselling. [`PaymentService.executePayment`](../../packages/backend/libs/domains/payments/application/payment.service.ts#L65)
> - [`RESERVATION_HOLD_MS`](../../packages/backend/libs/domains/orders/application/checkout.service.ts#L24): RESERVATION_HOLD_MS sets a 15-minute stock reservation hold that an expiry job releases. _(checkout.service.ts)_
> - [`Domain_OutOfStockError`](../../packages/backend/libs/domains/orders/application/checkout.service.ts#L26): Domain_OutOfStockError is thrown when the requested quantity cannot be reserved during checkout. _(checkout.service.ts)_
<!-- theory-links:end -->

### Trade-offs and pitfalls
- Reserving at add-to-cart blocks stock for window shoppers; reserving at checkout (with a 10–15 min hold) is the common middle ground.
- Pitfalls: read-then-write stock checks (lost updates → overselling), trusting client prices, double charges on retries, marking orders paid from the redirect.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [Refund when stock runs out after charging](../../docs/humans/concepts/domain-payments/refund-saga.md): If stock runs out after Stripe has charged the card, the service refunds the charge and marks the payment REFUNDED. [`PaymentService.executePayment`](../../packages/backend/libs/domains/payments/application/payment.service.ts#L65)
> - [Optimistic stock deduction](../../docs/humans/concepts/domain-payments/optimistic-stock-deduction.md): Optimistic stock deduction guards the UPDATE so the shop never oversells. [`PaymentService.executePayment`](../../packages/backend/libs/domains/payments/application/payment.service.ts#L65)
<!-- theory-links:end -->

### Theory
`03-Databases/02` (lost updates, atomic updates, `SKIP LOCKED`), `04-API-Design/03` (idempotency, webhooks), `06-Distributed-Systems/02` (sagas), `06-Distributed-Systems/01` (outbox).

---

## 20. Payment system / ledger

Full walkthrough: `02-worked-examples.md` Example 1 (double-entry ledger, external transfers, reconciliation). Points to rehearse:
- **Double-entry**: immutable `entries` where every transaction sums to zero; balances derived or updated atomically in the same DB transaction; corrections as reversal entries.
- **Exactly-once effect**: idempotency keys on the API, our transaction ID passed as the reference to the bank/PSP, unique constraints on external references, guarded state transitions.
- **Unknown outcomes** (timeout talking to the bank): mark `UNKNOWN`, query the provider's status by reference with backoff; never blindly resend.
- **Reconciliation** daily against provider/bank statements; mismatches go to a finance queue.
- **Money**: integer minor units or decimals, currency per account, explicit rounding rules.
- Security and compliance: PCI scope reduction (card data handled only by the provider's hosted fields/iframes), audit trail, least privilege.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [Posting one balanced journal](../../docs/humans/concepts/domain-payments/post-journal.md): Posting a journal validates that its lines sum to zero and inserts immutable LedgerEntry rows in one transaction. [`ledger.service.ts`](../../packages/backend/libs/domains/payments/application/ledger.service.ts)
> - [Idempotent creation of the payment row](../../docs/humans/concepts/domain-payments/idempotent-payment-insert.md): The payment is created with an idempotency-key insert that silently skips duplicates. [`PaymentService.executePayment`](../../packages/backend/libs/domains/payments/application/payment.service.ts#L65)
> - [Daily Stripe reconciliation](../../docs/humans/concepts/domain-payments/daily-reconciliation.md): A nightly job reconciles Stripe charges against Payment records by idempotency key. [`ReconciliationJobs`](../../packages/backend/libs/domains/payments/infra/reconciliation.jobs.ts#L24)
<!-- theory-links:end -->

---

## 21. Ticket booking (Ticketmaster)

### Clarify
- Seated (specific seats) or general admission? How long can a user hold seats while paying?
- Scale: a popular event = 50k seats, **millions of users arrive in the first minute**.

### Design
```
Users ─► CDN (static event pages) ─► Virtual waiting room (queue) ─► admitted users get a signed token
Admitted ─► Booking service ─► seat holds (Redis with TTL, or DB rows with expires_at) ─► Payment ─► Booking confirmed (DB)
Seat map reads ─► cached seat availability (updated via pub/sub)
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`SeatHoldService`](../../packages/backend/libs/domains/launch-events/application/seat-hold.service.ts#L44): SeatHoldService manages the hold, confirm and release lifecycle for seats. _(seat-hold.service.ts)_
> - [`seatMapKey`](../../packages/backend/libs/domains/launch-events/application/seat-hold.service.ts#L31): seatMapKey is the Redis key for the seat bitmap shown on the seat map display. _(seat-hold.service.ts)_
<!-- theory-links:end -->
### Deep dives
- **Contention on seats**: two users click the same seat.
  - DB: `UPDATE seats SET status='HELD', held_by=$u, hold_expires=now()+'10 min' WHERE id=$seat AND (status='AVAILABLE' OR hold_expires < now())`. Exactly one wins (row lock + condition). Or `SELECT … FOR UPDATE SKIP LOCKED` when assigning "best available" seats.
  - Redis: `SET seat:{id} userId NX EX 600` as a fast hold, with the DB as the final source of truth at purchase time.
- **Hold expiry**: TTL on the hold; a sweeper or the conditional update above treats expired holds as available. Payment must complete within the hold window; payment success converts the hold into a booking (idempotent).
- **The thundering herd**: a **virtual waiting room** admits users at the rate the booking system can handle (token bucket on admission), gives queue positions, and issues signed admission tokens (checked by the booking API). Static pages served from the CDN; bot protection (CAPTCHA, device fingerprinting).
- **Seat map freshness**: availability cached and pushed (SSE) with small delays; the authoritative check happens only on hold.
- **Fairness and abuse**: per-user limits on tickets, verified accounts, randomized queue entry for those who arrived before sale start.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`SeatHoldService`](../../packages/backend/libs/domains/launch-events/application/seat-hold.service.ts#L44): SeatHoldService applies seat holds with multi-layer consistency. _(seat-hold.service.ts)_
> - [`HOLD_MS`](../../packages/backend/libs/domains/launch-events/application/seat-hold.service.ts#L20): HOLD_MS sets the 10-minute hold expiry for seats. _(seat-hold.service.ts)_
> - [`WaitingRoomService`](../../packages/backend/libs/domains/launch-events/application/waiting-room.service.ts#L39): WaitingRoomService provides a fair admission queue for high-traffic sale starts. _(waiting-room.service.ts)_
<!-- theory-links:end -->

### Trade-offs and pitfalls
- Strong consistency for the hold/booking, eventual consistency for the seat map display.
- Pitfalls: "check then book" without a conditional update; holds without expiry; letting all traffic hit the DB at sale start.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`WaitingRoomService`](../../packages/backend/libs/domains/launch-events/application/waiting-room.service.ts#L39): WaitingRoomService keeps sale-start traffic from hitting the DB all at once. _(waiting-room.service.ts)_
> - [`HOLD_MS`](../../packages/backend/libs/domains/launch-events/application/seat-hold.service.ts#L20): Seat holds expire after 10 minutes, so they do not last forever. _(seat-hold.service.ts)_
<!-- theory-links:end -->

### Theory
`03-Databases/02` (row locks, `SKIP LOCKED`, conditional updates), `03-Databases/04` (`SET NX EX`), `06-Distributed-Systems/03` (load shedding, admission control).

---

## 22. Online auction (eBay)

### Clarify
- English auction (highest bid wins at end time)? Proxy/max bids? Anti-sniping (extend the end time on late bids)? Number of concurrent auctions and bids/s on hot ones?

### Design
- `auctions(id, status, current_price, highest_bidder, ends_at, version)`, `bids(id, auction_id, user_id, amount, created_at)` (append-only).
- Placing a bid: in one transaction, insert the bid and update the auction **only if** the bid beats the current price and the auction is open:
  `UPDATE auctions SET current_price=$amt, highest_bidder=$u, version=version+1 WHERE id=$a AND status='OPEN' AND ends_at > now() AND current_price < $amt`.
  0 rows → outbid or closed.
- Real-time: price updates pushed to watchers over SSE/WebSocket (pub/sub per auction).
- **Ending auctions**: a scheduler (design 29) closes auctions at `ends_at` exactly once (idempotent close, `WHERE status='OPEN'`), determines the winner, and emits events (notify, invoice).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`PLACE_BID`](../../packages/backend/libs/domains/auctions/infra/place-bid.lua.ts#L15): The PLACE_BID Lua script atomically places a bid, applies proxy bidding and extends the auction end time for anti-sniping. _(place-bid.lua.ts)_
> - [`Auction`](../../packages/backend/libs/domains/auctions/infra/models/auction.model.ts#L7): The Auction model stores the current price and status. _(auction.model.ts)_
> - [`BidRelay`](../../packages/backend/libs/domains/auctions/infra/bid-relay.service.ts#L22): BidRelay batches Redis bids into PostgreSQL and emits leader-change events. _(bid-relay.service.ts)_
<!-- theory-links:end -->

### Deep dives
- **Hot auctions**: serialize bids per auction (a queue partitioned by auction ID, or row-level locking, which is fine at hundreds of bids/s); reads served from cache.
- **Proxy bidding**: store each bidder's max; the system bids the minimum increment on their behalf, resolved inside the same transaction.
- **Clock and fairness**: the server's time decides; anti-sniping extends `ends_at` by N minutes when a bid arrives in the final minutes.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`PLACE_BID`](../../packages/backend/libs/domains/auctions/infra/place-bid.lua.ts#L15): Bids on a hot auction are serialized in one atomic Redis Lua script that also handles proxy bidding. _(place-bid.lua.ts)_
> - [`ANTI_SNIPE_MS`](../../packages/backend/libs/domains/auctions/application/auction.service.ts#L17): ANTI_SNIPE_MS defines the 120-second window in which a late bid extends the auction. _(auction.service.ts)_
> - [`MAX_EXTENSION_MS`](../../packages/backend/libs/domains/auctions/application/auction.service.ts#L19): MAX_EXTENSION_MS caps the total extension at one hour. _(auction.service.ts)_
<!-- theory-links:end -->

### Theory
`03-Databases/02` (conditional updates, optimistic concurrency), design 29 (scheduling), design 14 shared block (real-time push).

---

## 23. Ride-hailing / food delivery (Uber)

### Clarify
- Riders request rides, nearby drivers get offers, live tracking, ETA, pricing (surge), payments.
- Scale: 1M active drivers sending location every 4 s → **250k location updates/s**.

### Design
```
Driver app ─(location every 4 s)─► Location ingestion (WebSocket/UDP-ish HTTP) ─► in-memory geo index (Redis GEO / geohash cells / H3)
Rider requests ride ─► Matching service: find nearby available drivers (geo query) ─► offer to best driver (timeout → next)
Trip service (Postgres): trip state machine REQUESTED → MATCHED → PICKED_UP → COMPLETED / CANCELLED
Live tracking ─► rider subscribes to driver's location stream (WebSocket)
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`CourierService`](../../packages/backend/libs/domains/fulfilment/application/courier.service.ts#L26): CourierService handles courier registration, availability and location reporting. _(courier.service.ts)_
> - [`geoKey`](../../packages/backend/libs/domains/fulfilment/infra/courier-keys.ts#L7): geoKey is a Redis GEO set of available couriers indexed by city. _(courier-keys.ts)_
<!-- theory-links:end -->
### Deep dives
- **Location data**: very high write rate, only the latest position matters for matching → keep it in memory (Redis GEO, or an in-process index sharded by geographic cell, e.g. H3/geohash). Persist sampled history asynchronously (Kafka → storage) for analytics and disputes.
- **Matching**: query drivers in the rider's cell and neighbors, rank by ETA (road network, not straight-line distance), offer to one driver at a time with a short timeout. **Prevent double assignment**: a driver's state changes from `AVAILABLE` to `OFFERED` atomically (conditional update or Redis `SET NX`), so one driver never gets two trips.
- **Sharding by geography**: cities are mostly independent, so partition matching and location services by region/city (cell-based architecture), which also limits the blast radius.
- **Surge pricing**: supply/demand per cell, computed periodically from streams.
- **Food delivery variant**: three parties (customer, restaurant, courier), order state machine with restaurant prep time, batching multiple orders per courier.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`geoKey`](../../packages/backend/libs/domains/fulfilment/infra/courier-keys.ts#L7): Courier positions are kept in a Redis GEO set per city. _(courier-keys.ts)_
> - [`CourierTrackProjector`](../../packages/backend/libs/domains/fulfilment/infra/delivery-workers.ts#L45): CourierTrackProjector writes courier location events to DynamoDB with deduplication. _(delivery-workers.ts)_
> - [`offerLockKey`](../../packages/backend/libs/domains/fulfilment/infra/courier-keys.ts#L9): offerLockKey is an atomic per-courier offer lock used in matching. _(courier-keys.ts)_
<!-- theory-links:end -->

### Theory
`03-Databases/04` (Redis GEO), `05-social-and-content.md` design 13 (geo indexing), `06-Distributed-Systems/01` (Kafka for location streams), `03-Databases/02` (atomic state changes).

---

## 24. Subscription billing (SaaS plans)

### Clarify
- Plans (monthly/yearly), seats or usage-based pricing, trials, upgrades/downgrades mid-cycle, taxes, invoices, multiple currencies?
- Build vs buy: Stripe Billing / Chargebee handle most of this. The interviewer usually wants to see the model and edge cases.

### Design
- Entities: `plans`, `prices` (versioned; never edit a price in place), `subscriptions(customer, price, status, current_period_start/end, cancel_at_period_end)`, `invoices` + `invoice_lines`, `payments`, `usage_records` (for metered billing).
- Subscription state machine: `TRIALING → ACTIVE → PAST_DUE → (ACTIVE | CANCELED | UNPAID)`.
- Billing run: a scheduler finds subscriptions whose period ends → generates an invoice (idempotent per subscription + period) → charges the saved payment method (idempotency key) → on failure enters **dunning** (retries on day 1/3/7 with emails) → eventually cancels or downgrades.
- Entitlements: the app checks `features/limits` derived from the active subscription (cached; updated via billing webhooks), not the plan name directly.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`Subscription`](../../packages/backend/libs/domains/billing/infra/models/subscription.model.ts#L8): The Subscription model holds the billing cycle and subscription status. _(subscription.model.ts)_
> - [`Price`](../../packages/backend/libs/domains/billing/infra/models/price.model.ts#L7): The Price model is separate from Plan and covers intervals, amounts and currencies. _(price.model.ts)_
> - [`SubscriptionStatus`](../../packages/backend/libs/domains/billing/infra/models/subscription.model.ts#L5): SubscriptionStatus is a union of the states TRIALING, ACTIVE, PAST_DUE, UNPAID and CANCELED. _(subscription.model.ts)_
<!-- theory-links:end -->

### Deep dives
- **Proration**: upgrade mid-cycle → credit for unused time on the old price + charge for the remaining time on the new price (computed on the same day boundary; rounding rules).
- **Usage-based**: ingest usage events idempotently (event IDs), aggregate per period, lock the period at invoice time, and handle late events as adjustments in the next invoice.
- **Time zones and periods**: anchor dates (billing on the 31st → shorter months), all in UTC with the customer's billing anchor stored.
- **Webhooks from the billing provider** drive entitlement changes (`invoice.paid`, `customer.subscription.updated`): signed, idempotent, out-of-order safe (compare event timestamps or re-fetch the subscription).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`prorate`](../../packages/backend/libs/domains/billing/domain/proration.ts#L25): prorate credits unused time on the old price and charges the remaining time on the new price. _(proration.ts)_
> - [`BillingJobs`](../../packages/backend/libs/domains/billing/infra/billing.jobs.ts#L29): BillingJobs handles renewals and dunning retries. _(billing.jobs.ts)_
> - [`DUNNING_DAYS`](../../packages/backend/libs/domains/billing/infra/billing.jobs.ts#L26): DUNNING_DAYS sets the retry schedule after a failed invoice charge. _(billing.jobs.ts)_
<!-- theory-links:end -->

### Theory
`06-Distributed-Systems/02` §5 (multi-period reconciliation, adjustments in open periods), `04-API-Design/03` (idempotency, webhooks), design 29 (scheduler), `01-JavaScript-TypeScript/01` §9 (money and allocation).
