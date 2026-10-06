# SD-22 — Limited-Drop Auctions (eBay → collectibles & limited editions)

Status: ☑ done (typechecked; spec + k6 written, not run) · Phase 2 · Depends on: F-03, F-05, SD-29, SD-19 (winner checkout)

## Marketplace adaptation
Sellers auction limited items ("Signed first-batch iPhone, #001/100", sneaker collabs). English auction with proxy (max) bids, anti-sniping, reserve price; the winner gets a checkout with a payment deadline, else second-highest is offered.

## Patterns showcased
| Pattern | Lesson |
|---|---|
| **Bid acceptance serialised per auction in Redis** (Lua: check open, `ends_at`, min increment, proxy-bid resolution, anti-snipe extension — atomically) — the hot path never locks Postgres | 10/07 #22 |
| Bids appended to **Kafka `auction.bids`** (key auctionId → per-auction order) and projected: Postgres `Bid` (append-only, partitioned by month) for audit, Redis for current state | D26 CQRS |
| Alternative documented: Postgres conditional update `WHERE current_price < :amt AND status='OPEN' AND ends_at > now()` (fine to ~hundreds bids/s per auction) — trade-off in ADR | 03/02 §4 |
| **Proxy bidding** resolved inside the same atomic step (second-highest max + increment) | 10/07 #22 |
| **Anti-sniping**: bid in last 2 min extends `ends_at` by 2 min (cap) | 10/07 #22 |
| **Exactly-once close**: SD-29 job at `ends_at`; reschedules itself if extended; idempotent `WHERE status='OPEN'`; Redis state frozen first | 10/09 #29 |
| Live price/time pushed via SSE topic `auction:{id}` (F-03) | 10/06 |
| Server time authority: responses include server time for client countdown sync | 06/02 §6 clocks |
| Shill-bidding guard: seller and seller's staff (SD-02) can't bid; per-user bid rate limit | — |

## Data / storage
- Redis hash `auction:{id}` (price, leader, leaderMax, endsAt, status, version) + ZSET `auction:{id}:maxbids`.
- Kafka `auction.bids`, `auction.events`.
- Postgres: `Auction`, `Bid` (partitioned), `AuctionEvent`.

## API
`POST /auctions` (shop), `POST /auctions/:id/bids` {maxAmount} (Idempotency-Key), `GET /auctions/:id` (read model), SSE `auction:{id}`.

## Steps
- [x] Models/migrations; Redis Lua `place_bid.lua` (returns accepted/outbid/closed + new state).
- [x] BidService → Lua → produce Kafka event (acks=all, idempotent producer) → 202/200 response with current state.
- [x] Projector: bids → Postgres batch insert + auction row update (version guarded).
- [x] Close job + winner checkout creation (SD-19) + payment deadline job → offer to runner-up.
- [x] e2e: 50 parallel bids with increasing max → final leader = highest max, price = second max + increment; bid at T−30s extends end; close runs twice → one winner order.
- [x] k6 `loadtest:auction` (hot auction 2k bids/s).

## Scale
- Target: 10k bids/s overall, 2k bids/s on one hot auction, 200k watchers per hot auction.
- Hot path: Redis Lua (~0.2 ms) → Kafka produce → response. Postgres written by projector in batches.
- First bottleneck & fix: single-threaded Redis per hot auction key ≈ 50k+ evals/s — well above need; watchers → SSE fan-out tier with 250 ms batching (coalesce price updates).
- Partitioning: Redis Cluster by `{auctionId}`; Kafka by auctionId.
- Capacity model: 10k bids/s ≈ 10k Lua evals/s spread over shards; projector batch 500 → 20 inserts/s of batches.
- Proof: k6 hot auction at 1/2/4 API instances; thresholds p99 < 50 ms; invariant check: price sequence monotonic in Postgres.

## FE visualisation (phase 2)
Auction page with live price ticker, countdown synced to server time.

## Implementation notes (2026-10-01)
- Migration `20261001180000-auctions`: `Auction` (partial index on open auctions by end time), `Bid` **range-partitioned by month** (+ `bid_ensure_partitions`), unique (auction, version, createdAt) so relay redeliveries are no-ops.
- `place-bid.lua.ts`: one atomic script = validation + **proxy bidding** (price = min(leaderMax, secondMax + increment)) + **anti-sniping** (extend within the last 2 min, capped at +1 h) + version bump + **XADD to the auction's own bid log** (same hash tag as the state hash → cluster-safe, state and log can't diverge). `CLOSE_AUCTION` freezes bidding.
- `AuctionService`: create (moves the unit out of stock, Redis state, consumer group, transactional close job), `placeBid` (shill guard via cached membership, Lua, SSE `auction:<id>` push), `view` (Redis state + server time; Postgres after expiry).
- `BidRelay` (worker): per-auction XREADGROUP (own pending first), one `INSERT ... SELECT unnest(...)` per batch + version-guarded auction row update, XACK after commit.
- `AuctionJobs` (worker): exactly-once close (Redis freeze + `WHERE status='OPEN'`), re-schedules itself when anti-sniping moved the end, reserve price → CLOSED/UNSOLD (unit returned), winner gets a RESERVED order with a 48 h payment window (reuses SD-19 order machinery + `orders.expire-reservation`), **second-chance offer** to the runner-up at their max if the winner doesn't pay. `auction.closed` domain event.
- Endpoints: `POST /api/shops/:shopId/auctions`, `GET /api/auctions/:id`, `POST /api/auctions/:id/bids` (`auction.bid` rate limit, fail-closed), `GET /api/auctions/:id/bids`.
- Spec `auctions/auctions.e2e-spec.ts`; k6 `auction.test.js` (`pnpm loadtest:auction`).
