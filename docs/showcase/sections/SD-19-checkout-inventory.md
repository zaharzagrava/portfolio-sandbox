# SD-19 — Cart, Checkout & Inventory (incl. flash sales)

Status: ☑ done (typechecked; spec + k6 written, not run) · Phase 2 · Depends on: F-05, SD-29, SD-34, SD-02 · Extends README #3, #6, #8

## Marketplace adaptation
Buyers keep a cart (guest → merged on login), check out multi-seller orders, and during **flash sales** ("AirPods drop, 5,000 units at 10:00") hundreds of thousands of buyers hit the same few SKUs. Never oversell, never double charge.

## Existing code
`BisOrder`, `BisOrderItem`, `Product.quantity` + `version` (OCC, README #6), payment saga in `payment.service.ts` (README #8), idempotency (README #3), edge ingestion → Kafka `payments.requests`.

## Patterns showcased
| Pattern | Lesson |
|---|---|
| **Cart in DynamoDB** (PK `CART#<cartId>`, SK `ITEM#<productId>`; guest cart via signed cookie ID; merge on login; TTL 30 days) — no Postgres on browse/add-to-cart path | 10/07 #19, D24 |
| Prices recalculated server-side at checkout (never trust client) | 10/07 #19 |
| **Reservations with expiry**: checkout reserves stock (15-min hold), sweeper/expiry job (SD-29) releases; payment success converts to sale | 10/07 #19 |
| **Flash-sale stock in Redis**: Lua `DECRBY`-if-enough across **N stock buckets** (hot-key splitting) → reservation token; Postgres updated asynchronously via Kafka + periodic reconciliation | 10/07 #19, 03/04 hot keys |
| Normal stock: atomic conditional update `UPDATE ... SET quantity = quantity - :q WHERE id = :id AND quantity >= :q` (vs existing OCC version — both kept, trade-off documented) | 03/02 §4 |
| **Order state machine** as discriminated union + guarded transitions + `OrderEvent` history | 10/07 #19, 01/02 §2 |
| Multi-seller order split: one `Order` → N `ShopOrder`s (each seller fulfils independently), money allocation per shop (largest remainder for discounts) | 01/01 §9 |
| Payment intent with **idempotency key = orderId**; webhook marks PAID (signed, idempotent, out-of-order safe) — never trust redirect | 04/03 §5 |
| Saga with compensations (release stock, refund) — reuse existing orchestrator | 06/02 §2 |
| Approximate stock on product pages ("only 3 left") from read model; exact check only at checkout | 10/07 #19 |
| Deadlock avoidance: lock rows in sorted productId order for multi-item orders | 03/02 §7 |

## Data / storage
- DynamoDB `Carts`.
- Redis: `stock:{productId}:b{0..N-1}` buckets for flash-sale SKUs, `reservation:{token}` with TTL.
- Postgres: `Order`, `ShopOrder`, `OrderItem`, `OrderEvent`, `StockReservation(expiresAt)`; `FlashSale(productId, startsAt, units, buckets)`.
- Kafka: `orders.events` (key orderId), `inventory.events` (key productId).

## API
`PUT /cart/items/:productId`, `GET /cart`, `POST /cart/merge`, `POST /checkout` (Idempotency-Key) → 202 + orderId, `GET /orders/:id`, `POST /webhooks/stripe`.

## Steps
- [x] Dynamo cart repository + endpoints + merge-on-login (listener on auth login event).
- [x] Order/ShopOrder models, migrations, state machine module (`order-state.ts`, exhaustive transitions table).
- [x] Reservation service: Postgres path + Redis flash-sale path (Lua bucketed decrement, pick random bucket, fall through to next bucket on empty).
- [x] Flash-sale stock loader (job at `startsAt − 1 min` splits units into buckets) + reconciliation job (Redis sold count vs Postgres).
- [x] Checkout orchestration → existing payment flow (edge/Kafka) with orderId as idempotency key.
- [x] Stripe webhook controller (signature verify, inbox dedupe by event id, transition guarded).
- [x] Expiry handler (SD-29 job `reservation.expire`).
- [x] e2e: 200 parallel checkouts on 50 units → exactly 50 orders RESERVED, Redis buckets sum 0, no negative stock; webhook replay twice → one PAID transition.
- [x] k6 `loadtest:flash-sale`.

## Scale
- Target: flash sale 1M buyers / 5 min behind admission (SD-21 waiting room reused), 10k checkout attempts/s, cart ops 20k RPS.
- Hot path: cart → DynamoDB only. Flash checkout → Redis Lua (stock) → write `Order` row + outbox in one small tx (no stock row lock) → 202. Postgres stock decremented asynchronously in batches.
- First bottleneck & fix: single hot stock row/key → N buckets (N = 16–64) spread across Redis Cluster slots via distinct hash tags; order inserts → partitioned `Order` table by month, idempotency unique on orderId.
- Partitioning: Dynamo by cartId; Kafka orders by orderId; inventory by productId.
- Capacity model: Redis Lua ~50k ops/s per shard × 16 buckets on 4 shards ≫ 10k/s; Postgres sees ~10k inserts/s at peak (needs batching writer or db.r6g.2xlarge-class) → orders accepted to Kafka first if DB lags (async command path, README #5).
- Proof: k6 flash-sale at 1/2/4 API instances, thresholds p99 < 150 ms, oversell count == 0 (checked after run).

## FE visualisation (phase 2)
Cart drawer, checkout, order timeline, flash-sale countdown with live stock.

## Implementation notes (2026-10-01)
- **Order aggregate = existing `BisOrder`** (Payment already references it) extended by migration `20261001150000-checkout-orders-inventory`: status/total/currency/idempotencyKey/reservedUntil/version/cancelReason; `BisOrderItem.shopId/flashSaleId`; new `ShopOrder` (per-shop split), `OrderEvent` (history), `StockReservation` (HELD/CONVERTED/RELEASED, partial index on held expiry), `FlashSale`, `ProcessedWebhookEvent` (inbox). Unique partial index (userId, idempotencyKey); covering index for order history.
- `libs/common/src/orders/`: `order-state.ts` (discriminated-union commands + transition table + `assertNever`), `OrderService` (guarded `UPDATE ... FROM (SELECT ... FOR UPDATE)` transitions + OrderEvent + domain events, `markPaid`, `cancel` with compensation in product-id lock order, realtime `user:<id>` push), `CheckoutService` (server-side prices, conditional decrements, flash buckets + per-user quota, compensation on failure, idempotent per key incl. race, transactional enqueue of `orders.expire-reservation`), `CartRepository` (DynamoDB `Carts`), `CartIdentity` (HMAC-signed guest cart cookie), `FlashStockService` (N buckets with distinct hash tags, random-start fall-through Lua decrement, per-user limit Lua, approximate remaining).
- Endpoints: `GET/PUT /api/cart`, `POST /api/cart/merge`, `POST /api/checkout` (Idempotency-Key required, rate-limited), `GET /api/orders`, `GET /api/orders/:id` (timeline), `POST /api/orders/:id/cancel`, `POST /api/shops/:shopId/flash-sales` (schedules start/end jobs), `POST /api/webhooks/stripe` (raw-body signature, inbox dedupe, out-of-order safe). `core` now boots with `rawBody: true`; Stripe intents carry `metadata.idempotencyKey`.
- Worker (`OrdersWorkerModule`): jobs `orders.expire-reservation`, `flash-sale.start` (moves units out of Postgres stock into Redis), `flash-sale.end`, `flash-sale.reconcile` (DB = truth for sold units, drift logged, unsold returned); `OrderPaymentListener` on `payments.responses` (saga step, F-05 consumer framework).
- Payment: pay with `Idempotency-Key = orderId` through the existing edge → Kafka → payment-processor path (no `productId` → processor doesn't touch stock; reservations already did).
- Spec `orders/checkout.e2e-spec.ts`; k6 `flash-sale.test.js` (`pnpm loadtest:flash-sale`).
- Deferred: waiting room in front of flash sales is SD-21 (shared component); `BisOrder` monthly partitioning (Q27).
