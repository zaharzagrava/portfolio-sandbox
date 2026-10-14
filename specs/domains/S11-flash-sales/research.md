# Research: S11 — Flash sales (domain `orders`)

Every `NEEDS CLARIFICATION` of the plan is resolved here. Facts about the code were read on 2026-10-14 (S10 is built; `S10-cart-checkout/.implemented` exists). Defaults of [`questions.md`](questions.md) are accepted as written (no human edit); where the built S10 differs from what the spec assumed, the difference is recorded as a decision below.

## R-01 The seam as built differs from the seam the spec assumed

- **Fact**: `ReservationSource` in `domain/ports.ts:297` is `reserve(operations: StockOperationInput[])` / `release(operations)`, order-first, catalog-only (`infra/catalog-reservation-source.ts`). `OrderReservationService.reserve(orderId)` builds one catalog command from all items of the order. `ReservationReleaseService` releases every `RELEASE_PENDING` row of an order through the catalog. `OrderLifecycleService` converts with `reservations.transitionAll(order.id, ['HELD'], 'CONVERTED')` (`order-lifecycle.service.ts:226`). `StockReservation` already has `source`, `sourceRef`, `flashSaleId`, `bucket`, `releaseAttempts`, `nextReleaseAt`.
- **Decision**: keep S10's `ReservationSource` (catalog) untouched as the *after-order* seam and add a second port, `FlashReservationPort`, in `domain/ports.ts` for the *before-order* flash seam (`admit`, `reserve`, `commit`, `release`, `convert`). S11 edits the S10 services at five named points (checkout, order reservation, release, lifecycle convert, reservation repository); each edit is listed in the plan as a work package and proven by existing S10 specs staying green plus S11 specs. Rows of source `FLASH` are written by `createPending` already `HELD` (never `REQUESTED`): the claim exists before the order.
- **Why**: the spec's `BEFORE_ORDER` mode needs the buyer id, returns a price, and runs before any row exists; none fits `reserve(operations)`. A single widened interface would force the catalog source to implement methods it cannot.
- **Alternatives**: (a) order-first for flash too — rejected by questions.md (one cancelled order per refused attempt at a 99% refusal rate); (b) rewrite S10's seam as the spec's `reserve(order, lines)` — S10 is built and signed off by its own tests; a second port is additive.

## R-02 Finding the open sale of a product without touching Postgres or the fast store

- **Problem**: AS-06/AS-08/AS-40 need "is there an open sale for these products" per checkout with 0 relational reads per attempt, while AS-13 needs a regular-only cart to keep working when the fast store is down. A per-product Redis marker (today's design) fails the second; a Postgres read per attempt fails the first.
- **Decision**: `FlashSaleDirectory` (application) keeps the list of `LOADED` sales whose `endsAt` is in the future (`id, productId, shopId, priceMinor, currency, units, buckets, perUserLimit, admissionRatePerSecond, startsAt, endsAt`) in S52 `getOrLoad('orders:flash:loaded', loader, { ttlMs: 2000, swrMs: 5000, staleIfErrorMs: 30000, jitter: 0.2 })`. The window rule is evaluated per call with the injected clock on the cached rows (never by cache freshness). A product is a drop product iff a row matches `productId` and `startsAt ≤ now < endsAt`.
- **Staleness is safe**: a newly loaded sale appears ≤ 2 s late (load is 60 s before the start); a cancelled or ended sale cannot sell outside its window and cancel of a `LOADED` sale is only allowed before `startsAt`; a sale cancelled before start is never inside its window. A sale that became `START_FAILED`/`CANCELLED` is never in the list.
- **Failure**: if the directory loader fails and no stale value exists, the checkout of that cart answers `503 checkout_unavailable` (it cannot know). With a stale value it keeps working. The fast store being down does not affect the directory.
- **Alternatives**: per-product Redis marker (rejected: couples regular checkout to Redis); a process-local interval refresh (rejected: S52 already gives single-flight, SWR, jitter and the spec's follow-up says to use it).

## R-03 Cluster-safe atomicity: where the draw record lives

- **Problem**: Redis Lua scripts touch keys of one slot only (buckets are deliberately on different slots, P0324). A draw over several buckets plus a claim record plus a quota cannot be one script. A crash between "unit taken" and "draw recorded" would lose units, and recording first would create units from nothing.
- **Decision**: the record of what a claim took from a bucket lives **in the bucket's own slot, written by the same script that decrements** (`flash:{<saleId>:<b>}:stock` is the counter, `flash:{<saleId>:<b>}:draws` is a hash `claimId → units`). Steps for a reserve of `q` units:
  1. **Claim script** (slot `{saleId:claim:<claimId>}`): `HSETNX` claim hash `state=CLAIMED, buyer, sale, qty, createdAtMs, buckets=<planned list>`; returns existing state on replay (idempotent `claimId = uuidv5(saleId, buyerId, idempotencyKey, productId)`).
  2. **Quota script** (slot `{saleId:quota:<buyerId>}`): hash `total` plus field `claimId → qty`; refuses if `total + q > perUserLimit` (`limit_exceeded`), else records. Idempotent per `claimId`.
  3. **Draw scripts**, one per bucket in the plan (slot of that bucket): take `min(want, available)` if `available > 0` and `HSET draws claimId taken`. A missing key is "empty", never created (`GET` nil → 0; the script never `SET`s the counter).
  4. If the sum is short: **give back** (the release procedure below) and answer `out_of_stock`.
- **Release procedure** (idempotent, resumable, used by cancel, expiry, failed reserve, sweeper): (a) claim script moves `CLAIMED|COMMITTED → RETURNING` (or answers `already_released`/`not_held` for `RETURNED`/`SOLD`), (b) for each bucket in the claim's planned list a **return script** `HGET draws claimId` → if present `INCRBY stock n; HDEL draws claimId` (one slot, atomic; absent = nothing to return), (c) quota script `HDEL claimId; total -= qty` if present, (d) claim script `RETURNING → RETURNED`. A crash after any step is resumed by the sweeper because state is `RETURNING` and every step is a no-op when done.
- **Why correct**: units are only ever added back by a script that removes the draw record in the same atomic step; a unit can be returned at most once and cannot be forgotten. The planned bucket list is a superset of the buckets actually drawn from (written before drawing), which is safe because return only moves recorded draws.
- **Single-node Redis** (dev and CI) runs the same scripts; correctness does not depend on cluster mode. `RedisService` already exposes the client; scripts are loaded with `defineCommand`-style `EVALSHA` through one `FlashScripts` file. All keys of a call share no slot assumption.
- **Alternatives**: one script over all buckets with a shared hash tag (rejected: serializes the sale on one shard — the exact problem of P0324); a Postgres claim table (rejected: a database write per attempt defeats AS-06).

## R-04 Admission allowance

- **Decision**: token bucket in one script per sale (`flash:{<saleId>:adm}`), state `{tokens, updatedAtMs}`; arguments `rate`, `burst = rate`, `nowMs` from the injected clock (the app passes `clock.now()`, not Redis `TIME`, so tests with a frozen clock are deterministic and instances share one time source per the spec). Refill is `min(burst, tokens + elapsedMs × rate / 1000)`, never below 0, `elapsedMs` clamped ≥ 0 (a clock that moves backwards does not mint tokens). The same arithmetic is the pure function `allowance()` in `domain/flash-admission.ts`, unit-tested with fast-check; the e2e (AS-10, AS-11) proves the script agrees with it for the frozen-clock cases. Rejected attempts answer `429 flash_sale_busy` with `Retry-After` uniformly random in `[1, 3]` s.
- **Per-buyer limit** (`orders.flash-reserve.user`, 30/min, fail closed): `RateLimiterService.check('orders.flash-reserve.user', '<userId>:<saleId>')` called programmatically after the sale is known (a decorator cannot know the sale). Order of checks for a drop line: per-buyer limit, then admission (so one hostile buyer cannot drain the sale's allowance), then claim. `denied` → `429 rate_limited` (S50's problem); `store down` with `failMode: closed` → `503 flash_sale_unavailable`.
- **Alternatives**: sliding window via S50 for the sale (rejected: needs a policy with a runtime rate); Redis `TIME` (rejected: not testable with a frozen clock).

## R-05 Window, state machine and the "open" rule

- Pure `domain/flash-sale-state.ts`: `transition(status, command)` returns the next status or `illegal`; `isOpen(sale, now)` is `status === 'LOADED' && startsAt ≤ now < endsAt` (FR-006). Commands: `load`, `failLoad(reason)`, `cancel(now)`, `end`, `reconcile`. `cancel` of `LOADED` is legal only when `now < startsAt`. Statuses `SCHEDULED, LOADED, ENDED, RECONCILED, CANCELLED, START_FAILED`. Terminal: `CANCELLED, START_FAILED, RECONCILED`.
- Transitions are conditional updates `UPDATE … SET status = :to, "statusReason", version = version + 1 WHERE id = :id AND status = :from` asserting one row, plus a `FlashSaleHistory` row and (where FR-031 says so) the outbox row, in one `TransactionRunner.run`.

## R-06 Load, end, reconcile, verify, sweep as jobs (S49)

- Job types (all declared with `declareJobType` and a zod payload contract next to the `JobPayloads` augmentation — S49 follow-up): `flash-sale.load` (replaces `flash-sale.start`), `flash-sale.end`, `flash-sale.reconcile`, `flash-sale.verify` (periodic, single-run lease, every 30 s, fans out one `LOADED` sale at a time), `flash-sale.sweep-claims` (periodic, single-run, every 10 s). Sale-bound jobs are enqueued **in the transaction that creates the sale** (the jobs table is in the same database: `JobsService.enqueue` inside `runner.run`), keyed `flash-sale.load:<saleId>` so a re-enqueue is a no-op.
- **Old names**: in-flight `flash-sale.start` jobs are handled by a thin alias handler for one release that delegates to the load handler (drain), then removed; the declaration of `flash-sale.start` stays until `SELECT count(*) FROM jobs WHERE type='flash-sale.start'` is 0 in the migration's post-check task.
- **Load order, crash-safe and repeatable** (FR-010, FR-012, AS-21): (1) read the sale `SCHEDULED`/`LOADED` (a `LOADED` sale makes steps 2–4 re-runs that change nothing), (2) `applyStockDelta` with `orders:flash:<saleId>:load` (idempotent for 30 days: replay is not a second decrement), (3) bucket fill with `SET key n NX PX ttl` and `draws` untouched (create-if-absent: a bucket that exists keeps its count, a redelivery after sales never refills), (4) conditional transition `SCHEDULED → LOADED` + history + `flash_sale.loaded` outbox row in one transaction. A crash after (2) or (3) retries into the same end state. `insufficient_stock` from (2) → `START_FAILED(insufficient_stock)` without retry; transient errors (store, catalog timeout) throw a retryable error: S49 backoff with full jitter, `maxAttempts: 8`; the end job turns a still-`SCHEDULED` sale into `START_FAILED(window_missed)` and, if the load command was applied, enqueues its return operation `orders:flash:<saleId>:return` first (the reversal) in the same flow.
- **Reconcile** (FR-027/028): runs at `endsAt + 15 min + 60 s` (a delay computed from the sale's `endsAt`, not from the end job's clock); waits (throws a retry-later result with `runAt = now + 60 s`, counts `flash_sale_reconcile_waiting`) while any flash reservation of the sale is `HELD` or `RELEASE_PENDING`; computes `unsold = max(0, units − CONVERTED units)` from the durable records, sends `orders:flash:<saleId>:return` (skipped for 0), reads the remaining count only for the drift metric, deletes the sale's keys (`SCAN` is avoided: the key set is derivable — buckets 0..n-1, draws, adm, quota keys are removed by TTL since quota keys are per buyer; `DEL` of the known keys plus a bounded `UNLINK` of quota keys listed in a per-sale set `flash:{<saleId>:buyers}`), then the transition `ENDED → RECONCILED` + event, in one transaction for the database part.
- **Lease** (VIII.6): every sale-bound job takes S49's per-key lease; the periodic ones use the scheduler's single-run lease (AS-29).

## R-07 Verification arithmetic and remediation (FR-026)

- Pure `domain/flash-drift.ts`: `classify({ units, remainingFast, reservedDurable, convertedDurable, phase })` returns `{ kind: 'none'|'redis_low'|'redis_high'|'phantom_stock'|'oversold', clampTo?: number, excess?: number }`. During the sale: `phantom_stock` iff `remainingFast + reservedDurable > units` → clamp to `units − reservedDurable` (`clampTo ≥ 0`); `oversold` iff `reservedDurable > units`; after the sale only `redis_low` (`remaining < unsold`) / `redis_high` (`remaining > unsold`) apply.
- **Clamp** lowers bucket counters down to the target by a script per bucket (`DECRBY` limited to the current value; never raises); distribution: take from the fullest buckets first (deterministic).
- **Oversell**: stop selling = a durable `selling_stopped` flag in the sale's `adm` hash read by the reserve path (atomic with the claim script) **and** the verifier zeroes the buckets; cancels the newest unpaid orders beyond `units` through S10's `OrderCancellationService` with reason `out_of_stock` and a flag `returnUnits: false` (their flash rows go `RELEASED` without a bucket return: the release procedure is given `mode: 'discard'` — claim → RETURNED without `INCRBY`); paid excess counts in `unresolvedPaidUnits`.
- In-flight claims never cause a false clamp: units taken but not yet durable are missing from `remainingFast` but not counted in `reservedDurable`, so the sum stays ≤ `units`.

## R-08 Public view and the `sold_out` event

- Public sale rows come from `getOrLoad('orders:flash:public:<saleId>', loader, { ttlMs: 1000, swrMs: 3000, jitter: 0.1 })` (state from the durable record) and the remaining count from a separate `getOrLoad('orders:flash:remaining:<saleId>', readBuckets, { ttlMs: 1000, swrMs: 1000, staleIfErrorMs: 2000, jitter: 0.1, timeoutMs: 100 })`: one pipeline `GET` of N buckets, sum clamped to `[0, units]`. When the loader fails and nothing stale is available the view answers `200` with `remainingApprox: null, degraded: true`. The local promise-coalescing map of the old plan is **not** built (S52 follow-up).
- Batch route resolves product ids → current/next sale through the directory-style cached query `orders:flash:by-product:<productId>` per id (≤ 100 ids, one `getMany`-style pass; at most one view per product: the open sale, else the earliest upcoming within 24 h).
- `state`: `UPCOMING` (`now < startsAt`, status `SCHEDULED|LOADED`), `LIVE`, `SOLD_OUT` (live and `remainingApprox === 0`), `ENDED` (`now ≥ endsAt` or `ENDED|RECONCILED`). `CANCELLED`/`START_FAILED` and `SCHEDULED` with start > 24 h away → `404 flash_sale_not_found`.
- `Cache-Control: public, s-maxage=1` (the repo's `buildCacheControl`).
- **`flash_sale.sold_out` once**: a draw that leaves every bucket of the plan at 0 triggers `FlashLifecycleService.checkSoldOut(saleId)` (async, after the response): reads all buckets in one pipeline; if the sum is 0 it does `SET flash:{<saleId>:state}:sold-out-emitted 1 NX PX ttl` and, when set, appends the outbox event in its own transaction. Units that come back later and sell again do not re-emit (documented).

## R-09 Creation: overlap, lead time, idempotent jobs

- **Overlap** is enforced by an exclusion constraint (requires `btree_gist`, already created by `20261001320000-experiments.js`): `EXCLUDE USING gist ("productId" WITH =, tstzrange("startsAt","endsAt",'[)') WITH &&) WHERE ("status" IN ('SCHEDULED','LOADED','ENDED'))`. The `23P01` error maps to `409 flash_sale_overlap`. Concurrency: two creates race on the constraint, one commits.
- **Validation** is a zod schema in `packages/contracts/src/orders/flash-sale.ts` (strict, defaults for `buckets`, `perUserLimit`, `admissionRatePerSecond`); lead/length checks use the injected clock and config (`orders_flash_min_lead_seconds` 120, `orders_flash_max_window_seconds` 86400). Product check through `ProductQueryService.getProductsByIds([id], { shopId })` **outside** the transaction (R1); unknown → `404 product_not_found`; `ARCHIVED`, sandbox, or non-active shop → `422 product_unavailable`; `units > quantity` → `422 insufficient_stock`; `priceMinor > priceMinor(product)` → `422 drop_price_above_regular`.
- **Shop gate**: `ShopScoped('products.write'|'products.read')` as S03/S05 do. Suspended shop `403 shop_suspended` comes from the gate (AS-16).
- **Status/permissions**: reuse `products.*` (CONTRACT decision); no new permission.

## R-10 Config (FR-035) — validated at start-up

New keys in `libs/common/config` (names fixed; defaults of the spec): `orders_flash_load_lead_seconds` 60, `orders_flash_min_lead_seconds` 120, `orders_flash_max_window_seconds` 86_400, `orders_flash_claim_window_seconds` 60, `orders_flash_order_margin_seconds` 20, `orders_flash_verify_interval_seconds` 30, `orders_flash_sweep_interval_seconds` 10, `orders_flash_call_timeout_ms` 100, `orders_flash_public_cache_ms` 1000, `orders_flash_reconcile_wait_alert_seconds` 600, `orders_flash_key_ttl_jitter` 0.1. Cross-key rule checked at start-up: `margin < claim window`, `load lead < min lead`, `call timeout ≤ 1000`.

## R-11 Key TTLs (FR-015)

TTL = `(endsAt − now) + hold (15 min) + 1 h`, multiplied by `1 ± 0.1` (uniform, from an injectable random source so tests are deterministic). Buckets are set `NX PX`; `draws`, `claim`, `quota`, `adm`, `buyers` keys get the same expiry applied at creation. Keys are `DEL`/`UNLINK`ed at reconciliation. The key namespace is `flash:` and no queue uses Redis in this repo (III.9: verified by `grep -rn "flash:" packages/backend/libs` returning only this domain).

## R-12 Rate-limit and S50 registry

Add to `ordersRatePolicies`: `'orders.flash-reserve.user'` (`slidingWindow`, 30/60 s, `key: 'user'`, `failMode: 'closed'`) and `'orders.flash-sale-read.ip'` (`slidingWindow`, 600/60 s, `key: 'ip'`, `failMode: 'open'`). The read policy is attached with `@RateLimit` to the two public routes.

## R-13 Transactions (rule 4)

`infra/flash/*` has no `sequelize.transaction` today (count 0, `.tx.baseline` = 0). All new transactions use `TransactionRunner.run` / `@Transactional`; the domain's count must stay ≤ baseline. No Redis/catalog/network call inside a transaction (III.3, FR-025): the flows are "Redis first, then database" for reserve and "catalog first, then database" for load, each step idempotent.

## R-14 Ownership and boundaries

`check:table-ownership` lists for `orders` the four flash-related findings of `gaps.md` §C; after the work package order below, flash files read no foreign table: product facts via `ProductQueryService`, stock via `ProductStockService`. `FlashSaleLegacyModule`, `FlashSaleLegacyJobsModule`, `FlashSaleModel`, `FlashStockService` exports and `infra/flash/*` are deleted. The `StockReservation` rows are the domain's own table (same owner), so SQL on them from `infra/` is allowed.

## R-15 Registry entries

`.ownership.baseline` is `1` for the domain (a pre-existing finding that is not S11's); S11 must not raise it, and the flash files must drop their share. `FlashSale` and the new `FlashSaleHistory` table are registered in the table-ownership registry as `orders` (the path is in the existing registry file; the implementation task opens the file and adds the row — no new owner).

## R-16 What is not decided here (explicitly out)

Waiting room (S22), realtime push of the remaining count, automatic refunds of paid oversell — as in the spec's Assumptions.
