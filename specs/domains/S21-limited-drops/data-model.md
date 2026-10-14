# Data model: S21 — Limited-Drop Auctions

Owner of every table below: `auctions` (register `AuctionHistory` in the ownership registry; `Auction` and `Bid` are already registered). All timestamps `TIMESTAMPTZ`; all money `BIGINT` minor units, read in code through `safe-number` style conversion (≤ 10¹², below 2⁵³); API names carry `…Minor`.

## 1. `Auction` (reshaped by expand/contract)

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK (`uuidv7()`) | |
| `shopId` | UUID NOT NULL | **FK to `Shop` dropped** (contract step) |
| `productId` | UUID NOT NULL | plain ID |
| `title` | TEXT NOT NULL, ≤ 140 | |
| `currency` | TEXT NOT NULL | **new**; backfill from `Product`'s currency at migration time, default `'EUR'` for rows whose product is gone |
| `startingPriceMinor`, `minIncrementMinor` | BIGINT NOT NULL > 0 | renamed from `startingPrice`, `minIncrement` |
| `reservePriceMinor` | BIGINT NULL, CHECK `>= startingPriceMinor` | renamed |
| `startsAt`, `endsAt`, `originalEndsAt` | TIMESTAMPTZ NOT NULL | `endsAt` moves by anti-sniping, `originalEndsAt` never |
| `status` | TEXT NOT NULL | CHECK in `SCHEDULED, OPEN, CLOSED, SECOND_CHANCE, SOLD, UNSOLD, CANCELLED`; legacy `OPEN`/`CLOSED`/`UNSOLD`/`CANCELLED` keep their meaning (`CLOSED` = awarded) |
| `statusReason` | TEXT NULL | CHECK per FR-006 (`no_bids, reserve_not_met, leader_ineligible, winner_unpaid, second_chance_unpaid, seller_cancelled, stock_hold_failed`; `winner` is an event reason, not stored) |
| `priceMinor` | BIGINT NOT NULL | renamed from `currentPrice` |
| `leaderId` | UUID NULL | |
| `leaderMaxMinor` | BIGINT NULL | **new**; the leader's maximum (never leaves the service) |
| `bidCount` | INTEGER NOT NULL | |
| `version` | INTEGER NOT NULL | bumps once per durable change of the auction (bid, transition) |
| `unitHeld` | BOOLEAN NOT NULL DEFAULT false | **new**; true after the hold applied, false again after the return applied |
| `holdRequestedAt` | TIMESTAMPTZ NOT NULL | **new**; = `createdAt`; the 5 min deadline base |
| `returnPending` | BOOLEAN NOT NULL DEFAULT false | **new**; set in the transition's transaction when the unit must go back |
| `winnerId` | UUID NULL | current awardee (winner, then runner-up) |
| `finalPriceMinor` | BIGINT NULL | renamed from `finalPrice` |
| `firstOrderId` | UUID NULL | **new**; never changes once set (R-06) |
| `winnerOrderId` | UUID NULL | **new**; order of the current settlement |
| `settlementOrderVersion` | INTEGER NOT NULL DEFAULT 0 | **new**; last applied `orderVersion` |
| `offerExpiresAt` | TIMESTAMPTZ NULL | **new**; set with `SECOND_CHANCE` |
| `closedAt` | TIMESTAMPTZ NULL | **new**; the end that closed it (`closedAt = endsAt`, AS-27) |
| `createdAt`, `updatedAt` | TIMESTAMPTZ | |

Constraints and indexes:
- `Auction_live_product_uq` — **partial unique** on `("productId") WHERE status IN ('SCHEDULED','OPEN','CLOSED','SECOND_CHANCE')` (FR-005; a violation maps to `409 auction_exists_for_product`). A `CLOSED`/`SECOND_CHANCE` auction counts as live: its unit is still held.
- `Auction_open_ends_idx` (existing, `("endsAt") WHERE status = 'OPEN'`) read by the sweeper.
- `Auction_shop_list_idx` on `("shopId", "startsAt" DESC, "id" DESC)` (seller list, keyset).
- `Auction_winner_order_idx` on `("winnerOrderId") WHERE "winnerOrderId" IS NOT NULL` and `Auction_first_order_idx` on `("firstOrderId") WHERE …` (consumer lookup).
- `Auction_hold_pending_idx` on `("holdRequestedAt") WHERE "unitHeld" = false AND status = 'SCHEDULED'`; `Auction_return_pending_idx` on `("id") WHERE "returnPending"`.
- `Auction_product_idx` on `("productId", "startsAt" DESC)` for the batch read.
- CHECK `endsAt > startsAt`; CHECK `originalEndsAt <= endsAt`; CHECK `bidCount >= 0`.

### Expand / contract (III.7 / migration discipline, `lock_timeout` set per statement)

1. `…-auctions-expand.js`: add the new columns (nullable or with default), add the new status values by replacing the CHECK (`NOT VALID` then `VALIDATE`), create `AuctionHistory`, create the indexes `CONCURRENTLY` where the table is large (outside a transaction), copy `currentPrice → priceMinor` etc. by `UPDATE` in batches of 1,000 (empty in practice), set `currency`. A migration never calls the catalog, so legacy rows are kept as they are: legacy `OPEN` rows get `unitHeld = true` (their unit left stock through the old raw update) and `leaderMaxMinor` copied from their newest `Bid.maxAmount` when `leaderId` is set; the sweeper then closes them like any `OPEN` auction whose end has passed. The old Redis hash is not migrated (a legacy auction's live state exists only in Redis); the sandbox holds no production auctions, so this is recorded for completeness and exercised by a migration test on a populated legacy table.
2. Code switches to the new columns.
3. `…-auctions-contract.js`: drop the FK `Auction_shopId_fkey`, drop the renamed old columns, add the partial unique index, add NOT NULL constraints. `down` recreates the old columns; it is run only on a throwaway database.

## 2. `Bid` (append-only, range-partitioned by month on `createdAt`)

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | part of PK `(id, createdAt)` |
| `auctionId` | UUID NOT NULL | plain ID |
| `bidderId` | UUID NOT NULL | renamed from `userId` |
| `maxAmountMinor` | BIGINT NOT NULL | renamed from `maxAmount` |
| `outcome` | TEXT NOT NULL CHECK in `leading, outbid, raised` | |
| `priceAfterMinor` | BIGINT NOT NULL | renamed from `priceAfter` |
| `sequence` | INTEGER NOT NULL | renamed from `version`; equals the auction `version` after the bid |
| `createdAt` | TIMESTAMPTZ NOT NULL | the injected clock, not `now()` (frozen-time tests, AS-50) |

Indexes: `Bid_auction_sequence_idx ("auctionId", "sequence" DESC)` (history, price-changing filter evaluated on `outcome <> 'raised'`); `Bid_auction_bidder_idx ("auctionId", "bidderId", "sequence" DESC)` (my-bid, runner-up). The old unique `(auctionId, version, createdAt)` is dropped only if it blocks the rename; it cannot enforce cross-partition uniqueness (spec LOCAL). The partition function and default partition stay; the new daily job keeps `Bid_YYYYMM` for the current month + 3.

Runner-up query: `SELECT DISTINCT ON ("bidderId") "bidderId", "maxAmountMinor", "sequence" … WHERE "auctionId" = :id ORDER BY "bidderId", "maxAmountMinor" DESC, "sequence" ASC`, ranked in code by the pure selector. Bounded: one auction's bids (hundreds).

Retention: ≥ 24 months, no detach job (out of scope).

## 3. `AuctionHistory` (new, append-only)

`id UUID PK`, `auctionId UUID NOT NULL`, `fromStatus TEXT NULL`, `toStatus TEXT NOT NULL`, `reason TEXT NULL`, `auctionVersion INTEGER NOT NULL`, `at TIMESTAMPTZ NOT NULL` (injected clock), `actor TEXT NOT NULL` (`seller:<userId>`, `system:close`, `system:order-event`, `bidder:<userId>` for the bid-triggered open). Index `("auctionId", "at", "id")`. Bids do not write history (only status changes do, AS-11 "4 bid rows" is separate). Rows are inserted in the transition's transaction by `AuctionRepository.transition()`.

## 4. State machine (`domain/auction-state.ts`)

Discriminated union on `status`; commands: `open`, `cancel`, `close{outcome}`, `award`, `offerSecondChance`, `settlePaid`, `settleUnpaid`, `markUnsold`. Allowed pairs = FR-007 exactly:

```text
SCHEDULED → OPEN | CANCELLED
OPEN      → CLOSED | UNSOLD | CANCELLED (only bidCount = 0)
CLOSED    → SOLD | SECOND_CHANCE | UNSOLD
SECOND_CHANCE → SOLD | UNSOLD
SOLD, UNSOLD, CANCELLED terminal
```

`transition(from, command)` returns `{ ok: true, to, reason } | { ok: false }`; every `switch` ends in `assertNever`. The repository applies it as `UPDATE … SET status = :to, version = version + 1 … WHERE id = :id AND status = :from` and asserts one affected row.

Side effects written in the same transaction as the move:

| Move | History | Outbox | Jobs (S49 enqueue in the transaction) | Post-commit |
|---|---|---|---|---|
| create | `null → SCHEDULED` | `auction.created` | `auctions.hold-stock`, `auctions.open` @ `startsAt`, `auctions.close` @ `endsAt` | inline hold, cache n/a |
| `SCHEDULED → OPEN` | yes | `auction.opened` | — | cache delete |
| bid (no status change) | no | `auction.bid_placed` (+ `leader_changed`) | `auctions.close` @ new `endsAt` if extended | cache delete, `price` push |
| `OPEN → CLOSED` | yes | `auction.closed` | `auctions.request-order{winner}` | `closed` push |
| `OPEN → UNSOLD` | yes | `auction.closed` | `auctions.return-stock` | `closed` push |
| `* → CANCELLED` | yes | `auction.cancelled` | `auctions.return-stock` if `unitHeld` | cache delete |
| `CLOSED → SOLD`, `SECOND_CHANCE → SOLD` | yes | `auction.sold` | — | cache delete |
| `CLOSED → SECOND_CHANCE` | yes | `auction.second_chance_offered` | `auctions.request-order{second-chance}` | cache delete |
| `CLOSED/SECOND_CHANCE → UNSOLD` | yes | `auction.unsold` | `auctions.return-stock` | cache delete |

`return-stock` is enqueued only when `unitHeld` is true and the final status is `UNSOLD` or `CANCELLED`, and sets `returnPending = true` in the same statement.

## 5. Derived and in-memory shapes

- **Bid resolution state** (pure input): `{ priceMinor, leaderId, leaderMaxMinor, minIncrementMinor, reservePriceMinor | null, startingPriceMinor }`; output `{ outcome | rejection, priceMinor, leaderId, leaderMaxMinor, reserveMet, minimumNextMaxMinor }`.
- **Alias**: derived, never stored (R-12).
- **Public view cache entry**: key `auction:view:<id>`, value = `auctionPublicSchema` JSON + `version`; TTL 1 s + jitter; deleted after each commit.
- **Fast store (Redis) holds nothing that decides a bid**: view cache, S50 limiter buckets, S51 realtime fan-out. The old `auction:*` keys are unused.

## 6. Ownership registry and boundaries

- Registry rows: `Auction`, `Bid`, `AuctionHistory` → `auctions`. After S21: `check:table-ownership --strict` reports 0 for the auctions files (was 5: `Product` ×2, `BisOrderItem`, `ShopOrder`, `BisOrderModel`); no `Auction`/`Bid` FK to a foreign table.
- Orders amendment tables (owned by `orders`, edited by S10-side code in WP-3): `StockReservation.source` gains `'EXTERNAL'` (CHECK replaced; data-neutral).
