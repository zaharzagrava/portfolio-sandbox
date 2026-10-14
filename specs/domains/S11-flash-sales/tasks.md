# Tasks: S11 — Flash Sales (domain `orders`)

**Input**: `specs/domains/S11-flash-sales/` — spec.md, plan.md, research.md, data-model.md, contracts/{http,services,events}.md, test-plan.md, gaps.md, questions.md (defaults accepted), quickstart.md. Constitution v3.1.0.

**Tests**: required (test-plan.md has one row per AS-01…AS-46). Inside every phase the failing test task comes before the code task that makes it pass.

**Paths**: `ORD` = `packages/backend/libs/domains/orders`; `CON` = `packages/contracts/src`. Backend commands run from `packages/backend`. E2E: `/opt/sdd/repo/scripts/sdd/test-spec.sh <path>`; unit: `pnpm jest <path>`. 5 failed fixes on one test → stop, write the blocker in `questions.md`.

**Rules that apply to every task**: no new direct `sequelize.transaction` (use `TransactionRunner.run`; `grep -c "sequelize.transaction"` over `ORD` must not rise); stock only through `ProductStockService.applyStockDelta` / `ProductQueryService.getProductsByIds`; no spec injects `ProductModel`/`PaymentModel`/`UserModel`/`ShopModel`; no "A or B" assertions (L-003); tests create their own products/sales (`createIsolatedProduct`, L-005/L-006); never edit `*.reviewed.json`; never use git checkout/restore/reset/stash/clean.

## Phase 1: Setup

- [X] T001 Run S10 baseline first (plan WP-7 step 0): `test-spec.sh libs/domains/orders/` in batches of fresh processes (L-008); record any pre-existing red in `specs/domains/S11-flash-sales/questions.md` before editing anything
- [X] T002 Living spec first (rule 0): create `docs/spec/capabilities/S11-flash-sales.md` (rules/behaviors with `[proof: S11 AS-nn]` / `[code: …]`, `scope` globs for the new files); edit `docs/spec/capabilities/S10-cart-checkout.md` replacing the "legacy flash-sale route" bullet and the legacy-jobs sentence (~line 132) with a pointer to S11; run `python3 scripts/livespec/check.py`; confirm no `*.reviewed.json` exists for these pages (else list under "## Spec changes" in gaps.md)
- [X] T003 [P] Confirm by grep (no edit if absent) that `ORD/infra/models/bis-order-item.model.ts` has no `ProductModel` / `BelongsTo(Product)` (S05 follow-up) and that flash files hold no `// S54 T037 audit` comment; note result in the final report
- [X] T004 [P] Confirm `btree_gist` exists (`20261001320000-experiments.js`) and Redis accepts `flash:` keys on the test stack (L-011); compare with the doctor

---

## Phase 2: Foundational (blocks every story)

**⚠️ No story starts before this phase is green.**

### Pure domain (gaps A21, A5, A14, A9, D-6)

- [X] T005 [P] Write failing `ORD/domain/flash-bucket-plan.spec.ts` (AS-44): `it.each` tables + `fast-check` — `splitUnits` sum = units, parts differ ≤ 1, larger first; `planDraw` all-or-nothing, never negative or above available, start bucket changes order only
- [X] T006 [P] Write failing `ORD/domain/flash-sale-state.spec.ts` (AS-45): every (status, command) pair of the data-model §5 diagram, `end` on `SCHEDULED` → `fail(window_missed)`, instants `startsAt − 1 ms`, `startsAt`, `endsAt − 1 ms`, `endsAt` for `isOpen` (window `[startsAt, endsAt)`), `publicState`
- [X] T007 [P] Write failing `ORD/domain/flash-admission.spec.ts` (AS-46): allowance bounds and linear refill with `fast-check`, `retryAfterSeconds` always in 1..3
- [X] T008 [P] Write failing `ORD/domain/flash-drift.spec.ts` (AS-46): `none`, `redis_low`, `redis_high`, `phantom_stock`, `oversold`, `clampPlan` lowers never raises
- [X] T009 [P] Write failing `ORD/domain/flash-claim-state.spec.ts`: `CLAIMED→COMMITTED→SOLD`, `CLAIMED|COMMITTED→RETURNING→RETURNED`, release of `SOLD` → `not_held`, convert of `RETURNING|RETURNED` → `not_held`, repeats are idempotent no-ops, `ReleaseMode` `return|discard`
- [X] T010 [P] Implement `ORD/domain/flash-bucket-plan.ts` (`splitUnits`, `planDraw`) so T005 passes; no Nest, no I/O, no `common/money` `allocateEvenly`
- [X] T011 [P] Implement `ORD/domain/flash-sale-state.ts` (`FlashSaleStatus` = SCHEDULED, LOADED, ENDED, RECONCILED, CANCELLED, START_FAILED; `FlashCommand`, `transition`, `isOpen`, `publicState`, `StatusReason` = insufficient_stock, window_missed, cancelled_by_shop, product_unavailable) so T006 passes
- [X] T012 [P] Implement `ORD/domain/flash-admission.ts` so T007 passes
- [X] T013 [P] Implement `ORD/domain/flash-drift.ts` so T008 passes
- [X] T014 [P] Implement `ORD/domain/flash-claim-state.ts` so T009 passes
- [X] T015 [P] Create `ORD/domain/flash-errors.ts`: `FlashSaleBusyError` 429 `flash_sale_busy`, `FlashSaleUnavailableError` 503 `flash_sale_unavailable` (`Retry-After: 2`), `FlashSaleLimitExceededError` 422 `flash_sale_limit_exceeded` (`limit`), `FlashSaleNotFoundError` 404 `flash_sale_not_found`, `FlashSaleOverlapError` 409 `flash_sale_overlap`, `FlashSaleNotCancellableError` 409 `flash_sale_not_cancellable`; each with stable `code`, `retryAfterSeconds` where the spec says
- [X] T016 Create `ORD/domain/flash-ports.ts` with tokens `FLASH_SALE_REPOSITORY`, `FLASH_FAST_STORE`, `FLASH_SALE_DIRECTORY`, `FLASH_RESERVATION` and the interfaces exactly as in `contracts/services.md` (`FlashSaleRepository`, `FlashFastStore`, `FlashSaleDirectory`, `FlashReservationPort`, `FlashReserveResult`)
- [X] T017 Run `pnpm jest libs/domains/orders/domain/flash-` — all five specs green

### Contracts, config, policies (R-10, R-12)

- [X] T018 [P] Write failing contracts unit test `CON/orders/flash-sale.spec.ts`: strict `flashSaleCreateRequestSchema` (unknown key → reject; defaults `buckets` 16, `perUserLimit` 2, `admissionRatePerSecond` 2000; ranges from contracts/http.md), member and page schemas, `flashSalePublicSchema` strict (no `units`, buckets, rate, `shopId`) parsing the AS-38 body, event payload schemas of `contracts/events.md`
- [X] T019 Create `CON/orders/flash-sale.ts` and `CON/orders/flash-sale-events.ts` (`flashSaleCreateRequestSchema`, `flashSaleMemberSchema`, `flashSalePageSchema`, `flashSalePublicSchema`, `flashSalesResponseSchema` stays the array, `flashSaleEventSchemas`) and export from `packages/contracts` index
- [X] T020 Replace the loose flash-sale public schema in `CON/bff/upstream.ts` by a re-export of `flashSalePublicSchema` from `../orders/flash-sale` under the same exported name (S30/S48 follow-up); keep the BFF product-page spec green with a real view (`UPSTREAM_INVALID` absent)
- [X] T021 Add the 11 config keys with defaults in `libs/common/config` (`orders_flash_load_lead_seconds` 60, `_min_lead_seconds` 120, `_max_window_seconds` 86400, `_claim_window_seconds` 60, `_order_margin_seconds` 20, `_verify_interval_seconds` 30, `_sweep_interval_seconds` 10, `_call_timeout_ms` 100, `_public_cache_ms` 1000, `_reconcile_wait_alert_seconds` 600, `_key_ttl_jitter` 0.1) and start-up validation: `margin < claim window`, `load lead < min lead`, `call timeout ≤ 1000`; add a failing-then-passing config spec next to the existing ones
- [X] T022 [P] Add policies `orders.flash-reserve.user` (30 / 60 s per `<userId>:<saleId>`, fail closed) and `orders.flash-sale-read.ip` (600 / 60 s per address, fail open) to `ORD/rate-limit-policies.ts` (`ordersRatePolicies`)

### Data (gaps A12–A15, A28)

- [X] T023 Write `migrations/<ts>-flash-sales-expand.js` per data-model §1: add `priceMinor` (bigint NOT NULL CHECK `> 0`, copied from `price`), `admissionRatePerSecond` (int NOT NULL default 2000 CHECK `1..10000`), `currency` (text NOT NULL, 3 letters; one-off data fix from `Product`, flagged with the ownership-check allow-comment), `statusReason` (CHECK in `insufficient_stock, window_missed, cancelled_by_shop, product_unavailable` or NULL), `version` int NOT NULL default 0, `endedAt`, `reconciledAt`; status CHECK allows old and new sets, `LIVE` rows rewritten to `LOADED`; legacy `NULL`-shop `SCHEDULED` rows → `CANCELLED(cancelled_by_shop)`; overlapping legacy rows cancelled first; `FlashSale_no_overlap` EXCLUDE gist `("productId" WITH =, tstzrange("startsAt","endsAt",'[)') WITH &&) WHERE status IN ('SCHEDULED','LOADED','ENDED')`; `FlashSale_shop_page_idx ("shopId","startsAt" DESC,"id" DESC)`; partial `FlashSale_loaded_idx ("endsAt") WHERE status='LOADED'`; CHECKs `units 1..1_000_000`, `buckets 1..256` default 16, `perUserLimit 1..20 AND <= units` default 2, `endsAt > startsAt AND endsAt - startsAt <= interval '24 hours'`; table `FlashSaleHistory` (`id uuid PK uuidv7()`, `saleId uuid NOT NULL`, `fromStatus text NULL`, `toStatus text NOT NULL`, `reason text NULL`, `actor text NOT NULL`, `at timestamptz NOT NULL`, index `("saleId","at")`); on `StockReservation`: `StockReservation_flash_sale_idx` partial `("flashSaleId","status") WHERE source='FLASH'`, unique `StockReservation_flash_claim_uq ("sourceRef") WHERE source='FLASH'`, CHECK `source <> 'FLASH' OR (flashSaleId IS NOT NULL AND sourceRef IS NOT NULL)`. Include `down`
- [X] T024 Write `migrations/<ts>-flash-sales-contract.js`: drop `price`, tighten status CHECK to the new set only, `shopId NOT NULL`; `down` recreates `price` from `priceMinor`. **Run `down` only on a throwaway database** (migrate:down hazard)
- [X] T025 Create `ORD/infra/models/flash-sale.model.ts` (move from `infra/flash/`, new columns, no association to Product/Shop) and `ORD/infra/models/flash-sale-history.model.ts`; register both in `ORD/orders-models.ts` and the table-ownership registry (`FlashSale`, `FlashSaleHistory` → `orders`); extend the `StockReservation` model with `sourceRef`, `flashSaleId` and statuses `REQUESTED/HELD/CONVERTED/RELEASE_PENDING/RELEASED` as S10 owns them (coordinate, do not rename S10 states)
- [X] T026 (up applied on an empty database; the legacy-seeded run and `down` are deferred to the final checkpoint: `specs/deferred-checks.md`) Apply `migrate:up` on an empty database and on one seeded with legacy `FlashSale` rows (LIVE row, NULL shop, overlapping pair); confirm the expand result and the `flash-sale.start` jobs count query from data-model

### Repository, fast store, directory (A2–A5, A8, A9, A25, A26)

- [X] T027 Create `ORD/infra/flash-sale.repository.ts` implementing `FlashSaleRepository`: `create` maps SQLSTATE `23P01` to `FlashSaleOverlapError`; `findForShop(shopId, saleId)` with shop in the predicate (III.4); keyset `pageForShop` `(startsAt DESC, id DESC)` `limit ≤ 100`; `move` = conditional `UPDATE … WHERE status = :from`, `version + 1` and a `FlashSaleHistory` row in the caller's transaction via `TransactionRunner`; `reservationSums`, `newestUnpaidOrdersBeyond`, `reservationByClaim`, `loadedAndLive`, `currentOrNextForProducts`; zod-validate rows read for the directory (A9)
- [X] T028 Create `ORD/infra/flash-scripts.ts`: cluster-safe Lua per key family of data-model §2 (hash tags `flash:{<saleId>:<b>}:stock|draws`, `…:claim:<id>`, `…:quota:<buyer>`, `…:adm`, `…:claims`, `…:buyers`); no script touches two families; fill = `SET NX` (never overwrites); claim = quota + draws + claim record, gives back on shortage; commit/release(`return|discard`)/convert idempotent and resumable; clamp lowers only; sold-out marker `SET NX`
- [X] T029 Create `ORD/infra/flash-fast-store.redis.ts` implementing `FlashFastStore`: every call under `withTimeout(…, orders_flash_call_timeout_ms)`, timeout/connection error → `FlashSaleUnavailableError`, no retry inside a buyer request, key TTL `(endsAt − now) + 15 min + 1 h` × jitter `1 ± orders_flash_key_ttl_jitter`
- [X] T030 Create `ORD/infra/flash-sale.directory.ts` implementing `FlashSaleDirectory` with S52 `CacheService.getOrLoad` (jitter, single-flight, SWR, 2 s TTL); **no local promise-coalescing map**; window evaluated with the injected `now`; test-kit `refresh()` seam
- [X] T031 Create `ORD/flash-sale.module.ts` (`FlashSaleModule`: providers bound to the port tokens, imported by `OrdersModule`) and `ORD/flash-sale-worker.module.ts` (imported by `OrdersWorkerModule`); `FlashSaleModule` must not export `FlashReservationPort`; add the e2e test-kit helpers (frozen clock, seeded random for bucket start/`Retry-After`, `CrashPoint` double, Redis command counter, store-refuse rule via ACL) under `ORD/testing/`
- [X] T032 Declare job types with payload contracts in `ORD/application/order.job-types.ts` (next to the `JobPayloads` augmentation): `flash-sale.load|end|reconcile` `{saleId: uuid}`, `flash-sale.verify|sweep-claims` `{}`, `flash-sale.start` alias (S49 follow-up)

**Checkpoint**: unit specs green, `tsc --noEmit` clean, migrations applied, `apps/core` module graph compiles.

---

## Phase 3: User Story 3 — Seller schedules, inspects, cancels a drop (P1) — built first because every other story needs a sale

**Goal**: AS-14–AS-19. **Independent test**: `flash-sale-schedule.e2e-spec.ts`.

- [X] T033 [US3] Write failing `ORD/flash-sale-schedule.e2e-spec.ts` (describe "Flash sales: scheduling, authorization, listing and cancel"): AS-14 (`201`, `Location`, `SCHEDULED`, row, two jobs, stock unchanged, no fast-store keys, shop from path); AS-15 `it.each` over each `400` class and `422 insufficient_stock | drop_price_above_regular | product_unavailable`, nothing created; AS-16 (`401`, `403`, other shop `404`, foreign product `404 product_not_found`, suspended shop `403`, no row); AS-17 (overlap `409`, adjacent accepted, `Promise.all` of two creates → one `201` one `409`); AS-18 (45 sales paged by cursor, no duplicates/gaps, bad cursor and `limit > 100` → `400`, member view with `stats`, foreign sale `404`); AS-19 (cancel `SCHEDULED`, repeat `200`, loaded-before-start returns units, started/ended → `409 flash_sale_not_cancellable`, foreign `404`); parse responses with the contracts schemas
- [X] T034 [US3] Create `ORD/application/flash-sale.service.ts` (`create`, `list`, `get`, `cancel`): product check through `ProductQueryService.getProductsByIds([id], {shopId})` outside the transaction (unknown → `404 product_not_found`; archived/sandbox/non-active shop → `422 product_unavailable`; `units > quantity` → `422 insufficient_stock`; `priceMinor > product price` → `422 drop_price_above_regular`); lead/length checks with injected clock and config; sale + history + `load`(`runAt = startsAt − 60 s`, 8 attempts) + `end`(`runAt = endsAt`, 5 attempts) jobs in one `TransactionRunner.run`; `cancel` cancels the jobs with `JobsService.cancel` handling its discriminated result (not-found / already-running / ok all fine); cancel of a `LOADED` sale runs the early reconcile (units back via `orders:flash:<id>:return`)
- [X] T035 [US3] Create `ORD/api/flash-sale.controller.ts` + `ORD/api/flash-sale.dto.ts` (re-exports contracts): the four seller routes of contracts/http.md with `ShopScoped('products.write'|'products.read')`, zod pipe, `Location` header, one application call per handler; remove the old `POST /shops/:shopId/flash-sales` handler and its `ProductModel` use from `ORD/api/orders.controller.ts`
- [X] T036 [US3] Register the schedule registration for the periodic jobs elsewhere (T049); here make `FlashSaleService` catch `InvalidScheduleError` and log `error` with the job name; run `test-spec.sh libs/domains/orders/flash-sale-schedule.e2e-spec.ts` green

---

## Phase 4: User Story 4 — Units move to fast store at launch, leftovers come back exactly once (P1)

**Goal**: AS-20–AS-29, AS-37. **Independent test**: `flash-sale-lifecycle.e2e-spec.ts`.

- [X] T037 [US4] Write failing `ORD/flash-sale-lifecycle.e2e-spec.ts` (describe "Flash sales: load, end, reconcile and never oversell"): AS-20 (stock 2000, operation `orders:flash:<id>:load`, 16 buckets 188/187, `LOADED`, one `flash_sale.loaded` outbox row); AS-21 (redelivery and concurrent delivery after 5 sold → stock lowered once, buckets 2995; crash after stock command and after buckets, retry equals clean run); AS-22 (`START_FAILED(insufficient_stock)` no retry; archived product → `START_FAILED(product_unavailable)`; store down → backoff ≤ 8 attempts; `window_missed` and reversal via the return operation); AS-23 (end twice → one `ENDED` and one reconcile job; end on `SCHEDULED` → `START_FAILED(window_missed)`; late load after end no-op; malformed/unknown `saleId` payload → rejected without side effects, `NonRetryableJobError`); AS-24 (3 `HELD` → no return, retry within 60 s, `flash_sale_reconcile_waiting` counted; completes after resolution); AS-25 (reconcile twice and on two instances at once → one `+600` operation `orders:flash:<id>:return`, `RECONCILED`, keys removed, one event, stock `original − 2400`; `unsold = 0` makes no command; reconcile `runAt ≤ endsAt + 20 min` for SC-005); AS-26 (Redis shows 590 and 640 → still `+600`, drift counter by direction, warning log); AS-27 (restore old snapshot: 90 remaining, 60 possible → verification lowers, next 70 checkouts → 60 orders, never raised); AS-28 (104 vs 100 → selling stops, 4 newest unpaid orders `CANCELLED(out_of_stock)` with `discard` release, counter +4, `flash_sale.oversold`; paid excess reported only); AS-29 (two worker instances, verify and sweeper once per schedule); AS-37 (each job twice → one outbox row per event with envelope parsed by the contracts schema; refused outbox append leaves status unchanged; `sold_out` once). Use the loop-proof SC-003 invariant `loaded = sold + returned + drift`
- [X] T038 [P] [US4] Create `ORD/application/events/flash-sale-events.ts` (`defineEvent` for the 7 events of contracts/events.md, topic `orders.events`, key `saleId`; register in the topic registry)
- [X] T039 [US4] Create `ORD/application/flash-lifecycle.service.ts`: `load` (stock first via `applyStockDelta` `orders:flash:<id>:load`, then `fillBuckets` create-if-absent, then `SCHEDULED→LOADED`; `insufficient_stock` → `START_FAILED(insufficient_stock)`, `unavailable` → `START_FAILED(product_unavailable)`, past `startsAt` → `window_missed` with reversal `…:return`), `end` (`LOADED→ENDED`, enqueue reconcile at `endsAt + 15 min + 60 s`; `SCHEDULED` → `fail(window_missed)`), `reconcile` (waits while holds exist and re-enqueues in 60 s with alert counter; returns `units − sold` once via `…:return`; classify drift, durable records win; `dropSale`; `RECONCILED` + event), `verify` (clamp phantom stock, `stopSelling` + oversell remediation: cancel newest unpaid beyond units with `discard`, count, `flash_sale.oversold`), `sweepClaims` (≤ 200 per run: durable row found → `commit`; not found → release; `RETURNING` resumed), `checkSoldOut` (own transaction after the response, marker deleted if append fails); every transition with history + outbox in one `TransactionRunner.run`; `CrashPoint` hooks between named steps
- [X] T040 [US4] Create `ORD/infra/flash-sale.jobs.ts`: handlers `flash-sale.load|end|reconcile|verify|sweep-claims` and alias `flash-sale.start`, thin (zod-parse payload, `NonRetryableJobError` on malformed/unknown sale, one lifecycle call); leases on every job (VIII.6); periodic schedules `*/30 s` verify and `*/10 s` sweep-claims, single-run (`fleetConcurrency: 1`), `InvalidScheduleError` caught and logged; register in `FlashSaleWorkerModule`
- [X] T041 [US4] Delete the old flash jobs from `ORD/infra/order.jobs.ts` (keep S10's expiry job) and the raw `Product` SQL (D-12)
- [X] T042 [US4] Run `test-spec.sh libs/domains/orders/flash-sale-lifecycle.e2e-spec.ts` green

---

## Phase 5: User Story 1 — Buyer gets a drop unit; never oversell (P1) 🎯 MVP with US2

**Goal**: AS-01–AS-09. **Independent test**: `flash-sale-checkout.e2e-spec.ts`.

- [X] T043 [US1] Write failing `ORD/flash-sale-checkout.e2e-spec.ts` part 1 (describe "Flash sales: reserving drop units, admission and fail-closed"): AS-01 (`202`, total `49900`, one `RESERVED` order, one `FLASH` `HELD` reservation, buckets 29, regular stock 5); AS-02 (`Promise.all(100)` for 30 units: 30 × `202`, 70 × `422 out_of_stock` with `flashSaleId`, buckets 0 none negative, 30 orders and reservations; repeat 50×; plus 200-for-50 variant for SC-001); AS-03 (buckets 1+1, q=2 succeeds with two recorded draws, cancel returns 1+1; buckets 1+0 → `422`, unit stays); AS-04 (total `99800`, snapshot `49900`, no discount, `expectedTotalMinor 199800` → `409 price_changed`); AS-05 (sequential and simultaneous replays: one claim, one order, buckets `units − 1`, quota 1); AS-06 (sold out: `422`, zero rows in order/item/reservation/history/outbox/job tables, cart intact, quota unchanged, no relational query via query counter); AS-07 (2 ok, 3rd `422 flash_sale_limit_exceeded {limit:2}`, cancel frees quota, line of 3 refused); AS-08 (frozen clock `T − 1 s`, `T`, `T + 10 min` with end job not run); AS-09 (mixed cart: `B` out of stock → `422 [B]`, drop unit returned once, quota restored, retry without `B` succeeds)
- [X] T044 [US1] Create `ORD/application/flash-reservation.source.ts` implementing `FlashReservationPort`: `openSales` (directory, no Redis), `reserve` (all-or-nothing, deterministic `claimId = uuidv5("<saleId>|<buyerId>|<Idempotency-Key>|<productId>", FLASH_NS)`, `unitPriceMinor` from the sale, give back on any refusal), `commit`, `release`, `releaseReservation`, `convertReservation`; bind to `FLASH_RESERVATION` in `FlashSaleModule`
- [X] T045 [US1] S10 edit 1 in `ORD/application/checkout.service.ts`: after the cart read call `openSales`; none → path unchanged; else `admit`, regular/drop catalog validation, `reserve`, order write in S10's transactions, `commit` after; remove the Redis-marker flash branch and the `!l.flash` discount filter (drop lines are not discounted); add problem classes in `ORD/domain/order-problems.ts` (`out_of_stock` with `flashSaleId`, `flash_sale_limit_exceeded`, `flash_sale_busy`, `flash_sale_unavailable`); drop refusals leave the idempotency key unused
- [X] T046 [US1] S10 edit 5 in `ORD/infra/reservation.repository.ts`: `forOrder` returns `source`, `sourceRef`, `flashSaleId`; `createPending` accepts `source`/`status` rows; add `sumsForSale`, `byClaim`, `newestUnpaidBeyond`
- [X] T047 [US1] S10 edit 2 in `ORD/application/order-reservation.service.ts`: `stockLines` reads only `REQUESTED` rows of source `CATALOG`; an order with no catalog lines goes `PENDING → RESERVED` without a source call
- [X] T048 [US1] Run `test-spec.sh libs/domains/orders/flash-sale-checkout.e2e-spec.ts` (AS-01…AS-09 rows) green, then the existing `checkout*.e2e-spec.ts` and `cart.e2e-spec.ts` still green

---

## Phase 6: User Story 2 — Admission holds back excess traffic, fails closed (P1)

**Goal**: AS-10–AS-13. **Independent test**: same checkout file, part 2.

- [X] T049 [US2] Extend `ORD/flash-sale-checkout.e2e-spec.ts` (failing first): AS-10 (rate 100, 300 at once → 100 admitted, 200 × `429 flash_sale_busy` with `Retry-After` 1–3, zero side effects); AS-11 (advance 1 s → 100 more; advance 10 ms → at most 1); AS-12 (31st attempt `429 rate_limited` with `Retry-After`, other buyer unaffected, no unit taken); AS-13 (store refusing commands on the stock side and the admission side → `503 flash_sale_unavailable`, `Retry-After: 2`, no order, regular stock unchanged, regular-only cart still works, recovery succeeds; SC-008 no unit sold from another source)
- [X] T050 [US2] Implement `admit` in `FlashReservationSource`: per-buyer attempt limit through S50 `RateLimiterService.check('orders.flash-reserve.user', '<userId>:<saleId>')` fail closed, then the per-sale admission script with the injected clock; rejection → `FlashSaleBusyError` with `retryAfterSeconds` from the pure function; Redis failure → `FlashSaleUnavailableError`; wire `ordersRatePolicies`
- [X] T051 [US2] Run the checkout file fully green (AS-01…AS-13)

---

## Phase 7: User Story 5 — Units come back or become permanent exactly when they should (P1)

**Goal**: AS-30–AS-36. **Independent test**: `flash-sale-claims.e2e-spec.ts`.

- [X] T052 [US5] Write failing `ORD/flash-sale-claims.e2e-spec.ts` (describe "Flash sales: release, convert and claim sweeping"): AS-30 (cancel and expiry return units to buckets 3 and 5, quota restored, another buyer buys them); AS-31 (cancel + expiry + retry, also simultaneously → buckets and quota change once, "already released"); AS-32 (store down → `RELEASE_PENDING`, no loss; back → `RELEASED` once); AS-33 (convert on payment → `CONVERTED`, units stay out, release refused "not held", repeat convert no-op); AS-34 (late payment after release → `not_held`, buckets and quota untouched); AS-35 (crash after claim, window passes, sweeper returns 2 units and quota, counter, no order); AS-36 (order committed, confirmation lost → sweeper keeps units; `< 20 s` left → claim released, `503 checkout_unavailable`). Payment confirmation driven via S10's own handler
- [X] T053 [US5] S10 edit 3 in `ORD/application/reservation-release.service.ts`: split `RELEASE_PENDING` rows by source; `FLASH` rows one by one through `releaseReservation` (`released|already_released|not_held` → `markReleased`; store down → `scheduleRetry` with the same backoff)
- [X] T054 [US5] S10 edit 4 in `ORD/application/order-lifecycle.service.ts` (convert, ~line 226): after the transaction that sets `PAID` and rows `HELD → CONVERTED`, call `convertReservation` per flash row post-commit outside the transaction; `not_held` logged and counted; S10's late-payment rule unchanged
- [X] T055 [US5] Add the 20 s order-write margin rule (`orders_flash_order_margin_seconds`) in `CheckoutService`/`FlashReservationSource`: less than the margin left of the claim window → `release` and `503 checkout_unavailable` (`Retry-After: 2`); order write latch available to tests
- [X] T056 [US5] Run `test-spec.sh libs/domains/orders/flash-sale-claims.e2e-spec.ts` green, then `order-lifecycle.e2e-spec.ts`, `payment-events.e2e-spec.ts`, `order-events.e2e-spec.ts` green

---

## Phase 8: User Story 6 — Public countdown and approximate remaining (P2)

**Goal**: AS-38–AS-41. **Independent test**: `flash-sale-public.e2e-spec.ts`.

- [X] T057 [US6] Write failing `ORD/flash-sale-public.e2e-spec.ts` (describe "Flash sales: public view and cache behaviour"): AS-38 (each state, exactly the public field set, `Cache-Control: public, s-maxage=1`, hidden sales `404`); AS-39 (batch with and without sales, one view per product, `> 100` / malformed / empty → `400`); AS-40 (1,000 concurrent reads → ≤ 1 bucket read per second via Redis command counter, 0 relational reads; store down → `200`, `remainingApprox: null`, `degraded: true`; SC-007); AS-41 (integer in `[0, units]`, never negative with a negative bucket, ≤ 2 s old, 0 and `SOLD_OUT` at last unit)
- [X] T058 [US6] Create `ORD/application/flash-public.service.ts` using `CacheService.getOrLoad` with `jitter` (no local coalescing map), degraded answer, `remainingApprox` clamped to `[0, units]`
- [X] T059 [US6] Create `ORD/api/flash-sale-public.controller.ts`: `GET /flash-sales/:saleId` and `GET /flash-sales?productIds=` with `@RateLimit('orders.flash-sale-read.ip')` (fail open), `Cache-Control: public, s-maxage=1`, strict contracts schemas, uuid/limit validation
- [X] T060 [US6] Run the public file green and the BFF product-page spec green (`UPSTREAM_INVALID` absent)

---

## Phase 9: User Story 7 — Observability and clean domain (P3)

**Goal**: AS-42, AS-43. 

- [X] T061 [US7] Write failing `ORD/flash-sale-observability.e2e-spec.ts` (describe "Flash sales: metrics and logs"): scrape `flash_sale_reservations_total{result}`, `flash_sale_admission_rejected_total`, `flash_sale_stock_remaining{saleId}`, `flash_sale_stock_drift_units_total{direction}`, `flash_sale_phantom_stock_units_total`, `flash_sale_oversell_detected_total`, `flash_sale_claims_expired_total`, `flash_sale_reconcile_waiting` after the runs; `requestId` and `saleId` on log lines; no e-mail or token
- [X] T062 [US7] Add the counters/gauge, structured log fields and spans in the source, lifecycle service and jobs; add alert rules next to S10's if the repo keeps such a file (FR-034); run the file green

---

## Phase 10: Removal, boundaries, polish (gaps A22–A24, A27, B, C)

- [X] T063 Delete `ORD/infra/flash/` (`flash-stock.service.ts`, `flash-stock.service.spec.ts`, old `flash-sale.model.ts`, legacy jobs), `ORD/flash-sale-legacy.module.ts`, and `ORD/flash-sale-legacy.e2e-spec.ts` (scenarios re-proven by AS-20/AS-25: L-017); remove the two flash tests from `ORD/checkout.e2e-spec.ts` (scenarios preserved by AS-01/AS-08)
- [X] T064 Remove `FlashSaleModel` and `FlashStockService` from `ORD/index.ts`, `ORD/orders.module.ts`, `ORD/orders-worker.module.ts`, and `FlashSaleLegacyModule` from `OrdersModule.exports`; update `ORD/orders-boundary.e2e-spec.ts` so it no longer lists them (D-7, D-8); import `FlashSaleModule` / `FlashSaleWorkerModule`
- [X] T065 Update `scripts/load-tests/flash-sale.test.js` (A27): create the sale through the new route, drive the load handler, automatic `oversold == 0` assertion (orders vs `units`), print the 150 ms / 50 ms percentile checks
- [X] T066 Static gates: `pnpm tsc --noEmit -p .` and `pnpm lint` (backend and contracts), `pnpm check:boundaries`, `pnpm --dir packages/backend check:table-ownership --strict` (flash files 0 findings, SC-009/AS-43), confirm `.tx.baseline` not raised and `sequelize.transaction` count in `ORD` did not rise
- [X] T067 Run the whole `libs/domains/orders` suite once, in batches of fresh processes (L-008); a batch with no summary line is a crash, not a flake
- [X] T068 `python3 scripts/livespec/check.py` passes with the S11 page and edited S10 page; every `[proof:]`/`[code:]` true
- [X] T069 (deferred to the final checkpoint: `scripts/infra/boot-app.sh core` and `scripts/infra/boot-app.sh worker`; see `specs/deferred-checks.md`) Start the real `apps/core` and `apps/worker` (L-004, L-015) and confirm routes mapped, five handlers and two schedules registered, no `UnknownJobTypeError`/`InvalidScheduleError`; if the sandbox denies it, write it as blocked in `questions.md` and keep the existing `specs/UNVERIFIED.md` row `not run` (never "passed")
- [X] T070 Ops artifacts: confirm `quickstart.md` "Ops artifacts" and the three S11 rows of `specs/UNVERIFIED.md` (SC-002 k6, application start, fresh-stack drill) stay `not run` unless actually executed
- [X] T071 Final `gaps.md` pass: tick every A1–A28, B (D-6, D-7, D-8, D-12) and C finding against the gap map below; confirm the `## Sibling-spec follow-ups` list (S10, W03, S48, S05, S50, S49) is complete; report the follow-ups from S05, S10, S13 (nothing to build), S30/S48, S38 (nothing to build), S49, S52

---

## Gap → task map (every gaps.md item has a task)

A1 T039,T044,T045 · A2 T028,T039 · A3 T028,T039 · A4 T028,T053 · A5 T010,T028 · A6 T044,T055 · A7 T050 · A8 T029,T049 · A9 T027,T030 · A10 T045 · A11 T045 · A12 T023,T034 · A13 T034,T035,T059 · A14 T011,T039 · A15 T023,T033 · A16 T039 · A17 T039 · A18 T039 · A19 T038,T039 · A20 T062 · A21 T010–T016 · A22 T063 · A23 T016,T031,T035 · A24 T064 · A25 T029 · A26 T029 · A27 T065 · A28 T023,T025,T046 · D-6 T016,T031 · D-7 T064 · D-8 T064 · D-12 T039,T041 · C findings T035,T041,T063,T066.

## Dependencies and order

Phase 1 → Phase 2 (blocking) → US3 (Phase 3) → US4 (Phase 4) → US1 (Phase 5) → US2 (Phase 6, extends the same file/source) → US5 (Phase 7) → US6 (Phase 8, needs US3/US4 only, can run in parallel with Phases 5–7) → US7 → Phase 10.

Parallel: T005–T009 (specs) then T010–T014; T018/T022/T003/T004; T038 with T037; Phase 8 alongside Phases 5–7 once Phase 4 is green. Files shared by US1/US2 (`flash-sale-checkout.e2e-spec.ts`, `flash-reservation.source.ts`) are sequential.

## Strategy

MVP = Phases 1–2 plus US3, US4, US1 and US2 (schedule, load, buy, admission, fail closed): that is the smallest slice that sells without overselling. Then US5 (release/convert/sweep, required before enabling in production), US6, US7, removal. Every phase ends with its narrowest spec green; the whole suite runs once at T067.
