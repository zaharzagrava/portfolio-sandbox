# Gaps: S11 — current `orders` flash-sale code versus the spec

The implementation agent's to-do list. Paths are under `packages/backend/libs/domains/orders/` unless stated; line numbers are those read on 2026-10-05. Section C was produced with `pnpm --dir packages/backend check:table-ownership` (run on 2026-10-05: 87 findings in 21 domains; `orders` has 12, of which 4 are in flash-sale code or shared with it). Questions behind each row are in [`questions.md`](questions.md); scenario IDs refer to [`spec.md`](spec.md). S10's `gaps.md` already moves the checkout and cancel branches (A38 there) behind `ReservationSource`; this file covers what S11 must build behind that seam.

## A. Code versus spec

| # | Gap | Where | Spec |
|---|---|---|---|
| A1 | Selling starts at load time (`startsAt − 60 s`): the active marker is written by the load job and lives until `endsAt`; the window `[startsAt, endsAt)` is never checked against the clock | `infra/flash-stock.service.ts:52-57`, `infra/order.jobs.ts:44-64` | FR-006, AS-08 |
| A2 | Load overwrites every bucket with `SET`: a redelivered or retried `flash-sale.start` job refills sold units (oversell); load, stock decrement and status change are not one safe sequence (decrement committed, then Redis, then status) | `infra/flash-stock.service.ts:54-56`, `infra/order.jobs.ts:49-64` | FR-010, FR-012, AS-21 |
| A3 | A missing bucket reads as `-1` (fine) but nothing prevents a later load from recreating it; no "never recreate during a sale" rule | `infra/flash-stock.service.ts:7-11,52-58` | FR-012, AS-27 |
| A4 | Release is a bare `INCRBY` on the recorded bucket: repeated cancel, expiry or retry creates stock from nothing; quota release is a bare `DECRBY` that can go negative; no claim state, no "not held" answer | `infra/flash-stock.service.ts:83-85,92-94`, `application/order.service.ts:108-113` | FR-023, AS-31, AS-33, AS-34 |
| A5 | Reservation takes from one bucket and falls through only to buckets that hold the whole quantity: `q = 2` fails with 1+1 left; a partially taken draw is not possible and not recorded; the start bucket uses `Math.random()` inside the service (non-deterministic, untestable) | `infra/flash-stock.service.ts:73-81` | FR-020, AS-03, AS-44 |
| A6 | No claim record or claim window: units taken before the order write are lost if the process dies; compensation is best effort (`.catch(() => undefined)`); no sweeper; the order write has no margin check | `application/checkout.service.ts:96-135,208-213`, `infra/flash-stock.service.ts:73-95` | FR-021, FR-024, AS-35, AS-36 |
| A7 | No admission control: every checkout of a drop product reaches the cart, the catalog read and the stock call; no per-sale rate, no `429 flash_sale_busy`, no per-buyer attempt policy | `application/checkout.service.ts:80-136`, `api/orders.controller.ts:36-42` | FR-016–FR-018, AS-10–AS-12 |
| A8 | Redis errors in `activeFor`, `claimUserQuota`, `reserve` are not handled: the buyer gets `500`; nothing documents fail-closed; no call timeout | `application/checkout.service.ts:93,103,106`, `infra/flash-stock.service.ts:61-66,73-95` | FR-014, FR-019, AS-13 |
| A9 | Active sale lookup is a JSON marker per product with `JSON.parse` of unvalidated content and a TTL that ends at `endsAt` (not the window rule); no schema validation of the marker | `infra/flash-stock.service.ts:57,61-66` | FR-006, FR-032 |
| A10 | Quota breach answers a free-text `422` (`Limit of N per customer`); sold out answers `out_of_stock` without the sale; neither has a stable `code` | `application/checkout.service.ts:26-30,104` | FR-022, AS-02, AS-07 |
| A11 | Flash line price is taken from the Redis marker (`sale.price`) and discount functions are skipped by a `!l.flash` filter inside checkout; the seam must return `unitPriceMinor` and S10 must not discount flash lines | `application/checkout.service.ts:111,117-122` | FR-021, AS-04 |
| A12 | Sale creation: controller holds queries and schedules jobs in two separate non-transactional calls (a crash leaves a sale without jobs); no lead time, duration, price, stock or overlap checks; unknown product answers `400`; the response is the ORM row; `price` is not `priceMinor`; no `Location`; no contracts schema | `api/orders.controller.ts:64-76`, `api/orders.dto.ts:13-48`, `infra/models/flash-sale.model.ts:15-17` | FR-001–FR-004, AS-14–AS-17 |
| A13 | No list, read, cancel routes for sellers; no public view or batch route; no `statusReason`; no sale history | whole domain (absent) | FR-005, FR-007–FR-009, FR-032, AS-18, AS-19, AS-38, AS-39 |
| A14 | Status set `SCHEDULED/LIVE/ENDED/RECONCILED` (check constraint in the migration and the model type); a failed load throws `NonRetryableJobError` and leaves the sale `SCHEDULED` forever; no `CANCELLED` or `START_FAILED`; transitions are `findByPk` then `update` (not conditional updates with history) | `infra/models/flash-sale.model.ts:5`, `migrations/20261001150000-checkout-orders-inventory.js:75`, `infra/order.jobs.ts:44-74` | FR-006, FR-007, FR-013, AS-22, AS-23 |
| A15 | No guard that two sales of one product do not overlap (only a non-unique index on `(productId, startsAt)`) | `migrations/20261001150000-checkout-orders-inventory.js:80` | FR-003, AS-17 |
| A16 | `flash-sale.end` only handles `LIVE`; an end on a never-loaded sale does nothing; the reconcile job is scheduled with `runAt = now + hold + 60 s` computed from the job's own clock, not `endsAt`-based, and without a lease | `infra/order.jobs.ts:67-75` | FR-027, AS-23 |
| A17 | Reconciliation: unsold units go back with raw SQL on `Product`; a generic `Error` when holds remain (no alert counter, no scheduled backoff); no drift event; the Redis keys of the sale are never removed after reconcile; the returned amount is correct (DB wins) but not idempotent per operation | `infra/order.jobs.ts:84-113` | FR-027, FR-028, FR-030, AS-24–AS-26 |
| A18 | No periodic verification during the sale: phantom stock after a Redis restore or failover is only noticed after the end, if at all; no oversell remediation, no counter, no event | `infra/order.jobs.ts:84-114` (post-sale only) | FR-026, AS-27, AS-28 |
| A19 | Events are not published for the sale lifecycle (no outbox rows for load, end, reconcile, cancel, failure) | whole domain (absent) | FR-031, AS-37 |
| A20 | Metrics: only `flash_sale_stock_drift_units_total`; none for reservations, admission, claims, phantom stock, oversell, waiting reconciliation; no gauge for remaining stock | `infra/order.jobs.ts:82` | FR-034, AS-42 |
| A21 | `FlashStockService` mixes domain rules (bucket split, draw plan, quota) with Redis calls; `allocateEvenly` comes from `common/money` and is mocked in its unit spec; no pure functions for draw plan, window, state machine, admission allowance, drift classification | `infra/flash-stock.service.ts` (whole), `infra/flash-stock.service.spec.ts:7-9` | AS-44–AS-46, I.2, I.3 |
| A22 | `infra/flash-stock.service.spec.ts` unit-tests glue against a mocked Redis client (forbidden by VII.2/VII.5); the two flash tests in `checkout.e2e-spec.ts` call `FlashStockService.load/remaining` directly and read the product through the model | `infra/flash-stock.service.spec.ts` (all), `checkout.e2e-spec.ts:24,33,47,80-105` | VII.2, VII.5, VII.8, `test-plan.md` |
| A23 | Layering: the flash service, jobs and the controller reach `infra/` and ORM models from `api/`/`application/`; jobs hold SQL and Sequelize models; jobs live in `infra/order.jobs.ts` together with S10's expiry job | `api/orders.controller.ts:8-9,31-32`, `infra/order.jobs.ts:2-12,24-30` | I.2 (D-6), FR-036 |
| A24 | Barrel and module export flash internals: `FlashSaleModel`, `FlashStockService` | `index.ts:12,20`, `orders.module.ts:7,26,31-32`, `orders-worker.module.ts:6,15-16` | FR-036, X.4 (D-8, D-7) |
| A25 | Fast-store keys have TTLs derived from `endsAt + 1 h`, no jitter; quota key TTL fixed at 7 days; keys are not cleaned after reconciliation | `infra/flash-stock.service.ts:54,88` | FR-015 |
| A26 | Fast-store calls have no explicit timeout and no deliberate retry policy (IV.6) | `infra/flash-stock.service.ts:52-100` | FR-014 |
| A27 | k6 script creates the sale through the old route and reads counts from `BisOrderItem.flashSaleId`; thresholds exist, "oversell count == 0" is a manual SQL after the run | `scripts/load-tests/flash-sale.test.js:1-40` | SC-001, SC-002 |
| A28 | `StockReservation` has `source IN ('POSTGRES','FLASH')`, a `bucket` column and `status IN ('HELD','CONVERTED','RELEASED')`; the spec needs `sourceRef` (claim ID), statuses `REQUESTED/HELD/CONVERTED/RELEASE_PENDING/RELEASED` (S10 owns the status change) and a lookup by claim and by sale | `infra/models/stock-reservation.model.ts:19-29`, `migrations/20261001150000-checkout-orders-inventory.js:55-63` | FR-021, FR-024, FR-026; S10 A6 |

## B. Open debt-register rows naming `orders` or S11

`docs/architecture/debt-register.md` has no row that names S11. These open rows name `orders`; for each, which part is S11's and the IX.7 mechanism that replaces it:

| Debt | What | S11's share | Mechanism |
|---|---|---|---|
| D-6 (I.2) | `api/` and `application/` import `infra/` directly | The flash route injects `FlashSale` and `Product` models (`api/orders.controller.ts:8-9,31-32`); the flash service is injected by class, not by a port token; jobs hold models and SQL | Repository and fast-store **ports in `domain/`** with adapters in `infra/`; one application service per use case (`FlashSaleService`, `FlashReservationSource`, `FlashLifecycleService`); jobs call application services only |
| D-7 (IX.4) | Other domains import `*Model` exports | `FlashSaleModel` is exported from the barrel (`index.ts:12`); nobody outside `orders` should use it; `orders` imports `ProductModel` for the flash route (`api/orders.controller.ts:9,32`) | Drop the export (no consumer exists; verify with the ownership check after S10, S13, S16, S21, S31, S42 finish); the product check becomes **R1** `ProductQueryService.getProductsByIds(ids, {shopId})` |
| D-8 (X.4) | Barrels export infrastructure internals | `FlashStockService` exported (`index.ts:20`, `orders.module.ts:32`, `orders-worker.module.ts:16`) | Remove; apps import `OrdersModule` / `OrdersWorkerModule` only |
| D-10 | Order export routes and queue name in catalog-sync | Not S11 (S12) | — |
| D-11 (X.5) | orders ↔ payments model references | Not S11 (S10, S13, S14); flash code has no payments reference | — |
| D-12 (IX.4) | Raw SQL on tables owned by another domain | Two flash-code findings: raw `UPDATE "Product"` in `infra/order.jobs.ts:50` (load) and `:106` (return); the same raw `Product` writes in `checkout.service.ts:149` and `order.service.ts:97` are S10's | **R1** `ProductStockService.applyStockDelta` with operation IDs `orders:flash:<saleId>:load` and `orders:flash:<saleId>:return` |
| D-15 (X.5) | catalog → discovery closes a cycle with orders in the component | Not S11 (S05 / S32) | — |
| D-17 (X.5) | File-level cycles inside one lib | Not S11 (S10, S13, S14) | — |

## C. `check:table-ownership` lines for `orders` (run on 2026-10-05)

| Finding | File | Owner of the table | S11? | Replacement |
|---|---|---|---|---|
| SQL `Product` | `application/checkout.service.ts` | catalog | S10 (regular stock) and the flash branch lines 93-125 move behind the seam | **R1** `applyStockDelta`; the flash branch becomes `FlashReservationSource` |
| SQL `Product` | `application/order-export.service.ts` | catalog | S12 | **R1** `getProductsByIds` |
| SQL `Product` | `application/order.service.ts` | catalog | S10 (cancel release at `:97`); flash release at `:108-113` is S11's via `release(reservation)` | **R1** `applyStockDelta`; flash release through the source |
| SQL `Product` | `infra/order.jobs.ts` | catalog | **S11** (`:50` load, `:106` return) | **R1** `applyStockDelta` with `orders:flash:<saleId>:load` / `:return` |
| MODEL `ProductModel` | `api/orders.controller.ts` | catalog | **S11** (flash route product check, `:9,32,68`) | **R1** `getProductsByIds(ids, {shopId})`; the route moves to a flash-sale controller calling one application service |
| MODEL `ProductModel` | `application/checkout.service.ts` | catalog | S10 | **R1** `getProductsByIds` |
| MODEL `ProductModel` | `infra/models/bis-order-item.model.ts` | catalog | S10 | Drop the association |
| MODEL `ProductModel` | `orders.module.ts` | catalog | S10 (registration at `:8,26`, shared with `ORDER_MODELS`) | Remove `Product` from `ORDER_MODELS` and `forFeature` |
| MODEL `UserModel` | `infra/models/bis-order.model.ts` | identity | S10 | Plain user ID, drop the association |
| MODEL `PaymentModel` | `api/stripe-webhook.controller.ts` | payments | S10 | S13's `getPaymentStatus` (R1) |
| MODEL `PaymentModel` | `infra/models/bis-order.model.ts` | payments | S10 | Drop the association |
| MODEL `PaymentModel` | `orders.module.ts` | payments | S10 | Remove from `ORDER_MODELS` and `forFeature` |

After S11: no flash-sale file has a finding; `pnpm --dir packages/backend check:table-ownership --strict` reports 0 for the flash files (SC-009).

## D. Suggested order of work

1. Pure domain first (AS-44–AS-46, tests first): bucket split and draw plan, sale state machine and window, admission allowance, drift classification; fast-store and repository **ports** in `domain/`.
2. Data: migration (expand/contract) — statuses, `statusReason`, `FlashSale` history table, exclusion constraint for overlaps, `sourceRef` on `StockReservation`, ownership registry entries; contracts schemas in `packages/contracts`.
3. Scheduling and lifecycle: create, list, read, cancel (AS-14–AS-19); jobs `flash-sale.load`, `.end`, `.reconcile` with `applyStockDelta` (AS-20–AS-26); events through the outbox (AS-37).
4. Fast-store adapter: idempotent load (create-if-absent), claims with per-bucket draws, idempotent release and convert, quota, admission allowance, sweeper, timeouts and TTL jitter (AS-01–AS-13, AS-30–AS-36).
5. Seam integration with S10 (mode `BEFORE_ORDER`, `sourceRef`, `commit`, discount exclusion, error codes) — coordinate in the same change as S10's `ReservationSource`.
6. Verification and remediation (AS-27–AS-29), metrics and alerts (AS-42).
7. Public view and batch route with the shared cache (AS-38–AS-41).
8. Remove the old route behaviour, `FlashStockService` unit spec, the flash tests in `checkout.e2e-spec.ts`, barrel and module exports; update `scripts/load-tests/flash-sale.test.js` to the new route and to assert zero oversell automatically; run `check:table-ownership --strict` and `check:boundaries`.
