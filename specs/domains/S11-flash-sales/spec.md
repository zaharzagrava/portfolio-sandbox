# Feature Specification: S11 — Flash Sales (bucketed fast stock, admission, never oversell, async reconciliation) — domain `orders`

**Feature Branch**: `S11-flash-sales` (spec directory `specs/domains/S11-flash-sales`)

**Created**: 2026-10-05

**Status**: Draft

**Input**: User description: "Capability S11 — Flash sales: bucketed Redis stock, admission, never oversell, async reconciliation to Postgres (domain `orders`)." Sources: SD-19 (checkout and inventory, flash-sale half), SD-21 (admission and per-user limits, reused ideas), note 03/04 (Redis: hot keys, stampede, avalanche, eviction, locks), constitution v3.1.0 (III.6, III.3, IV.4–IV.6, V, VII, IX, X), `docs/architecture/pattern-map.md` rows P0324 and P0619, and the contracts of the already written specs S05, S10 (and mentions in S08).

## Scope

In scope:

- **Drop (flash sale) lifecycle for sellers**: schedule a limited number of units of one product at a drop price for a time window, see its progress, cancel it before it starts.
- **Fast stock**: at launch time the units move out of the catalog's regular stock into many independent stock buckets in a fast store, so thousands of buyers never queue on one hot counter (hot-key splitting, P0324).
- **Admission**: a per-sale limit on how many purchase attempts per second reach the stock, plus a per-buyer attempt limit; everyone else is turned away quickly with a retry hint and no side effects (load shedding at the entrance, P0619).
- **Reserve, release, convert** of drop units as the flash source of the order capability's reservation seam: all-or-nothing, never more units than loaded, a per-customer quantity limit, exactly-once return.
- **Never oversell**, including after a fast-store failure: a periodic check against the durable records, and a final reconciliation that returns unsold units to regular stock.
- **Public read** of a drop: countdown, state, approximate remaining units (cheap, cached).
- **Observability** of all of the above.

Out of scope (owners named):

- Cart, checkout request, idempotency of `POST /checkout`, order state machine, order and reservation tables other than the flash columns, payment webhook, expiry sweeper, release retry job → **S10** (same domain). This capability plugs into S10's `ReservationSource` seam.
- Product data, price, stock arithmetic → **S05** (`catalog`; R1). Shops and permissions → **S03**. Payment intents and refunds → **S13**, **S14**. Discount functions → **S45** (they never apply to drop lines).
- A virtual waiting room in front of a mega-drop (queue position, signed admission token) → **S22** (`launch-events`). This capability has its own admission limit and does not depend on S22 (see `questions.md`).
- Shared platform pieces (jobs S49, limiter S50, realtime S51, cache S52, outbox/consumers S53, problem+json, clock, config, metrics S54).
- All screens (drop countdown, buy button states, seller drop form) → web capabilities; the product title and image shown next to a drop are composed by the BFF (**S48**, IX.7 R2).
- Auctions and limited-drop bidding → **S21**. Pickup-point stock → **S19**.

## User Scenarios & Testing *(mandatory)*

Notation: `A`, `B` are products; `S1`, `S2` shops; `U1…Un` buyers; amounts are integer minor units (`49900` = 499.00). A **sale** is one scheduled drop; `units` is how many units it offers; a **bucket** is one independent slice of the sale's stock; a **claim** is the set of units one buyer has taken out of the buckets for one checkout line. "Time is frozen" means tests control the clock. "Loaded" means the sale's units are in the fast store and the catalog's regular stock was lowered by `units`. Every error is `application/problem+json` with `type`, `title`, `status`, `detail`, `instance`, `requestId` and a stable `code`.

### User Story 1 — A buyer gets a drop unit at the drop price, and the sale never sells more than it has (Priority: P1)

At 10:00, thousands of buyers check out the same product. Exactly `units` of them succeed at the drop price; everyone else is told it is sold out, quickly, without creating an order.

**Why this priority**: it is the point of the capability; an oversold drop is a financial and reputational loss.

**Independent Test**: load a sale of 30 units, run 100 buyers at once, count orders and remaining stock.

**Acceptance Scenarios**:

1. **AS-01** (happy path) — **Given** a loaded sale on `A` (30 units, 8 buckets, drop price `49900`, per-customer limit 2, regular price `99900`, regular stock `5` after loading), the window open, and buyer `U1` with `A × 1` in the cart, **When** `U1` checks out, **Then** the answer is `202` (S10 shape) with total `49900`; one order `RESERVED`; one reservation of source `FLASH`, state `HELD`, quantity 1; the buckets together hold 29; regular stock is still 5; the cart is cleared by S10; a replay with the same key returns the same answer (AS-05).
2. **AS-02** (race, never oversell) — **Given** a loaded sale (30 units, 8 buckets, limit 1) and 100 buyers each with `A × 1`, **When** all 100 check out at once (`Promise.all`), **Then** exactly 30 answer `202` and 70 answer `422 out_of_stock` (with `productIds: [A]` and `flashSaleId`); the buckets sum to 0 and no bucket is negative; exactly 30 orders and 30 `HELD` flash reservations exist; regular stock is untouched; the result is identical in 50 repeated runs.
3. **AS-03** (no stranded units) — **Given** a sale with 2 buckets holding 1 and 1 unit (total 2), per-customer limit 2, and `U1` with `A × 2`, **When** `U1` checks out, **Then** it succeeds: the claim draws 1 unit from each bucket and records both draws; cancelling the order later returns exactly 1 unit to each of those two buckets. **And Given** buckets holding 1 and 0 and a buyer wanting 2, **Then** `422 out_of_stock` and the single unit stays in its bucket (all-or-nothing).
4. **AS-04** (price from the sale, never the client) — **Given** a loaded sale at `49900` on `A` whose regular price is `99900`, **When** `U1` checks out `A × 2`, **Then** the order total is `99800`, the item snapshot has unit price `49900`, and no seller discount is applied to this line; a `expectedTotalMinor` of `199800` (the regular total) answers `409 price_changed` with `currentTotalMinor: 99800` (S10's check), and `99800` is accepted.
5. **AS-05** (idempotent replay) — **Given** `U1` checked out with key `K` and got an order, **When** the same request is replayed with `K` sequentially, and five more are sent at once, **Then** each answers the stored response (or `409 idempotency_in_flight` for the simultaneous ones that lose, S10), exactly one claim and one order exist, the buckets hold `units − 1`, and the per-customer quota counts 1.
6. **AS-06** (sold out is cheap and clean) — **Given** a sold-out sale (buckets all 0) and `U1` with `A × 1`, **When** `U1` checks out, **Then** `422 out_of_stock` with `productIds` and `flashSaleId`; no order, item, reservation, history row, outbox row or job was created; the cart is intact; `U1`'s quota is unchanged; no query reached the relational database for this attempt.
7. **AS-07** (per-customer limit) — **Given** a loaded sale with limit 2, **When** `U1` checks out `A × 2` (accepted), then again `A × 1` with a new key, **Then** the second answers `422 flash_sale_limit_exceeded` with `limit: 2` and `flashSaleId`, takes no unit, and creates no order; **When** `U1` then cancels the first order, **Then** the quota is released and a new `A × 2` checkout is accepted. A quantity above the limit in one cart line (e.g. 3 with limit 2) is refused the same way without taking anything.
8. **AS-08** (the sale window) — **Given** a loaded sale with `startsAt = T` and `endsAt = T + 10 min` (loading happened at `T − 60 s`; time is frozen), **When** `U1` checks out `A × 1` at `T − 1 s`, **Then** the order is at the regular price from regular stock (the sale's units are not reachable and regular stock excludes them); **When** at `T` exactly, **Then** the drop price from the buckets; **When** at `T + 10 min` exactly (end is exclusive) **and the end job has not run yet**, **Then** the regular price from regular stock; the buckets are unchanged by the last two regular checkouts.
9. **AS-09** (mixed cart compensation) — **Given** a loaded sale on `A` and regular product `B` with stock 0, and `U1` with `A × 1` and `B × 1`, **When** `U1` checks out, **Then** the answer is `422 out_of_stock` with `productIds: [B]`; the order (if S10 wrote one) is `CANCELLED(out_of_stock)`; the unit taken for `A` is back in its bucket exactly once and `U1`'s quota is restored; a second checkout without `B` succeeds.

### User Story 2 — The entrance holds back more traffic than the stock can serve, and fails closed (Priority: P1)

A drop attracts a crowd far larger than the stock. Only a bounded number of attempts per second reach the stock; the rest are turned away with a clear retry hint, cheaply, before any order work. If the fast store is unavailable, nothing is sold from anywhere else.

**Why this priority**: admission control is what keeps the durable database and the order tier alive during the spike (P0619), and fail-closed is what keeps "never oversell" true during outages.

**Independent Test**: set a low admission rate, fire more attempts than the burst, count answers and side effects.

**Acceptance Scenarios**:

1. **AS-10** (admission limit) — **Given** a loaded, open sale with admission rate 100 attempts per second (burst 100) and 300 simultaneous attempts from 300 buyers (stock plentiful), **When** they all hit checkout at the same frozen instant, **Then** exactly 100 are admitted (and proceed to reserve) and 200 answer `429 flash_sale_busy` with a `Retry-After` of 1–3 seconds; the rejected ones created no order, no claim, no quota use, no database row and kept their carts; all 100 admitted buyers got their own answer (`202` while stock lasts).
2. **AS-11** (refill) — **Given** the state after AS-10, **When** the clock advances 1 s and 300 attempts arrive again, **Then** another 100 are admitted; **When** the clock advances 10 ms, **Then** at most 1 more is admitted (the allowance refills continuously, never above the burst).
3. **AS-12** (per-buyer attempt limit) — **Given** one buyer, **When** they send 31 attempts to the sale within a minute (policy `orders.flash-reserve.user`, 30 per minute per buyer per sale, fail closed), **Then** the 31st answers `429 rate_limited` with `Retry-After`; other buyers are unaffected; the limited attempts took no unit.
4. **AS-13** (fail closed) — **Given** a loaded, open sale and the fast store refusing commands (stock side; and in a second case, the admission side), **When** `U1` checks out `A × 1`, **Then** `503 flash_sale_unavailable` with `Retry-After: 2` within the call timeout; no order exists; the regular stock of `A` is untouched (no fallback to regular stock at any price); a cart with only regular products still checks out normally; once the store is back the same checkout succeeds.

### User Story 3 — A seller schedules, inspects and cancels a drop (Priority: P1)

A seller with `products.write` schedules "5,000 units of this product at 499.00 from 10:00 to 10:30", watches it, and may cancel it before it starts.

**Why this priority**: without a correct schedule nothing else happens; most defects start with bad parameters.

**Independent Test**: create a sale with a valid and an invalid body; read it back; cancel it.

**Acceptance Scenarios**:

1. **AS-14** (create) — **Given** shop `S1` with `A` (`ACTIVE`, regular price `99900`, stock `5000`) and a member with `products.write`, **When** they `POST /shops/S1/flash-sales` with `{productId: A, priceMinor: 49900, units: 3000, buckets: 16, perUserLimit: 2, admissionRatePerSecond: 2000, startsAt: now+1 h, endsAt: now+1 h 30 min}`, **Then** `201 flashSaleMemberSchema` with `Location`, `status: SCHEDULED`, `currency` of the product, `shopId: S1`; one sale row; a load job at `startsAt − 60 s` and an end job at `endsAt` exist; stock of `A` is still 5000; nothing exists in the fast store yet; the `shopId` comes from the path, never the body.
2. **AS-15** (validation classes) — **Given** the same shop, **When** the body has any of: `endsAt ≤ startsAt`; `startsAt` earlier than now + 2 min; a window longer than 24 h; `units` 0, negative, fractional, above 1,000,000; `priceMinor` 0, negative, fractional; `buckets` 0 or above 256; `perUserLimit` 0, above 20, or above `units`; `admissionRatePerSecond` 0 or above 10,000; unknown properties; malformed UUID or dates, **Then** each answers `400 validation_failed` naming the field and creates nothing. Semantic failures answer `422`: `units` above the product's current stock → `insufficient_stock`; `priceMinor` above the product's regular price → `drop_price_above_regular`; an `ARCHIVED` product or one of a non-active shop → `product_unavailable`.
3. **AS-16** (authorization, tenancy) — **Given** shops `S1`, `S2`, **When** the create, list, read and cancel routes are called without credentials, **Then** `401`; by a member of `S1` without `products.write` (create, cancel) → `403`; by a member of `S2` against `S1`'s URL → `404`; creating in `S1` with a `productId` of `S2` → `404 product_not_found` (existence hidden); in a suspended shop → `403 shop_suspended` (S03's gate); no sale is created in any of these cases.
4. **AS-17** (no overlap; concurrency) — **Given** a product with a `SCHEDULED` or `LOADED` sale from 10:00 to 10:30, **When** a second sale for the same product overlaps that window (even by one second), **Then** `409 flash_sale_overlap`; a sale that starts exactly at 10:30 is accepted (windows are half-open); **When** two overlapping creates are sent at once (`Promise.all`), **Then** exactly one `201` and one `409`, and one sale row exists.
5. **AS-18** (list, read, isolation) — **Given** 45 sales over two shops, **When** `GET /shops/S1/flash-sales?limit=20` is paged to the end with the opaque cursor (ordered by `startsAt` descending, ties by `id`), **Then** each page has ≤ 20 items, no sale appears twice or is skipped, none of `S2`'s appears, an invalid cursor or `limit > 100` answers `400`; `GET /shops/S1/flash-sales/:id` returns the sale with exact `stats: {unitsLoaded, unitsRemaining, unitsHeld, unitsSold}`; `S2`'s sale id under `S1` answers `404 flash_sale_not_found`.
6. **AS-19** (cancel and illegal transitions) — **Given** a `SCHEDULED` sale, **When** a member with `products.write` calls `POST /shops/S1/flash-sales/:id/cancel`, **Then** `200`, `status: CANCELLED`, the stock of `A` unchanged, the load and end jobs become no-ops, one `flash_sale.cancelled` event; a second cancel answers `200` with no change; a cancel of a sale that is `LOADED` and not yet started returns the units (AS-25 mechanism) and ends it as `CANCELLED`; a cancel when the window has started (or the status is `ENDED`, `RECONCILED`, `START_FAILED`) answers `409 flash_sale_not_cancellable`; another shop's sale → `404`.

### User Story 4 — Units move to the fast store at launch and the leftovers come back, exactly once (Priority: P1)

A minute before the start, the platform lowers the product's regular stock by `units` and fills the buckets. After the end, once every hold has been paid or released, the unsold units return to regular stock. Every run of these steps is safe to repeat, reorder or run twice at the same time.

**Why this priority**: stock created or lost here is real money; the jobs are the least visible part of the flow.

**Independent Test**: run the load, end and reconcile handlers, twice each and concurrently, and compare stock before and after.

**Acceptance Scenarios**:

1. **AS-20** (load) — **Given** a `SCHEDULED` sale (3000 units, 16 buckets) and product stock 5000, **When** the load job runs at `startsAt − 60 s`, **Then** the catalog's stock is exactly 2000 through one stock command with operation `orders:flash:<saleId>:load` (delta `−3000`, reason `flash.load`); the 16 buckets hold 188 or 187 units each (difference at most 1) and sum to 3000; the sale is `LOADED`; one `flash_sale.loaded` event is in the outbox; nothing in the sale is open before `startsAt` (AS-08).
2. **AS-21** (load is idempotent and crash-safe) — **Given** the sale of AS-20 loaded and `5` units already sold, **When** the load job is delivered again (and a third time while the first still runs), **Then** stock is not lowered again and the buckets are not refilled: they still sum to 2995. **And Given** a crash after the stock command but before the buckets were written (then after buckets but before the status change), **When** the job retries, **Then** the end state is identical to a clean run (stock lowered once, buckets filled once, status `LOADED`).
3. **AS-22** (cannot load) — **Given** a `SCHEDULED` sale of 3000 units but product stock now 2000 (changed after scheduling), **When** the load job runs, **Then** the sale becomes `START_FAILED` with reason `insufficient_stock`; the stock is unchanged; the fast store holds nothing for it; one `flash_sale.start_failed` event; the job is not retried; later checkouts of `A` are regular. **And** when the fast store is down during loading, the job retries with backoff (≤ 8 attempts) and the sale stays `SCHEDULED`; if `endsAt` passes unloaded it becomes `START_FAILED(window_missed)` and any stock command applied is reversed by its return operation.
4. **AS-23** (end) — **Given** a `LOADED` sale past `endsAt`, **When** the end job runs (twice), **Then** the sale is `ENDED` once, the final reconciliation is scheduled once, and a checkout of `A` is regular (this was already true at `endsAt`, AS-08). **And Given** an end job that runs on a still `SCHEDULED` sale (the load never happened), **Then** `START_FAILED(window_missed)`; **and** an end job arriving before a late load job leaves the later load a no-op (the sale is not `SCHEDULED` any more). **And** a job whose payload is malformed or names an unknown sale is rejected (dead-lettered) without any side effect.
5. **AS-24** (reconciliation waits for holds) — **Given** an `ENDED` sale with 3 `HELD` flash reservations, **When** the final reconciliation runs, **Then** it returns nothing, leaves the sale `ENDED`, and retries later (backoff, first retry within 60 s); an alert counter `flash_sale_reconcile_waiting` is incremented; **When** the holds are converted or released and it runs again, **Then** it completes (AS-25).
6. **AS-25** (reconciliation returns the leftovers once) — **Given** an `ENDED` sale of 3000 units with 2400 `CONVERTED` flash units and no `HELD`, **When** reconciliation runs twice and simultaneously on two instances, **Then** exactly 600 units return to regular stock through one stock command with operation `orders:flash:<saleId>:return` (delta `+600`, reason `flash.return`), the sale is `RECONCILED`, the fast-store keys of the sale are removed, one `flash_sale.reconciled` event `{unitsSold: 2400, unitsReturned: 600, driftUnits: 0}` exists, and catalog stock equals `original − 2400` exactly. A sale with `unsold = 0` makes no stock command.
7. **AS-26** (drift: the durable records win) — **Given** the sale of AS-25 but the fast store showing 590 remaining (a lost release) or 640 (phantom stock), **When** reconciliation runs, **Then** 600 units still return (derived from the durable records, never from the fast store), the drift counter `flash_sale_stock_drift_units_total` increases by 10 or 40 with direction `redis_low` or `redis_high`, a warning with the sale id is logged, and the sale is `RECONCILED`.
8. **AS-27** (periodic verification clamps phantom stock) — **Given** a `LOADED`, open sale of 100 units with 40 `HELD`/`CONVERTED` flash units in the durable records and the fast store restored from an old snapshot showing 90 remaining (more than the 60 that can still exist), **When** the periodic verification runs (every 30 s), **Then** the buckets are lowered so that they sum to at most 60, the clamp is logged and counted (`flash_sale_phantom_stock_units_total`), and the next 70 checkouts yield exactly 60 orders; the verification never raises stock during the sale.
9. **AS-28** (oversell remediation) — **Given** a sale of 100 units where, after a fast-store failure, the durable records show 104 `HELD`/`CONVERTED` flash units (4 over, the newest 4 orders `RESERVED` and unpaid), **When** the periodic verification runs, **Then** the sale stops selling (reserve answers `out_of_stock`), the 4 newest unpaid orders are cancelled with reason `out_of_stock` through S10's cancel (their units are not returned to the buckets), `flash_sale_oversell_detected_total` increases by 4 and an `flash_sale.oversold {saleId, excessUnits: 4, cancelledOrderIds}` event is emitted; **and Given** the excess orders are already `PAID`, **Then** they are not cancelled; the event carries `unresolvedPaidUnits` and the sale is flagged for operators (the counter is the alert).
10. **AS-29** (single run across instances) — **Given** two worker instances, **When** the periodic verification and the claim sweeper both fire on both, **Then** each logical run executes once per schedule (lease), with no double clamp and no double return.

### User Story 5 — Units come back or become permanent exactly when they should (Priority: P1)

A held unit that is not paid within 15 minutes, or whose order is cancelled, goes back to the bucket it came from and the buyer's quota is restored; a paid unit stays sold. A late or repeated message never changes the count a second time.

**Why this priority**: released units that are added twice create stock out of nothing; converted units that are released sell the same unit twice.

**Independent Test**: release the same claim twice; convert then release; release then convert.

**Acceptance Scenarios**:

1. **AS-30** (release on cancel or expiry) — **Given** `U1` holds `A × 2` from buckets 3 and 5 (1 each), **When** the order is cancelled by the buyer (or the hold expires), **Then** the reservation becomes `RELEASED`, buckets 3 and 5 each gain 1, `U1`'s quota is restored, and a different buyer can then buy those units while the sale is open.
2. **AS-31** (release is idempotent) — **Given** the state of AS-30, **When** the release is requested again (the cancel and the expiry job both run, or the retry job repeats it, also simultaneously), **Then** the buckets and quota change exactly once; the answer of the repeated call is "already released".
3. **AS-32** (release failure) — **Given** a `CANCELLED` order whose flash reservation is `RELEASE_PENDING` and the fast store refusing commands, **When** S10's release job runs, **Then** the reservation stays `RELEASE_PENDING`, the pending gauge (S10) shows it, and no unit is lost; **When** the store is back and the job retries, **Then** the reservation becomes `RELEASED` and the units return once.
4. **AS-33** (convert on payment) — **Given** a `HELD` flash reservation, **When** S10 converts it (payment confirmed), **Then** it becomes `CONVERTED`, the units stay out of the buckets permanently, the quota stays consumed, and a later release request for it is refused as "not held" without touching buckets or quota; repeated conversion is a no-op.
5. **AS-34** (late payment after release) — **Given** a reservation already `RELEASED` (hold expired, units possibly bought by someone else), **When** S10 asks to convert it (the payment arrived late or out of order), **Then** the source answers `not_held`, buckets and quota are untouched, and S10 applies its late-payment refund rule; no unit is sold twice.
6. **AS-35** (abandoned claim) — **Given** a claim taken for `U1` (2 units) and the process died before any order was written, **When** the claim window (60 s) has passed and the claim sweeper (every 10 s) runs, **Then** the 2 units return to their buckets, the quota is restored, a counter `flash_sale_claims_expired_total` increases, and no order exists.
7. **AS-36** (a claim that became an order is never reclaimed) — **Given** a claim whose order was written and committed but whose confirmation to the fast store was lost, **When** the sweeper runs after the claim window, **Then** it finds the flash reservation in the durable records for that claim and keeps the units out (treats the claim as committed); **and Given** a checkout that reaches the order write with less than 20 s of its claim window left, **Then** it releases the claim and answers `503 checkout_unavailable` with `Retry-After: 2` instead of writing the order.
8. **AS-37** (events, exactly once per transition) — **Given** the lifecycle transitions of a sale, **When** each job is delivered twice, **Then** each of `flash_sale.loaded`, `.ended`, `.reconciled`, `.cancelled`, `.start_failed` is in the outbox exactly once, written in the same transaction as the status change (a failed outbox append leaves the status unchanged), with envelope `{eventId, type, version: 1, occurredAt, aggregateId: saleId}` and payload validated by the schema in `packages/contracts`; `flash_sale.sold_out` is emitted once, when the last unit is claimed.

### User Story 6 — Everyone can see the countdown and roughly how many units are left (Priority: P2)

Visitors see "starts in 00:42", "LIVE — about 120 left", "sold out", "ended", refreshed every second or two, without hurting the buyers' path.

**Why this priority**: the page is what drives the spike; it must be cheap and must not distort admission or stock.

**Independent Test**: fetch the public view in each state, then fire a thousand concurrent reads and count stock reads.

**Acceptance Scenarios**:

1. **AS-38** (public view) — **Given** sales in each state, **When** an anonymous caller calls `GET /flash-sales/:saleId`, **Then** `200 flashSalePublicSchema` `{saleId, productId, priceMinor, currency, perUserLimit, startsAt, endsAt, state, remainingApprox, serverTime}` with `state` one of `UPCOMING` (before `startsAt`), `LIVE`, `SOLD_OUT`, `ENDED` (also for `RECONCILED`); `Cache-Control: public, s-maxage=1`; no `units`, bucket count, admission rate, `shopId` internals or buyer data; an unknown id, a `CANCELLED` or `START_FAILED` sale, and a `SCHEDULED` sale whose start is more than 24 h away answer `404 flash_sale_not_found`.
2. **AS-39** (batch by product) — **Given** products with sales, **When** an anonymous caller calls `GET /flash-sales?productIds=<ids>` (the BFF's R2 target), **Then** `200` with the public views of the product's current or next sale (at most one per product), omitting products without one; more than 100 ids, a malformed id or no ids answers `400`.
3. **AS-40** (stampede and degradation) — **Given** a live sale, **When** 1,000 concurrent anonymous reads arrive for it, **Then** the stock buckets are read at most once per second for that sale (one shared load, cached 1 s with jitter, serving the previous value while refreshing), and no read touches the relational database; **Given** the fast store down, **Then** the view answers `200` with `remainingApprox: null` and `degraded: true`, still without errors.
4. **AS-41** (remaining is approximate and sane) — **Given** a live sale selling fast, **When** the view is read, **Then** `remainingApprox` is an integer between 0 and `units`, never negative even when a bucket momentarily reads negative, is at most 2 s old, equals 0 and `state: SOLD_OUT` once the last unit is claimed, and is never used to decide a purchase (a checkout is decided only by the stock itself).

### User Story 7 — Operators can trust and see it, and the domain stays clean (Priority: P3)

**Acceptance Scenarios**:

1. **AS-42** (observability) — **Given** a run of AS-02, AS-06, AS-07, AS-10, AS-26, AS-28, **When** metrics are scraped, **Then** `flash_sale_reservations_total{result="reserved|sold_out|limit_exceeded|not_open"}`, `flash_sale_admission_rejected_total`, `flash_sale_stock_remaining{saleId}` (gauge, refreshed at each verification), `flash_sale_stock_drift_units_total{direction}`, `flash_sale_oversell_detected_total`, `flash_sale_claims_expired_total` reflect the run; every log line of a reservation carries `requestId` and `saleId` and never a buyer's e-mail or token; spans cover admission, reserve, release and each job.
2. **AS-43** (domain boundaries) — **Given** the finished implementation, **When** `check:table-ownership --strict` and `check:boundaries` run, **Then** no flash-sale file produces a finding: no query or model of the catalog's, identity's or payments' tables, no flash class or model in the domain's public entry point, and stock is changed only through the catalog's exported stock command (static gates, not an e2e).
3. **AS-44** (pure: bucket allocation and draw plan) — **Given** the pure functions that split `units` over `buckets` and plan a draw of `q` units over the current bucket contents, **When** given any inputs, **Then** the split sums to `units` with parts differing by at most 1; a plan either sums to exactly `q` using only available units, or reports "insufficient" when the total is below `q`; no plan takes a negative or more-than-available amount from a bucket; the start bucket only changes the order, never the success.
4. **AS-45** (pure: sale state machine and window) — **Given** the pure transition table and window function, **When** given every (status, command) pair and instants around `startsAt` and `endsAt`, **Then** only the transitions of FR-007 are allowed, every other pair is an illegal transition, and the window is open exactly for `startsAt ≤ now < endsAt`.
5. **AS-46** (pure: admission allowance and drift classification) — **Given** the pure allowance function (rate, burst, elapsed time) and the drift classifier, **When** given tables of inputs, **Then** the allowance never exceeds the burst nor goes below zero and refills linearly; drift is classified `none`, `redis_low`, `redis_high`, `phantom_stock` or `oversold` by the rules of FR-026 and FR-028 with the clamp amount computed exactly.

### Edge Cases

- A product with a sale in its window is bought through the sale only; regular stock is unreachable in that window (no price arbitrage); outside the window it is regular (AS-08).
- A buyer with a drop line and an unrelated regular line is handled line by line; any failure releases the drop units exactly once (AS-09).
- Two buyers claim the last unit at once → exactly one wins (AS-02); the last unit is held by an unpaid order → the next buyer sees sold out until it is released (AS-30).
- The load job lands late (after `startsAt`) → selling starts when loaded, within the same window (FR-012); if after `endsAt` → `START_FAILED(window_missed)`.
- The fast store loses data (restart, failover): lost decrements create phantom stock → clamped (AS-27) or detected (AS-28); lost releases lose availability → corrected after the end (AS-26). A missing bucket is "empty", never "full": a bucket is never re-created during a sale.
- The shop is suspended during a sale: its products stop being purchasable through S10's rule and no drop units sell; the sale still ends and reconciles normally.
- A price, title or stock edit of the product during the sale: the sale price is fixed at scheduling; regular stock changes by other capabilities do not touch loaded units.
- Clock skew between instances: the window is evaluated with the injected clock; admission and expiry never rely on a client time.
- Duplicate, reordered and late jobs: AS-21, AS-23, AS-25, AS-29, AS-37.
- The buyer is a guest: checkout requires an account (S10); there is no anonymous reserve.

## Requirements *(mandatory)*

### Functional Requirements

**Sale definition and lifecycle**

- **FR-001**: A sale belongs to one shop and offers `units` (1–1,000,000) of one product at `priceMinor` (integer ≥ 1, ≤ the product's regular price at scheduling) in the product's currency, over a half-open window `[startsAt, endsAt)` (start ≥ now + 2 min, length ≤ 24 h), with `buckets` (1–256, default 16), `perUserLimit` (1–20 and ≤ `units`, default 2) and `admissionRatePerSecond` (1–10,000, default 2,000) (AS-14, AS-15).
- **FR-002**: Scheduling checks the product through the catalog's exported read service scoped to the shop (a product of another shop is `404 product_not_found`), refuses non-sellable products (`product_unavailable`), and advises on stock (`units` ≤ current stock, `insufficient_stock`); the check at scheduling is advisory, the check at loading is binding (AS-15, AS-22).
- **FR-003**: Two sales of the same product may not overlap in time unless one is terminal (`CANCELLED`, `START_FAILED`, `RECONCILED`); the rule is enforced by the store so two concurrent creates yield exactly one sale (AS-17).
- **FR-004**: Shop routes require `ShopScoped` with `products.write` (create, cancel) or `products.read` (list, read); every query puts the shop in its predicate; another shop's sale is `404 flash_sale_not_found`; a suspended shop gets S03's `403 shop_suspended` (AS-16, AS-18).
- **FR-005**: Lists use keyset pagination with an opaque cursor over `(startsAt DESC, id DESC)`, `limit` ≤ 100 (default 20) (AS-18).
- **FR-006**: Status is one of `SCHEDULED`, `LOADED`, `ENDED`, `RECONCILED`, `CANCELLED`, `START_FAILED`. The sale is **open** (buyers can reserve) iff status is `LOADED` and `startsAt ≤ now < endsAt` by the injected clock; the status never decides alone (AS-08, AS-45).
- **FR-007**: Allowed transitions, each a conditional update asserting one affected row plus a history entry in the same transaction: `SCHEDULED → LOADED`, `SCHEDULED → START_FAILED`, `SCHEDULED → CANCELLED`, `LOADED → ENDED`, `LOADED → CANCELLED` (only before `startsAt`), `ENDED → RECONCILED`; every other pair is illegal (`409 flash_sale_not_cancellable` on the cancel route, a logged no-op for jobs) (AS-19, AS-23, AS-45).
- **FR-008**: Cancelling is idempotent (a second cancel of a `CANCELLED` sale is `200`, no change); a cancel of a loaded, not-yet-started sale ends it and returns every unit through the reconciliation mechanism (AS-19).
- **FR-009**: A sale is immutable once created except for its status; a change is a cancel plus a new sale (AS-14).

**Loading, fast stock and buckets**

- **FR-010**: At `startsAt − 60 s` the load step lowers the product's regular stock by `units` through the catalog's exported stock command with operation ID `orders:flash:<saleId>:load` (reason `flash.load`), fills the buckets, and moves the sale to `LOADED`, in an order that is safe to repeat, reorder or crash at any point (AS-20, AS-21).
- **FR-011**: The units are split over the buckets as evenly as possible (parts differ by at most 1, sum is `units`); buckets are placed so that they can live on different shards of the fast store, so no single key serializes the sale (hot-key splitting, P0324) (AS-20, AS-44).
- **FR-012**: Loading never overwrites an existing bucket: a bucket that already exists keeps its count; a bucket that is missing while the sale is `LOADED` and past its load is treated as empty and is never re-created (AS-21, AS-27). A sale loaded after `startsAt` sells from the moment it is loaded until `endsAt`.
- **FR-013**: When the catalog rejects the load (insufficient stock) the sale becomes `START_FAILED(insufficient_stock)` without retries and without any fast-store content; transient failures (fast store, catalog timeout) retry with exponential backoff and full jitter, at most 8 attempts, and a sale still `SCHEDULED` at `endsAt` becomes `START_FAILED(window_missed)` with any applied load reversed through its return operation (AS-22, AS-23).
- **FR-014**: Every fast-store call has an explicit timeout (100 ms for reserve, release and admission); a stock or admission call that fails or times out is never retried inside one buyer request and never falls back to regular stock (AS-13).
- **FR-015**: Every key of the fast store has a time-to-live that extends past the sale's end plus the hold time, with jitter (cache-avalanche protection, P0324); keys are removed at reconciliation; no key space is shared with a queue (III.9) (AS-25).

**Admission (load shedding at the entrance)**

- **FR-016**: Before any cart, catalog, order or stock work for a drop line, an attempt must be admitted by the sale's admission allowance: `admissionRatePerSecond` attempts per second, refilling continuously, burst equal to one second of rate, evaluated atomically across all instances with the injected clock. Not admitted → `429 flash_sale_busy` with `Retry-After` 1–3 s (random within the range), no side effects (P0619) (AS-10, AS-11, AS-46).
- **FR-017**: A per-buyer, per-sale attempt limit (policy `orders.flash-reserve.user`, 30 per minute, fail closed) answers `429 rate_limited` with `Retry-After` (AS-12).
- **FR-018**: Admission applies only to attempts on a product whose sale is open; checkouts of other products and of the same product outside the window are not admitted or counted (AS-08, AS-10).
- **FR-019**: When admission or the stock store is unavailable the answer is `503 flash_sale_unavailable` with `Retry-After: 2`; the system fails closed (AS-13).

**Reserve, release, convert (the flash `ReservationSource` of S10)**

- **FR-020**: A reservation for `q` units of a line is all-or-nothing and atomic per bucket draw: it consumes the buyer's quota, then draws `q` units from the buckets starting at a random bucket and continuing through the others, taking from several buckets when no single bucket holds `q`; it fails (`out_of_stock`) only when the buckets together hold fewer than `q`; if it fails after taking anything, it gives everything back (AS-02, AS-03, AS-44).
- **FR-021**: The claim records exactly which bucket each unit came from, the buyer, the quantity, a `claimId`, and a claim window of 60 s; a claim becomes **committed** when the durable reservation row for it exists. The drop price is returned by the source as `unitPriceMinor` and is the only price used for the line (AS-01, AS-03, AS-04).
- **FR-022**: Per-buyer quota counts the buyer's live units in the sale (claimed, held or converted); a request that would exceed `perUserLimit` is refused before any unit is taken (`422 flash_sale_limit_exceeded` with `limit`, `flashSaleId`); released units free quota (AS-07, AS-30).
- **FR-023**: Release returns each unit to the bucket it came from and the quota to the buyer, exactly once per claim regardless of how many times, how late or how concurrently it is requested; release of a `CONVERTED` claim is refused ("not held"); convert marks a held claim sold and is idempotent; convert of a `RELEASED` claim answers `not_held` (AS-30–AS-34).
- **FR-024**: An uncommitted claim whose window has passed is returned by a sweeper (every 10 s); before returning, the sweeper checks the durable records for a flash reservation of that claim and keeps the units out if one exists. An order is written only if ≥ 20 s of the claim window remain; otherwise the claim is released and the buyer gets `503 checkout_unavailable` (AS-35, AS-36).
- **FR-025**: Reservation and order creation do not share a transaction with the fast store (III.3): no fast-store call happens inside an open database transaction; a failure of the order write releases the claim; a crash between the two is covered by FR-024.

**Never oversell: verification and reconciliation**

- **FR-026**: Invariant: units sold or held at any time ≤ `units`. The fast store enforces it atomically while it is alive; the durable records (reservations with source `FLASH`) are the truth after a failure. A periodic verification (every 30 s per `LOADED` sale, single-run) computes `reservedDurable = HELD + CONVERTED flash units` and compares with the buckets: if `bucketsRemaining + reservedDurable > units` (phantom stock), the buckets are lowered to fit; if `reservedDurable > units` the sale stops selling, and the newest unpaid reservations beyond `units` are cancelled with reason `out_of_stock` through S10's cancel without returning their units; paid excess is only reported (`unresolvedPaidUnits`). The verification never adds stock during the sale (AS-27, AS-28).
- **FR-027**: Final reconciliation runs after `endsAt + hold time (15 min) + 60 s`, and only when no flash reservation of the sale is `HELD`; otherwise it retries (≤ every 60 s, with an alert counter after 10 minutes of waiting). It returns `unsold = units − CONVERTED units` (never less than 0) through the catalog's stock command with operation `orders:flash:<saleId>:return` (reason `flash.return`; skipped when 0), removes the fast-store keys, sets `RECONCILED` and emits the event in one transaction (AS-24, AS-25).
- **FR-028**: Reconciliation compares the fast store's remaining count with `unsold` and records drift (`redis_low`, `redis_high`) in the metric and a warning; the returned amount never depends on the fast store (AS-26).
- **FR-029**: Reconciliation, verification, load, end and the sweeper are safe to run twice, concurrently, or in any order; each logical run takes a lease so it executes once per schedule across instances (VIII.6) (AS-21, AS-25, AS-29).
- **FR-030**: Every unit of every sale is accounted for: `loaded = sold + returned + lostToDrift`, and `lostToDrift` is reported by the reconciliation event (AS-25, AS-26).

**Events, public read, observability**

- **FR-031**: Lifecycle transitions publish `flash_sale.loaded`, `flash_sale.ended`, `flash_sale.reconciled`, `flash_sale.cancelled`, `flash_sale.start_failed`, `flash_sale.oversold` and `flash_sale.sold_out` through the outbox in the transition's transaction; each event has `eventId`, `type`, `version`, `occurredAt`, aggregate ID `saleId`, and a payload schema in `packages/contracts` (AS-37).
- **FR-032**: `GET /flash-sales/:saleId` and `GET /flash-sales?productIds=` are anonymous, read the sale's state from the durable record through a shared cache (1 s, with jitter, single-flight, serve-stale-while-refreshing) and the approximate remaining count from the buckets, and expose only the public fields (AS-38–AS-41).
- **FR-033**: The remaining count is advisory and never decides a purchase; it is non-negative, ≤ `units`, and `null` with `degraded: true` when the stock store is unavailable (AS-40, AS-41).
- **FR-034**: Metrics, logs and spans of AS-42; alerts exist for `flash_sale_oversell_detected_total > 0`, drift ≠ 0, a sale `ENDED` for more than 30 minutes, and `flash_sale_reconcile_waiting` after 10 minutes.
- **FR-035**: Delays, limits and rates are configuration with the defaults of this spec, validated at startup: load lead 60 s, minimum scheduling lead 2 min, maximum window 24 h, claim window 60 s, order-write margin 20 s, verification interval 30 s, sweeper interval 10 s, call timeout 100 ms, public cache 1 s, per-buyer limit 30/min (AS-10–AS-13, AS-35).
- **FR-036**: This capability reads or writes no table and no model of another domain: catalog data through R1 `ProductQueryService.getProductsByIds(ids, {shopId})`, stock only through R1 `ProductStockService.applyStockDelta`; its sale and flash-reservation data are owned by `orders`; it exports no model, repository, job class or fast-store class (AS-43).
- **FR-037**: Mandatory API cases of VII.3 hold for every route as the scenarios above: `401` (AS-16), validation classes (AS-15), IDOR `404` (AS-16, AS-18), illegal transition `409` (AS-19), concurrency (AS-02, AS-17, AS-25), rate limit `429` (AS-10, AS-12); VII.4: the jobs are consumers of their schedule with duplicate-delivery tests (AS-21, AS-25, AS-37) and invalid-payload tests (a job with a malformed or unknown `saleId` is rejected without side effects, covered in AS-23).

### Key Entities

- **Flash sale**: shop ID, product ID (plain IDs), drop price, currency, units, buckets, per-customer limit, admission rate, window, status, status reason, version, timestamps. Owned by `orders` (`FlashSale`).
- **Bucket**: one independent slice of a sale's stock in the fast store; holds an integer count. Not durable.
- **Claim**: units one buyer took for one line: claim ID, sale, buyer ID, per-bucket draws, claim window, state `CLAIMED`/`COMMITTED`/`SOLD`/`RETURNED`. Held in the fast store; its durable counterpart is the flash reservation.
- **Flash reservation**: an S10 stock-reservation row with source `FLASH`, product, quantity, status (`REQUESTED`/`HELD`/`CONVERTED`/`RELEASE_PENDING`/`RELEASED`), sale ID and claim ID as source reference. Owned by `orders`.
- **Buyer quota**: the live units a buyer holds in one sale, in the fast store, bounded by `perUserLimit`.
- **Admission allowance**: the sale's shared rate state in the fast store.
- **Sale history**: append-only record of each status transition: from, to, reason, time.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In a race of 200 buyers for 50 drop units, exactly 50 are accepted, 0 units are oversold, and no bucket ever goes below zero, in 100% of 50 repeated runs; with 100 buyers for 30 units at quantity 1 the sale sells out completely (remaining 0) in 100% of runs.
- **SC-002**: With 2,000 buyers attempting at the same moment, 99% of answers (accepted or refused) arrive in under 150 ms, and 99% of refusals (sold out, not admitted) arrive in under 50 ms with no database write.
- **SC-003**: Under any repeat or reorder of the load, end, reconcile, release and convert steps (sequential, simultaneous, after a crash), stock is lowered once, returned once, and every unit is accounted for: `loaded = sold + returned + reported drift` in 100% of test runs.
- **SC-004**: After a simulated fast-store restore with phantom stock, at most the corrected number of units is sold, and the problem is detected within 60 seconds of the first verification opportunity, in 100% of runs.
- **SC-005**: Unsold units are back in regular stock within 20 minutes after a sale ends (15-minute hold plus 5 minutes grace) in 100% of sales without stuck holds.
- **SC-006**: 100% of attempts to schedule, read or cancel another shop's sale return "not found" with identical bodies and change nothing.
- **SC-007**: 1,000 concurrent viewers of a drop page cause at most 1 stock read per second per sale and 0 database reads, and the approximate count they see is at most 2 seconds old.
- **SC-008**: When the fast store is down, 100% of drop checkouts are refused with a retry hint and 0 units are sold from any other source.
- **SC-009**: The ownership check reports 0 cross-domain accesses for the flash-sale code (today 3 `Product` accesses and 1 model injection in it).

## Cross-capability contracts

Earlier specs searched (`grep -rl` over `specs/domains`, `specs/web`, `specs/journeys` for `S11` and `orders`; `specs/web` and `specs/journeys` do not exist yet). Contracts they require from this capability and how they are honoured:

- **S10** (`orders`, same domain): defines the `ReservationSource` seam (`reserve(order, lines)`, `release(reservation)`, `convert(reservation)`), reservation source values, statuses `REQUESTED`/`HELD`/`CONVERTED`/`RELEASE_PENDING`/`RELEASED`, the retrying release job, the order-expiry sweeper, and says S11 "owns the flash-sale routes, jobs and stock keys" and "restores the drop behaviour through the seam" (honoured). **Differences, raised as `[CONTRACT]` questions:** (1) drop reservation must run **before** the order is written (S10's FR-025 writes the order first), so a refused buyer creates nothing; (2) the source returns the unit price and S10 never discounts a flash line; (3) the seam carries a `sourceRef` and the buyer ID; (4) the source decides admission before any other checkout work.
- **S05**: callers use `applyStockDelta` with `operationId` `<service>:<aggregate-id>:<step>`, compensation as a new operation, and S11 is listed as consumer for reconciliation (honoured: `orders:flash:<saleId>:load` / `…:return`); `getProductsByIds(ids, {shopId})` for the scheduling check (honoured).
- **S08**: stock changes through `applyStockDelta` reach providers without this capability calling `catalog-sync` (honoured; loading lowers the synced quantity and the return raises it).

**Provides** (exact names; exported from `@app/domains/orders` unless it is an HTTP endpoint or internal to the domain):

- HTTP under `/api`, problem+json errors with `code`, schemas in `packages/contracts` (`flashSaleCreateRequestSchema`, `flashSaleMemberSchema`, `flashSalePageSchema` = `{items, nextCursor}`, `flashSalePublicSchema`, `flashSaleEventSchemas`):
  - `POST /shops/:shopId/flash-sales` (`ShopScoped('products.write')`) body `{productId, priceMinor, units, buckets?, perUserLimit?, admissionRatePerSecond?, startsAt, endsAt}` → `201 flashSaleMemberSchema` with `Location`; codes `validation_failed`, `product_not_found`, `product_unavailable`, `insufficient_stock`, `drop_price_above_regular`, `flash_sale_overlap`.
  - `GET /shops/:shopId/flash-sales?status&limit&cursor` (`products.read`) → `flashSalePageSchema`; `GET /shops/:shopId/flash-sales/:saleId` (`products.read`) → `flashSaleMemberSchema` = `{id, shopId, productId, priceMinor, currency, units, buckets, perUserLimit, admissionRatePerSecond, startsAt, endsAt, status, statusReason, stats: {unitsLoaded, unitsRemaining, unitsHeld, unitsSold} | null, createdAt}`; `POST /shops/:shopId/flash-sales/:saleId/cancel` (`products.write`) → `200 flashSaleMemberSchema` (`flash_sale_not_cancellable` 409, `flash_sale_not_found` 404).
  - `GET /flash-sales/:saleId` (anonymous) → `flashSalePublicSchema` `{saleId, productId, priceMinor, currency, perUserLimit, startsAt, endsAt, state: 'UPCOMING' | 'LIVE' | 'SOLD_OUT' | 'ENDED', remainingApprox: number | null, degraded?: true, serverTime}` with `Cache-Control: public, s-maxage=1`; `GET /flash-sales?productIds=` (anonymous, ≤ 100 ids; the BFF's R2 target, S48) → array of `flashSalePublicSchema`.
  - Checkout problem codes added to S10's list (raised by the flash source): `out_of_stock {productIds, flashSaleId?}` (S10's code, extended), `flash_sale_limit_exceeded {limit, flashSaleId}` (422), `flash_sale_busy` (429, `Retry-After`), `flash_sale_unavailable` (503, `Retry-After: 2`).
- Domain port implementation (inside the domain, consumed by S10): `FlashReservationSource` implementing S10's `ReservationSource` with source value `FLASH`: `admit(buyerId, lines)`, `reserve(buyerId, lines) → { holds: { productId, quantity, unitPriceMinor, sourceRef (claimId), flashSaleId }[] } | { rejected: { productId, code: 'out_of_stock' | 'limit_exceeded' | 'busy' | 'unavailable', … } }` (runs **before** the order is written, mode `BEFORE_ORDER`), `release(reservation)` (idempotent), `convert(reservation)` (idempotent; `not_held` when released), `commit(sourceRef)`. Nothing else is exported (no model, repository, job, fast-store class).
- Events (outbox → topic `orders.events`, key `saleId`; envelope `{eventId, type, version: 1, occurredAt, aggregateId}`): `flash_sale.loaded {saleId, shopId, productId, units, buckets, startsAt, endsAt}`, `flash_sale.ended {saleId, shopId, productId}`, `flash_sale.reconciled {saleId, shopId, productId, units, unitsSold, unitsReturned, driftUnits}`, `flash_sale.cancelled {saleId, shopId, productId}`, `flash_sale.start_failed {saleId, shopId, productId, reason}`, `flash_sale.sold_out {saleId, shopId, productId}`, `flash_sale.oversold {saleId, shopId, productId, excessUnits, cancelledOrderIds, unresolvedPaidUnits}`. **Consumers: none required today; S28 (seller notification), S40 (sales and leaderboards), S36 (conversion) and J01 may subscribe.**
- Jobs (registered with S49): `flash-sale.load` (per sale, `runAt = startsAt − 60 s`), `flash-sale.end` (per sale, `runAt = endsAt`), `flash-sale.reconcile` (per sale, after the end), `flash-sale.verify` (every 30 s per `LOADED` sale, single-run), `flash-sale.sweep-claims` (every 10 s, single-run).
- Rate-limit policies (declared in S50's registry): `orders.flash-reserve.user` 30/minute per buyer per sale (fail closed); `orders.flash-sale-read.ip` 600/minute per address (fail open).
- Modules for the apps: `OrdersModule` (core: HTTP) and `OrdersWorkerModule` (worker: jobs) as in S10; no extra module is exported.

**Requires**:

- **S10** (`orders`): `ReservationSource` with the shape above and the `BEFORE_ORDER` mode: for lines whose product has an open sale S10 calls `admit` then `reserve` before writing the order, writes the order with reservation rows (`source: 'FLASH'`, `sourceRef`) and then `commit`s; compensates with `release` when the write fails; excludes flash lines from the discount port; takes the line's price from the hold; calls `convert` on payment and `release` (through `RELEASE_PENDING` and its retry job) on cancel or expiry; keeps one checkout per buyer at a time (`409 checkout_in_progress`); provides the `Idempotency-Key` replay before any source is called; `cancel(orderId, 'out_of_stock')` for oversell remediation and its `PAID` refusal; the `StockReservation` row with `source`, `sourceRef`, `quantity`, `status`, order ID (read by the verification: sums of `HELD` and `CONVERTED` by sale).
- **S05** (`catalog`): `ProductQueryService.getProductsByIds(ids ≤ 500, { shopId })` returning `{id, shopId, priceMinor, currency, quantity, status: 'ACTIVE' | 'ARCHIVED', isSandbox}`; `ProductStockService.applyStockDelta(ops)` with `StockOperation = { operationId: 'orders:flash:<saleId>:load' | 'orders:flash:<saleId>:return', productId, shopId, delta, reason: 'flash.load' | 'flash.return' }`, all-or-nothing, never below zero, idempotent per `operationId` for 30 days (this capability needs ≥ 3 days), outcomes `applied | rejected {failures: [{operationId, productId, code}]}` with `insufficient_stock` among codes, `replayed` flag.
- **S03** (`tenancy`): `ShopScoped('products.write' | 'products.read')` with the status gate (`403 shop_suspended`, `409 shop_offboarding`); `404` for non-members.
- **S01** (`identity`): `Firewall`, `@User()` for buyer routes (S10's checkout); anonymous access to the public routes.
- **S49** (jobs): delayed per-sale jobs, periodic jobs with single-run leases, retry with backoff and jitter, dead-letter state.
- **S50** (rate limiter): the two policies with `Retry-After`.
- **S52** (`infrastructure/cache`): `getOrLoad(key, loader, { ttlMs, swrMs, jitter })` with single-flight and stale-while-revalidate, used by the public view.
- **S53** (events): `outbox.append(event)` inside the domain's transaction (IX.6).
- **S54** (platform toolkit): problem+json filter with `code` and `requestId`, injected clock, config validation, metrics registry, graceful shutdown.
- **S48** (BFF) and the web capability for drop pages: compose the product with `GET /flash-sales?productIds=` (R2), poll `GET /flash-sales/:saleId` every 1–2 s, show the problem codes above.
- Cross-domain data used (IX.7): product facts and stock changes via **R1** (S05); nothing via R2 here (the BFF is a consumer); no R3 read model (the public view is served from this domain's own records and fast store).

## Assumptions

- Decisions marked `[BREAKING]`, `[CONTRACT]`, `[LOCAL]` are listed one per line in `questions.md`; this spec adopts each default stated there. Most visible: drop reservation runs before the order is written; units move through the catalog's stock command only; load and release are idempotent per claim and per operation; the sale window is strict; sold-out buyers create nothing; admission is this capability's own; fail closed when the fast store is down.
- **Pattern coverage**: P0324 (hot-key splitting, TTL jitter, stampede protection of the public read, degradation) → FR-011, FR-012, FR-015, FR-032, AS-01–AS-03, AS-20, AS-38–AS-41, AS-44; P0619 (admission control and load shedding) → FR-016–FR-019, AS-10–AS-13, AS-46. Related patterns of S10 (idempotency, reservations, state machine) are S10's.
- "The fast store" is Redis in this deployment (replicated, persistence with a one-second flush, no eviction policy that can drop sale keys); it can lose acknowledged writes at failover, which is why the durable records decide after a failure (note 03/04 §1, §5, §8). Postgres, through the catalog's and this domain's tables, is the source of truth; the buckets are a working copy of availability.
- Drop prices are final prices in the product's currency; no seller discount, coupon or tax applies to a drop line.
- A product has at most one open sale at a time; a sale offers one product.
- The 60 s load lead, 2 min scheduling lead, 24 h maximum window, 60 s claim window, 20 s margin, 30 s verification, 10 s sweeper, 100 ms call timeout, 1 s public cache, 30 per minute per-buyer limit, 2,000 per second default admission and the 16-bucket default are configuration defaults of this spec.
- Per-customer quota is held in the fast store and not re-derived from the database during the sale; a quota lost with the store may allow a buyer above the limit for the rest of that sale (a documented, bounded risk; counted at reconciliation).
- A paid order beyond the declared units (only possible after a fast-store failure plus an unnoticed window) is reported, not automatically refunded; refund of such an order is an operator action through S13/S14.
- Waiting-room admission tokens from S22 are not required; if S22 later issues them, a verifier is added in front of `admit` without changing this contract.
- Realtime push of the remaining count is not provided; viewers poll the public view.
- Sale and flash-reservation rows are financial records and are kept; their retention follows S10's order rules.
