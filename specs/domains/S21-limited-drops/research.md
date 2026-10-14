# Research: S21 — Limited-Drop Auctions

Decisions that the plan rests on. Unknowns in the Technical Context: none left as "NEEDS CLARIFICATION"; the items below are the places where the spec leaves the mechanism open or where the code on disk differs from what the spec assumes. Facts were checked in the repository on 2026-10-14.

## Facts found in the repository (they drive R-01…R-12)

- `OrderCommandService.createFixedPriceOrder` **does not exist** in `orders` (grep over `libs/`: no hit). S10's barrel exports `OrderQueryService`, `OrderFulfilmentService`, events, and a TRANSITIONAL block (`BisOrderItemModel`, …). The spec's `[CONTRACT]` to S10 is therefore an **amendment S21 must build** (as S11 did for the reservation seam), not a call into an existing service.
- `ProductQueryService`, `ProductStockService` (S05), `ShopAccessService.getRole` (S03, `shop-access.service.ts:72`), `EntitlementsService` + `RequiresShopEntitlement` (S18) exist.
- Today's `auctions` domain is 1,225 lines: Lua script, bid relay, `AuctionService`, `AuctionJobs`, one controller, `Auction` model, one migration (`20261001180000-auctions.js`, `Bid` range-partitioned by month with `bid_ensure_partitions`, FK `Auction.shopId → Shop`). No `domain/`, no repository, no consumer.
- `orders.events` consumers are `Projector` classes (`infra/payments-events.consumer.ts` is the model: `name`, `topics`, `idempotency`, `handles`, `TransientError` / `PermanentError` from `@app/infrastructure/projections/errors`).
- Job types are declared with `declareJobType` in a file loaded by enqueuers (`orders/application/order.job-types.ts` pattern); auctions today declares none (S49 follow-up).
- `ReservationRecord.source` is `'CATALOG' | 'FLASH' | 'POSTGRES'`; release/expiry returns stock for every row not `FLASH`-claimed. An `EXTERNAL` source does not exist yet.
- `packages/contracts` has no auctions schemas; `bff/upstream.ts:45-48` holds a loose `auctionPublicSchema` (`z.looseObject({productId})`) that this capability replaces under the same exported names. `notifications/consumed-events.ts` already parses `auction.leader_changed`, `auction.closed`, … in the shape of `contracts/events.md`.
- `.ownership.baseline` = 5, `.tx.baseline` = 0 for the domain. The domain has no `sequelize.transaction` today (grep: none) and no `// S54 T037 audit` comment.

## R-01 One decision step per auction: row lock inside one transaction

- **Decision**: a bid is one `TransactionRunner.run` that does `SELECT … FROM "Auction" WHERE id = :id FOR UPDATE`, runs the pure `resolveBid`, inserts the `Bid` row (sequence = new `version`), updates the `Auction` row with a conditional `WHERE id = :id AND version = :seen`, appends `auction.bid_placed` (and `auction.leader_changed` when the leader changed) to the outbox, and commits. Close, cancel, open, second-chance and settlement transitions take the same lock, so a bid and a close serialize (AS-32) and a cancel and a first bid serialize (AS-09). The lock is held for one short transaction with no network call (III.3).
- **Rationale**: spec FR-015 + note §22 ("row-level locking is fine at hundreds of bids/s"); the lock gives gapless sequences and a single order, and the conditional update on `version` is the belt-and-braces check that asserts one affected row (FR-007). SC-002 (100 bids/s on one auction) is within reach of a sub-5 ms lock hold; it is an ops artifact, not a test.
- **Alternatives**: optimistic retry on `version` (bid storms retry-storm on a hot auction; rejected); advisory lock (same effect, invisible to the ORM and harder to test; rejected); a queue partitioned by auction (spec lists it as a later option); Redis Lua as the source of truth (the thing the spec removes).

## R-02 The bid gate for AS-32 and the crash switches

- **Decision**: two test seams inside the application services, registered only by the test kit (L-003: the seam must be able to make a test fail, so each is asserted to have been reached): `BidDecisionGate` (awaits a latch after the lock is taken and before the decision) and `CrashPoint` (throws between named steps: `schedule.after_row`, `close.after_commit`). Same pattern as S11's `CrashPoint`.
- **Rationale**: AS-06, AS-32, AS-33 need a deterministic interleaving; sleeping is flaky (L-007).

## R-03 Idempotency uses the S54 facility, not a table of ours

- **Decision**: `@Idempotent()` from `@app/infrastructure/idempotency` on create and bid, scope = the authenticated principal (so a replay from another user is a fresh bid, AS-18), retention platform default 24 h (FR assumption). The bid handler must not write a bid row for a stored replay, so no extra dedupe table is added.
- **Rationale**: V.6 and P0414 are already built (S54); a second mechanism would violate "one way to do it".

## R-04 Winner and second-chance orders: build `OrderCommandService` in `orders` (S10 amendment)

- **Decision**: add to `orders` an R1 provider `OrderCommandService.createFixedPriceOrder(command)` exactly as in spec "Requires S10". Implementation (kept to the smallest edit set, listed in `contracts/services.md`):
  1. Idempotency by the existing unique `(userId, idempotencyKey)` of `BisOrder`; a replay reads the order with `findByKey` and returns `replayed: true`. The key is stored for the order's life (≥ 90 days by construction, orders are never purged).
  2. One transaction inserts a `RESERVED` order (`reservedUntil` from the command), one `BisOrderItem` (line price = `unitPriceMinor`, no discount), one `ShopOrder`, one reservation row with `source = 'EXTERNAL'`, `sourceRef = <auctionId>`, `status = 'HELD'`, and the history row `null → RESERVED` with actor `system:auction`; `order.reserved` is appended to the outbox in the same transaction.
  3. `EXTERNAL` reservations are skipped by `ReservationReleaseService` (no `applyStockDelta` on cancel or expiry); `order.cancelled` is still emitted (spec: S21 needs it for the second chance).
  4. Validation: `buyer_not_eligible` (buyer unknown/blocked, via the identity R1 lookup S10 already uses for checkout), `shop_not_eligible` (shop not active, via `ShopDirectoryPort`), `invalid_price` (≤ 0 or not an integer); each throws `OrderCommandRejectedError {code}` (permanent). Anything else is transient.
- **Rationale**: the spec fixes the contract; the follow-up from S10 says "S21 must specify" the command; without it the domain cannot stop writing `BisOrder` (D-7, D-12).
- **Alternatives**: reuse `CheckoutService` with a synthetic cart (it prices from the catalog and discounts, wrong for an auction price; rejected); S21 inserts into orders tables (the finding we are removing; rejected); leave S10's `OrderService` compat path for the worker (keeps `BisOrderModel` in the barrel; rejected, spec FR-039).
- **Risk**: editing a built capability. Mitigation: WP-3 runs every existing S10 spec green first, makes the edits in new files plus one `if (source === 'EXTERNAL') return` in the release service, and re-runs them (as S11 WP-7).
- **S10 baseline (T002, before any edit)**: `libs/domains/orders/` e2e specs in 3 fresh-process batches, all green: 17 suites, 217 tests (cart 12; checkout/order-*/payment-* 8 suites 86; flash-sale-*/orders-boundary 8 suites 119). `check:table-ownership`: 44 findings in 12 domains, auctions = 5 (Product x2, BisOrderItem, BisOrderModel, ShopOrder). `grep -c sequelize.transaction libs/domains/auctions` = 0.

## R-05 Consumer for `order.paid` / `order.cancelled`

- **Decision**: `AuctionSettlementConsumer implements Projector` (`name: 'auctions-order-results'`, `topics: ['orders.events']`, `handles: [OrderPaid, OrderCancelled]`, `idempotency: 'natural'`): zod-validate with the S10 event schemas, look the order up by `winnerOrderId` or `firstOrderId` through `AuctionRepository.findBySettlementOrder`, call `SettlementService.onOrderPaid/onOrderCancelled`. Idempotency is the conditional update (`WHERE status = 'CLOSED' AND winnerOrderId = :o`) plus a per-order `lastOrderVersion` guard (`Auction.settlementOrderVersion`, lower or equal version → ignored). Invalid payload → `PermanentError` (DLQ). Unknown order → ignored.
- **Held for redelivery (AS-39)**: an event whose order is unknown but whose `userId` equals the current `winnerId`, whose auction is `CLOSED`/`SECOND_CHANCE` with `winnerOrderId IS NULL`, and whose `totalMinor` equals `finalPriceMinor` raises `TransientError` (redelivered by the framework); once the request job stores the ID the redelivery matches. After the framework's retry budget the message goes to the DLQ and the sweeper repairs by asking S10 for the order by key (`OrderQueryService` is not enough; the sweeper simply re-runs the request job, which is idempotent and returns the stored `orderId`, then a manual replay of the DLQ message settles it; documented in the runbook line of `quickstart.md`).
- **Alternatives**: poll S10 tables (D-12; rejected); carry an auction marker in S10's events (changes S10's contract; rejected, the S10 fields are fixed in the spec).

## R-06 Second chance and the first order's identity

- **Decision**: `Auction.firstOrderId` is set when the winner's order ID is stored and never changes; `winnerOrderId` is the order of the **current** settlement (first order, then the offer's order). A late `order.paid` for `firstOrderId` while the auction is `SECOND_CHANCE`, `UNSOLD` or `SOLD` increments `auction_settlement_anomaly_total{kind="late_payment"}` and logs; no transition (AS-39).

## R-07 Unit hold and return are durable intent + idempotent stock commands

- **Decision**: the create transaction writes the auction (`unitHeld = false`) and two jobs (`auctions.hold-stock` now, `auctions.open` at `startsAt`); the hold job calls `ProductStockService.applyStockDelta` with `auctions:<id>:hold`, then a conditional update `unitHeld = true`. A rejected hold with `insufficient_stock` or `unavailable` cancels the auction (`stock_hold_failed`). The return is a job written in the transition's transaction (`auctions.return-stock`, `returnPending = true`); it applies `auctions:<id>:return` and sets `returnPending = false, unitHeld = false`. The sweeper re-runs holds older than 1 min, returns still pending, and cancels holds older than 5 min. Network calls never sit inside a transaction.
- **Why not synchronous hold in create**: AS-06 requires the "crash after row, before stock" state to be recoverable and observable; a synchronous call in the request would still need the sweeper for that case, so the job is the single path. The create answer therefore returns `SCHEDULED` before the hold completes; AS-01 expects stock `2` after create returns, so create **runs the hold job's handler inline after commit** (same code, same operation ID, failure leaves the job to retry) — the response is `201` either way, stock `2` in the normal case.

## R-08 Close trigger: delayed job per `(auction, endsAt)` plus the sweeper

- **Decision**: `auctions.close` enqueued with idempotency key `auction-close:<id>:<endsAtMs>` at create and re-enqueued inside the bid transaction when the end moves (AS-26 allows the job itself to re-arm; both are idempotent by key). The job handler calls `AuctionCloseService.closeIfDue(id)`: lock, `now >= endsAt` else re-arm for the stored end and return. `auctions.sweep-due` (every 30 s, `fleetConcurrency: 1`) selects `OPEN` auctions with `endsAt <= now` using the partial index `Auction_open_ends_idx`, plus the hold/return/request repairs of R-07, R-09; ≤ 200 per run, `SKIP LOCKED`.

## R-09 Order request job

- **Decision**: `auctions.request-order` payload `{auctionId, step: 'winner' | 'second-chance'}`, `maxAttempts: 8`, backoff 5 s × 2ⁿ, full jitter, dead-letter on the last failure (metric `auction_order_request_failed_total`, alert). Handler: read auction (no lock), call `OrderCommandService.createFixedPriceOrder` (outside any transaction), then one conditional update storing `winnerOrderId` (and `firstOrderId` for the winner step). `OrderCommandRejectedError` → `SettlementService.onWinnerUnpaid` (same path as `order.cancelled`). The sweeper enqueues the job again for a `CLOSED` auction with `winnerOrderId IS NULL` older than 60 s (idempotent via key).

## R-10 Shill guard: R1 lookup outside the transaction, re-check at close

- **Decision**: bid path: `ShopAccessService.getRole(shopId, userId)` with a 200 ms timeout **before** the transaction (shop ID read from a one-statement durable lookup, cached 1 s with the view), fail closed. Close path (AS-42): read leader, `getRole` outside any transaction, then open the transaction, lock, and if the leader changed since the check re-run the check (loop ≤ 3, then leave the auction `OPEN` and retry on the next sweep so an unchecked leader is never awarded). Runner-up selection (AS-38) checks members in one batch per candidate list (≤ 20 candidates, then stop).
- **Alternative**: check inside the transaction (network call in a transaction; banned by III.3).

## R-11 Public view cache and realtime

- **Decision**: `CacheService.getOrLoad('auction:view:<id>', loader, {ttlMs: 1000, jitter})`; the commit hook deletes the key after commit (never inside) and publishes the `price` message through `RealtimePublisher` wrapped in try/catch with a failure counter; a store outage falls back to the loader (AS-45). `GET /auctions?productIds=` is one `WHERE productId = ANY(:ids) AND status IN (non-terminal or closed within 24 h)` statement. Policy `auctions.read.ip` 600/min fail open via `@RateLimit`.
- **Post-commit hook**: `TransactionRunner.run` exposes `afterCommit` callbacks (S54 toolkit); the plan uses it for cache delete, realtime and the inline hold.

## R-12 Alias function

- **Decision**: `alias(auctionId, userId, secret) = 'Bidder ' + base32(HMAC-SHA256(secret, auctionId + ':' + userId)).slice(0, 4)` in Crockford base32 (no `I L O U`), where `secret` is the new config key `auctions_alias_secret` (required, ≥ 32 bytes, rotated never: rotating changes aliases mid-auction; documented). 4 characters gives 20 bits: two bidders in one auction can collide (≈ 1 in a million per pair); the function takes the number of **distinct** bidders into account by extending to 6 characters, which makes a collision between two real bidders of one auction negligible (~10⁻⁹ per pair). Decision: **6 characters** (`Bidder 7K2Q4M`). The spec example is "e.g.", not a format.

## R-13 Bid log storage and the partition job

- **Decision**: keep `Bid` range-partitioned on `createdAt` with the existing function; the new daily single-run job `auctions.ensure-bid-partitions` calls `bid_ensure_partitions(date_trunc('month', now()), 4)` (current + 3); the default partition gauge `auction_bid_default_partition_rows` is read by the same job (`SELECT count(*) FROM "Bid_default"`, cheap while it is empty). Because the unique index cannot span partitions with a different `createdAt`, uniqueness of `(auctionId, sequence)` comes from the lock (R-01) and the test AS-19; the index stays `(auctionId, sequence DESC, createdAt)` for the history query. Column renames: `version → sequence`, `userId → bidderId`, `maxAmount → maxAmountMinor`, `priceAfter → priceAfterMinor` by expand/contract (add, backfill from the single legacy rows, swap code, drop).

## R-14 Anti-sniping and configuration

- **Decision**: pure `extendEnd({endsAt, originalEndsAt, now, priceChanged, window, extension, cap})` in `domain/auction-schedule.ts`; configuration keys with validation at startup (S54 config): `auctions_snipe_window_ms` 120000, `auctions_snipe_extension_ms` 120000, `auctions_snipe_cap_ms` 3600000, `auctions_sweep_interval_s` 30, `auctions_hold_deadline_s` 300, `auctions_min_lead_s` 60, `auctions_min_duration_s` 600, `auctions_max_duration_s` 2592000, `auctions_winner_window_h` 48, `auctions_offer_window_h` 24, `auctions_view_cache_ms` 1000, `auctions_order_max_attempts` 8, `auctions_max_amount_minor` 1000000000000, `auctions_partition_months_ahead` 3, `auctions_alias_secret`. Validation: window ≥ 0, extension ≥ window? (not required; extension > 0), cap ≥ extension, min_lead ≥ 0, min_duration < max_duration, hold_deadline > sweep interval.
- The spec's AS-24 uses `endsAt = max(E, now + 2 min)` where the extension equals the window; the pure function keeps them as two keys so a later change is data, with default equal values.

## R-15 Table-driven pure modules and the two unit specs

- **Decision**: `domain/proxy-bid.ts` (`resolveBid`, AS-53), `domain/auction-state.ts` (transition table + `assertNever`, `isBiddingOpen`, AS-54), `domain/auction-schedule.ts` (`extendEnd`, `validateSchedule`), `domain/bidder-alias.ts`, `domain/runner-up.ts`. Two spec files per test-plan (`proxy-bid.spec.ts`, `auction-state.spec.ts`; the latter covers the last four modules via imports). The spec names exactly two files; splitting the code into five modules while the specs stay two is allowed (VII.5 is about pure logic having a spec, not file count).

## R-16 Removal list (L-017: scenarios, not files)

- Rewritten in place (same name, new content): `infra/auction.jobs.ts`. Split and replaced: `application/auction.service.ts`. Deleted: `infra/place-bid.lua.ts`, `infra/bid-relay.service.ts`, the Redis state (`auction:<id>` hash, `auction:active` set, the stream).
- `auctions.e2e-spec.ts` (6 tests, no `AS-nn` ids) is deleted after its scenarios are carried by the new files; the mapping is in [`retired-scenarios.md`](retired-scenarios.md).
- Redis keys of the old design are not read any more and have no TTL; no migration code is written for them. `quickstart.md` lists an operator step (`redis-cli --scan --pattern 'auction:*'` then `UNLINK`), status "not run" in `specs/UNVERIFIED.md`.
