---
id: S11
title: Flash sales (scheduled drops, bucketed fast stock, admission, never oversell, async reconciliation)
kind: capability
status: draft
generated_at: 0000000
depends_on: [S03, S05, S10, S49, S50, S52, S53]
concepts: [order-reservation, rate-limit-policy, outbox-task-queue, job-scheduler-lease, transaction-runner, problem-json-errors, cache-layers]
models: []
scope:
  - packages/backend/libs/domains/orders/flash-sale*.ts
  - packages/backend/libs/domains/orders/api/flash-*.ts
  - packages/backend/libs/domains/orders/application/flash-*.ts
  - packages/backend/libs/domains/orders/application/events/flash-sale-events.ts
  - packages/backend/libs/domains/orders/domain/flash-*.ts
  - packages/backend/libs/domains/orders/infra/flash-*.ts
  - packages/backend/libs/domains/orders/infra/models/flash-sale*.ts
  - packages/backend/libs/domains/orders/testing/flash-*.ts
  - packages/contracts/src/orders/flash-sale*.ts
---
# S11 - Flash sales

## Purpose
A seller schedules a **drop**: a fixed number of units of one product at a fixed price inside a time window. A minute before the start the units leave regular stock and move into a fast store, split over buckets so that thousands of buyers do not queue on one counter. During the window a buyer's checkout takes drop units before any order exists, so a buyer who is too late creates no order. When the window is over, the units that were not sold return to regular stock exactly once. The system never sells more units than the drop holds, even when the fast store loses or invents data.

## Entry points
- `POST /shops/:shopId/flash-sales` schedules a drop (`201`, `Location`). `GET /shops/:shopId/flash-sales` pages the shop's drops by keyset; `GET /shops/:shopId/flash-sales/:saleId` reads one with its stats; `POST /shops/:shopId/flash-sales/:saleId/cancel` cancels it before the start. [code: packages/backend/libs/domains/orders/api/flash-sale.controller.ts#FlashSaleController]
- `GET /flash-sales/:saleId` and `GET /flash-sales?productIds=` are the anonymous countdown and the approximate remaining count. [code: packages/backend/libs/domains/orders/api/flash-sale-public.controller.ts#FlashSalePublicController]
- `POST /checkout` (S10) meets drops at one seam: admit, claim the drop lines, write the order, commit the claims. [code: packages/backend/libs/domains/orders/application/flash-reservation.source.ts#FlashReservationSource]
- Jobs: `flash-sale.load` (60 s before the start), `flash-sale.end`, `flash-sale.reconcile`, the periodic `flash-sale.verify` (30 s) and `flash-sale.sweep-claims` (10 s), and `flash-sale.start`, the old name of `load`, for one release. [code: packages/backend/libs/domains/orders/infra/flash-sale.jobs.ts#FlashSaleJobs]
- Events on `orders.events`, keyed by the sale: `flashsale.loaded`, `.ended`, `.reconciled`, `.cancelled`, `.start_failed`, `.sold_out`, `.oversold`. [code: packages/backend/libs/domains/orders/application/events/flash-sale-events.ts#FlashSaleLoaded]

## Rules
- **S11.R-01** A drop sells only inside `[startsAt, endsAt)` by the injected clock and only while it is `LOADED`; before the start and after the end the regular price and regular stock apply. [proof: S11 AS-08, S11 AS-45] [code: packages/backend/libs/domains/orders/domain/flash-sale-state.ts#isOpen]
- **S11.R-02** Drop units are claimed all-or-nothing across the drop lines of a checkout, from buckets that may be combined for one purchase, and never below zero. [proof: S11 AS-02, S11 AS-03, S11 AS-44] [code: packages/backend/libs/domains/orders/domain/flash-bucket-plan.ts#planDraw]
- **S11.R-03** The drop price comes from the sale; no discount applies to a drop line, and an `expectedTotalMinor` computed from the regular price is `409 price_changed`. [proof: S11 AS-04] [code: packages/backend/libs/domains/orders/domain/money-allocation.ts#priceCart]
- **S11.R-04** A claim is deterministic for one buyer, checkout key and product, so a replay of a checkout finds its claim instead of taking another one. [proof: S11 AS-05] [code: packages/backend/libs/domains/orders/application/flash-reservation.source.ts#FLASH_CLAIM_NAMESPACE]
- **S11.R-05** A refused drop attempt (sold out, over the limit, not admitted, store down) creates no order, no history row, no event and no job, and leaves the idempotency key unused. [proof: S11 AS-06, S11 AS-07, S11 AS-10, S11 AS-13]
- **S11.R-06** A buyer takes at most `perUserLimit` units of a sale; the quota is released with the claim. [proof: S11 AS-07, S11 AS-30] [code: packages/backend/libs/domains/orders/infra/flash-scripts.ts#QUOTA_TAKE]
- **S11.R-07** Admission is a token bucket per sale (burst of one second of the rate) evaluated in the fast store with the injected clock; a rejected attempt answers `429 flash_sale_busy` with `Retry-After` 1 to 3. A per-buyer limit (30 per minute and sale) answers `429 rate_limited`. [proof: S11 AS-10, S11 AS-11, S11 AS-12, S11 AS-46] [code: packages/backend/libs/domains/orders/domain/flash-admission.ts#admit]
- **S11.R-08** When the fast store does not answer within the call timeout (default 100 ms) a drop attempt fails closed: `503 flash_sale_unavailable` with `Retry-After: 2`. Regular stock is never used instead, and checkouts without a drop line are unaffected. [proof: S11 AS-13] [code: packages/backend/libs/domains/orders/infra/flash-fast-store.redis.ts#RedisFlashFastStore]
- **S11.R-09** Scheduling needs a product of the shop, a start at least 2 minutes ahead, a window of at most 24 hours, units not above the product's stock and a price not above the regular price; two non-terminal sales of one product never overlap (an exclusion constraint). [proof: S11 AS-14, S11 AS-15, S11 AS-16, S11 AS-17] [code: packages/backend/libs/domains/orders/application/flash-sale.service.ts#FlashSaleService]
- **S11.R-10** A sale moves `SCHEDULED → LOADED → ENDED → RECONCILED`, or to `CANCELLED` (before the start) or `START_FAILED`; every move is a conditional update with a history row and an outbox event in one transaction, and any other move is refused or ignored. [proof: S11 AS-19, S11 AS-23, S11 AS-37, S11 AS-45] [code: packages/backend/libs/domains/orders/domain/flash-sale-state.ts#transition]
- **S11.R-11** Loading takes the units from regular stock through `orders:flash:<saleId>:load`, creates the buckets only if absent and moves the sale to `LOADED`, in an order that is safe to repeat or to crash in; a load that cannot happen ends in `START_FAILED` with a reason. [proof: S11 AS-20, S11 AS-21, S11 AS-22] [code: packages/backend/libs/domains/orders/application/flash-lifecycle.service.ts#FlashLifecycleService]
- **S11.R-12** Reconciliation waits while orders still hold units, then returns the unsold units (units minus sold, from the durable records) once through `orders:flash:<saleId>:return`, drops the keys and moves to `RECONCILED`; a drift of the fast store is measured, never trusted. [proof: S11 AS-24, S11 AS-25, S11 AS-26, S11 AS-46] [code: packages/backend/libs/domains/orders/domain/flash-drift.ts#classify]
- **S11.R-13** Verification during the sale lowers phantom stock to what the records allow and never raises the store; on an oversell it stops selling and cancels the newest unpaid orders beyond the sale size without returning their units; paid excess is only reported. [proof: S11 AS-27, S11 AS-28, S11 AS-29] [code: packages/backend/libs/domains/orders/domain/flash-drift.ts#clampPlan]
- **S11.R-14** Releasing a claim is idempotent and returns units to the buckets they came from; converting makes the units permanent when the order is paid; a released claim can no longer be converted and a converted one can no longer be released. [proof: S11 AS-30, S11 AS-31, S11 AS-33, S11 AS-34] [code: packages/backend/libs/domains/orders/domain/flash-claim-state.ts#claimTransition]
- **S11.R-15** A failed release leaves the reservation `RELEASE_PENDING` and is retried; no unit is lost. [proof: S11 AS-32] [code: packages/backend/libs/domains/orders/application/reservation-release.service.ts#ReservationReleaseService]
- **S11.R-16** A claim abandoned by a crash is returned with its quota after its window; a claim with a durable order is committed instead; with less than 20 s of the 60 s window left the checkout releases the claim and answers `503 checkout_unavailable`. [proof: S11 AS-35, S11 AS-36] [code: packages/backend/libs/domains/orders/application/flash-lifecycle.service.ts#FlashLifecycleService]
- **S11.R-17** The public view shows the state (`UPCOMING`, `LIVE`, `SOLD_OUT`, `ENDED`) and an approximate remaining count in `[0, units]`, no internals; cancelled, failed and far-future sales are `404`; reads are cached for about a second and degrade to `remainingApprox: null, degraded: true` when the store fails. [proof: S11 AS-38, S11 AS-39, S11 AS-40, S11 AS-41] [code: packages/backend/libs/domains/orders/application/flash-public.service.ts#FlashPublicService]
- **S11.R-18** Counters, a gauge, structured log lines carrying `requestId` and `saleId` (never an e-mail or a token) and spans cover admission, reserve, release and each job. [proof: S11 AS-42] [code: packages/backend/libs/domains/orders/domain/order-metrics.ts#flashReservationsCounter]
- **S11.R-19** Flash code reads and writes no table of another domain: products and stock only through the catalog's exported services, sums only over the domain's own tables. [proof: none] [code: packages/backend/libs/domains/orders/infra/flash-sale.repository.ts#SequelizeFlashSaleRepository]

## Behaviors
- **S11.B-01** Given a loaded drop of 30 units at 49,900 and a buyer with one unit in the cart, when the buyer checks out inside the window, then `202`, total 49,900, one `RESERVED` order, one `HELD` drop reservation and 29 units left in the buckets. [proof: S11 AS-01]
- **S11.B-02** Given a drop of 30 units and 100 buyers, when all check out at once, then exactly 30 get `202`, 70 get `422 out_of_stock` with the sale, and the buckets sum to 0, in every one of 50 repeated runs. [proof: S11 AS-02]
- **S11.B-03** Given a cart of one drop line and one regular line that is out of stock, when the buyer checks out, then `422` names the regular line, the order is `CANCELLED(out_of_stock)`, the drop unit is back once and the quota is free. [proof: S11 AS-09]
- **S11.B-04** Given an `ENDED` drop of 3,000 units with 2,400 sold, when reconciliation runs twice or on two instances, then 600 units return to regular stock once and the sale is `RECONCILED`. [proof: S11 AS-25]
- **S11.B-05** Given a restored snapshot that shows 90 units where 60 are possible, when verification runs, then the buckets are lowered to 60 and only 60 more orders are accepted. [proof: S11 AS-27]

## Lifecycles
`SCHEDULED → LOADED → ENDED → RECONCILED`; `SCHEDULED → START_FAILED`; `SCHEDULED | LOADED → CANCELLED` before the start. A claim goes `CLAIMED → COMMITTED → SOLD` or `→ RETURNING → RETURNED`.

## Owns
Tables `FlashSale` and `FlashSaleHistory`; the flash indexes and checks on `StockReservation`; the Redis key space `flash:`; job types `flash-sale.*`; events `flashsale.*`; policies `orders.flash-reserve.user` and `orders.flash-sale-read.ip`; config keys `orders_flash_*`. [code: packages/backend/libs/domains/orders/rate-limit-policies.ts#ordersRatePolicies]

## Decisions
- Units live in buckets spread over cluster slots, with the draws recorded next to the bucket, so release is exact and no single counter serialises the crowd.
- A claim is a sequence of idempotent single-key steps (open, quota, draw, commit), so a crash at any point is repaired by the sweeper from the claim record.
- The event types are `flashsale.*`: the platform's event-type pattern allows no `_` in the first segment.
- The durable records win over the fast store at every comparison; the store is only ever lowered during a sale.

## Known gaps
- The k6 load test of the 150 ms and 50 ms budgets, the real start of both applications and the fresh-stack drill are ops artifacts (specs/UNVERIFIED.md), not automated proofs.
- The per-buyer attempt allowance (30 per minute) is behind the route's own `checkout.create` limit (10 per minute), so it is proven by using the allowance up directly.
- Dropping a finished sale's keys scans for the claim records of the sale; on a Redis cluster the scan would have to visit every node.
