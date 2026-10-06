# Feature Specification: S40 — Seller Leaderboards (Ties, My Rank, Period Snapshots), Live Sales Dashboard, Seller Stats (domain `seller-insights`)

**Feature Branch**: `S40-leaderboards-dashboard` (spec directory `specs/domains/S40-leaderboards-dashboard`)

**Created**: 2026-10-06

**Status**: Draft

**Input**: User description: "Seller leaderboards (ties, my rank, period snapshots), live sales dashboard, seller stats (domain `seller-insights`)". Sources: `docs/showcase/sections/SD-18-leaderboard-live-dashboard.md`, note 10-System-Design/06 §18 (real-time leaderboard and live dashboard), pattern P0323 of `docs/architecture/pattern-map.md` (Redis structures: sorted sets), constitution v3.1.0 (VII, IX, X), and the specs already written for S03, S05, S10, S13, S14 and S16.

## Scope

**In scope**

- **Leaderboards**: weekly and monthly "top sellers" boards, overall and per product category, ranked by a shop's paid sales revenue in the period; deterministic tie-breaking; a public top list; a shop's own rank (with its revenue and percentile); frozen period snapshots of the top 100; the feeds that keep boards correct (idempotent, concurrent-safe, out-of-order-safe, rebuildable by replay).
- **Live sales dashboard**: per-second counters for a shop, the last-60-second totals and per-second order sparkline pushed once per second over the realtime channel `shop:{shopId}:live`, checkout conversion, and "today so far" minute series for the first chart.
- **Seller stats**: a shop's sales summary, daily series, top products, and refunds over the last N days.
- The read models this capability needs from other domains: shop names, and product categories (IX.7 R3), plus erasure when a shop is deleted.

**Out of scope** (owned elsewhere)

- Competitor price monitoring (crawler) — **S41**, same domain.
- Order creation, payment, refund, and the order events themselves — **S10**, **S13**; ledger and settlement figures — **S14**, **S16**.
- Shop membership, roles, permissions and the realtime topic policy for `shop:<id>:live` — **S03**; the realtime hub, SSE gateway, subscriber counting — **S51**; job scheduling — **S49**; rate limiting — **S50**.
- The seller dashboard and public leaderboard screens — **W04** (and any later web capability). "Stock left", shown on the launch dashboard in the notes, is a client composition of catalog or flash-sale data by the BFF (IX.7 R2), not a figure of this capability.
- Hiding suspended shops from public boards, partial-refund attribution, approximate rank for very large boards: not built (see Assumptions).

## User Scenarios & Testing *(mandatory)*

Notation used by the scenarios. Time is frozen at `T0 = 2026-10-06T12:00:00Z` (a Tuesday; ISO week `2026-W41` runs `2026-10-05T00:00Z` to `2026-10-12T00:00Z`, month `2026-10`; the previous week is `2026-W40`, `2026-09-28` to `2026-10-05`). Shops `A`, `B`, `C` are `ACTIVE` with names `Alpha`, `Beta`, `Gamma` and ids ordered `A < B < C`. Products `P1` (category `electronics`) and `P2` (category `accessories`) are known to this capability. Amounts are integer minor units of the platform currency `EUR`. "Board" means one ranking: overall or one category, for one period. "Paid order" means an `order.paid` event (see Cross-capability contracts). Unless stated, every endpoint test also checks a `401` without credentials (shop-scoped routes), and the problem+json fields `type, title, status, detail, instance, requestId` on every error.

### User Story 1 — Boards stay correct while sales stream in (Priority: P1)

Every paid order adds its revenue to the right boards of the right periods exactly once, however the events arrive: twice, at the same time, late, out of order, or replayed from the start.

**Why this priority**: a leaderboard that double counts, loses an update or ranks ties differently on each read destroys trust in every other screen.

**Independent Test**: feed paid-order events to the board feed and read the boards through the read endpoints (US2/US3).

**Acceptance Scenarios**:

1. **AS-01** (a paid order lands on every board it belongs to) — **Given** no sales, **When** the paid order `O1 {paidAt: T0, lines: [{P1, shop A, quantity 2, unitPriceMinor 3000, discountMinor 1000, lineTotalMinor 5000}, {P2, shop A, quantity 1, unitPriceMinor 1000, discountMinor 0, lineTotalMinor 1000}]}` is consumed, **Then** on week `2026-W41` and on month `2026-10`: overall board `A = 6000`, board `electronics` `A = 5000`, board `accessories` `A = 1000`; the boards of `2026-W40` and `2026-09` are empty; revenue is the sum of `lineTotalMinor`, never unit price × quantity; the outcome counter `applied` is 2 (counted once per event and period: the week and the month).
2. **AS-02** (duplicate delivery) — **Given** AS-01 applied, **When** `O1` is delivered again, then twice at once, then ten times at once (`Promise.all`), **Then** every board still shows the AS-01 figures (`6000 / 5000 / 1000`), no call fails, `applied` stays 2 and `duplicate` is 26 (13 redeliveries × 2 periods).
3. **AS-03** (concurrent orders of one shop) — **Given** an empty week, **When** 50 different paid orders of 100 minor units each for shop `A` (product `P1`) are consumed by 10 parallel workers at once, **Then** overall `A = 5000` and `electronics A = 5000` exactly (no lost update), `A` appears once on each board.
4. **AS-04** (tie: the shop that reached the revenue first ranks first) — **Given** `A` sells `10000` at `T0 − 60 s` and `B` sells `10000` at `T0 − 30 s`, **Then** the overall week board is `[A, B]`; **When** `B` sells `1` at `T0`, **Then** it is `[B, A]` (`B = 10001`); **When** `A` sells `1` at `T0 + 10 s`, **Then** it is `[B, A]` (both `10001`; `B` reached it at `T0`, `A` at `T0 + 10 s`).
5. **AS-05** (out-of-order delivery never moves the last-sale instant back) — **Given** `B` has `10500` from one sale at `T0 − 300 s`, **When** `A`'s sale of `10000` at `T0` is consumed and **then** `A`'s older sale of `500` at `T0 − 600 s` is consumed, **Then** `A = 10500` and the week board is `[B, A]` (`A`'s latest sale instant is `T0`, later than `B`'s); **When** the same events are consumed in the opposite order on an empty week, **Then** the board is identical, entry for entry.
6. **AS-06** (tie on the same ranking unit) — **Given** `A` sells `7000` at `T0 + 10 s`, and `B` and `C` each sell `7000` at `T0 + 50 s` (all within the minute `12:00`), **Then** the week board (resolution one second) is `[A, C, B]` (`A` earlier; `B` and `C` share the second, so the larger id ranks first); the month board (resolution one minute) is `[C, B, A]` (all three share the minute, larger id first); the same order is returned by the top list and by the rank endpoint on 10 repeated reads.
7. **AS-07** (a sale belongs to the UTC week and month of its `paidAt`) — **Given** the instants in the table below (pure period assignment), **Then** each maps to exactly the stated week id, month id, week start, and an exclusive end; instants with an offset are first converted to UTC.

   | `paidAt` | week | month |
   |---|---|---|
   | `2026-10-04T23:59:59Z` | `2026-W40` | `2026-10` |
   | `2026-10-05T00:00:00Z` | `2026-W41` | `2026-10` |
   | `2026-10-05T01:30:00+02:00` (= `2026-10-04T23:30:00Z`) | `2026-W40` | `2026-10` |
   | `2026-10-31T23:59:59Z` | `2026-W44` | `2026-10` |
   | `2026-11-01T00:00:00Z` | `2026-W44` | `2026-11` |
   | `2026-12-31T12:00:00Z` | `2026-W53` | `2026-12` |
   | `2027-01-03T23:59:59Z` | `2026-W53` | `2027-01` |
   | `2027-01-04T00:00:00Z` | `2027-W01` | `2027-01` |

8. **AS-08** (late event for a closed, not yet frozen period) — **Given** clock `T0` and week `2026-W40` not frozen, **When** a paid order with `paidAt = 2026-10-04T10:00:00Z` is consumed, **Then** it counts on week `2026-W40` and month `2026-10`, not on `2026-W41`.
9. **AS-09** (event for a frozen period is not applied) — **Given** week `2026-W40` frozen (AS-31) with `A = 10000`, **When** a paid order of `500` for `A` with `paidAt = 2026-10-04T10:00:00Z` is consumed, **Then** the frozen week is unchanged (`A = 10000`), month `2026-10` (not frozen) counts it (`+500`), the event is acknowledged without error, outcome counters `sealed` 1 (the week) and `applied` 1 (the month), and one warning log line names the order and the period.
10. **AS-10** (invalid and unsupported payloads) — **Given** paid-order messages that: lack the order id; have a `paidAt` that is not a date; have no lines; have a line with a negative or non-integer `lineTotalMinor`; have a `shopId` that is not a UUID; have `currency` other than `EUR`; or carry an unsupported envelope version, **When** each is delivered, **Then** each is dead-lettered with a reason code, changes no board, and the next valid message in the same batch is applied; a message of another event type on the same topic is ignored without a dead letter.
11. **AS-11** (categories from the read model) — **Given** product `P3` is unknown to the category read model, **When** a paid order of `3000` for `P3` of shop `A` is consumed, **Then** it counts on the overall board only, the outcome counter `category_unresolved` is 1 and no error occurs; **When** the product event for `P3` (`category: "phones"`, `productVersion: 1`) arrives later, **Then** past sales are not re-attributed and the next sale of `P3` counts on board `phones`; **When** a product event with `productVersion: 2` and `category: "gadgets"` arrives, **Then** the next sale counts on `gadgets` and earlier sales stay on `phones`; **When** an event with a lower `productVersion` arrives afterwards, **Then** it is ignored.
12. **AS-12** (rebuild by replay) — **Given** 200 paid orders over three shops, two categories, two weeks and two months whose boards have been recorded, **When** the board store is emptied and the same 200 events are replayed in a random order, followed by a second full replay (duplicates), **Then** every board equals the recorded one, entry for entry, including tie order and revenue.
13. **AS-13** (all boards of an order, or none) — **Given** shop `A` has overall `8,589,934,000` in the week (just under the supported maximum `2^33 = 8,589,934,592` per shop and period), **When** a paid order with a `300` line in `electronics` and a `300` line in `accessories` for `A` is consumed (overall would reach `8,589,934,600`), **Then** it is dead-lettered with reason `revenue_limit_exceeded` and **no** board changed: `electronics` and `accessories` stay without an entry for `A`, overall stays `8,589,934,000`.
14. **AS-14** (ranking key arithmetic, pure) — **Given** the ranking-key rule (revenue first, then the earlier last-sale instant, resolution one second for weeks and one minute for months), **Then** for the table-driven cases (equal revenue earlier/later/same unit, revenue `0`, revenue `2^33 − 1`, instants at period start and `end − 1 unit`, instant after the period end) a higher revenue always outranks any instant, an earlier instant outranks a later one at equal revenue, revenue is recoverable exactly from the key, revenue `≥ 2^33` is refused, and (property-based) the order of any two keys equals the order of `(revenue desc, instant asc)`.
15. **AS-15** (zero-revenue orders) — **Given** a paid order whose lines all have `lineTotalMinor: 0` (fully discounted), **When** consumed, **Then** the shop gets no entry on any board; **When** a later paid order of `1` arrives, **Then** the shop appears with revenue `1`.
16. **AS-16** (retention) — **Given** a sale applied in week `2026-W41` and month `2026-10` at `T0`, **Then** every stored key of those two periods (boards, revenue totals, de-duplication marks, board lists) expires at the period end plus 35 days (within 1 s) and none is stored without an expiry; a sale with `paidAt` in `2026-W40` consumed at `T0` gets the expiry of `2026-W40` end plus 35 days.

---

### User Story 2 — Anyone can see this week's top sellers (Priority: P1)

A visitor opens the leaderboard and sees the top shops of the week or month, overall or for a category, without signing in. Money figures stay private.

**Why this priority**: it is the public face of the capability, and the endpoint takes the heaviest read load.

**Independent Test**: seed boards through US1, call the public endpoint anonymously.

**Acceptance Scenarios**:

1. **AS-17** (top list) — **Given** week `2026-W41` with `B 10001`, `A 10000`, `C 500`, **When** anyone (no credentials) calls `GET /leaderboards?period=week`, **Then** `200` with `{period: {kind: "week", id: "2026-W41", startsAt: "2026-10-05T00:00:00Z", endsAt: "2026-10-12T00:00:00Z", closed: false}, category: null, source: "live", generatedAt, entries: [{rank: 1, shopId: B, slug, name: "Beta"}, {rank: 2, shopId: A, …}, {rank: 3, shopId: C, …}]}` parsed by the contracts schema; ranks are consecutive positions (no shared ranks); no revenue, no user id and no field other than the schema's appears; the header is `Cache-Control: public, max-age=10, s-maxage=30`.
2. **AS-18** (selectors) — **Given** AS-01 and AS-04 data, **When** the caller sends `category=Accessories` (any letter case, normalised), `period=month`, `period=week&id=2026-W40`, or `limit=1`, **Then** the answer is the matching board (category board `accessories`, month `2026-10`, week `2026-W40`, one entry); **When** the category is valid but has no sales (`category=garden`), **Then** `200` with `entries: []`; the default `limit` is 20 and the maximum is 100.
3. **AS-19** (validation) — **Given** the public endpoint, **When** `period=day`, `id=2026-W54`, `id=2026-13`, `id=abc`, `id=2026-W4`, `period=week&id=2026-10` (kind mismatch), `limit=0`, `limit=101`, `limit=abc`, `limit=1.5`, a category longer than 64 characters or containing control characters, a repeated parameter, or an unknown parameter is sent, **Then** each answers `400 validation_failed` with the failing field in `errors[]`; **When** `id` names a period after the current one (`2026-W50`), **Then** `422 period_in_future`.
4. **AS-20** (shop names from the read model) — **Given** the read model holds `A` as `Alpha` (`shopVersion 1`), **When** the shop's name changes to `Alpha Plus` (`shopVersion 2`), **Then** the next top list shows `Alpha Plus`; **When** a stale rename (`shopVersion 1`) arrives later, **Then** the list still shows `Alpha Plus`; a shop on a board with no read-model row shows `name: null` and `slug: null` and stays ranked.
5. **AS-21** (rate limit) — **Given** one client address that sent 60 requests to the public endpoint in the last minute, **When** the 61st arrives, **Then** `429 rate_limited` with `Retry-After`, no board is read; another address is unaffected; **When** the limiter's own store is down, **Then** the request is served (fail open) and a counter `rate_limit_degraded` increments.
6. **AS-22** (frozen periods are served from the snapshot) — **Given** week `2026-W40` frozen (AS-31) and its live board removed from the board store, **When** `GET /leaderboards?period=week&id=2026-W40`, **Then** `200` with `source: "snapshot"`, `closed: true`, the frozen entries in order, and `Cache-Control: public, max-age=3600, s-maxage=86400`; **When** the frozen board is later changed in the board store, **Then** the answer is unchanged (the snapshot wins once it exists).
7. **AS-23** (board store down) — **Given** the board store is unreachable, **When** the caller requests the current week, **Then** `503 service_unavailable` with `Retry-After: 5` and a generic `detail` (no host, command or stack), within 1 s; **When** the caller requests the frozen week `2026-W40`, **Then** `200` from the snapshot.

---

### User Story 3 — A shop sees its own rank (Priority: P1)

A shop member opens the dashboard and sees where the shop stands this week: rank, how many shops are ranked, the percentile, and the shop's own revenue.

**Why this priority**: "my rank" is the reason sellers return to the page; the revenue figure must reach members only.

**Independent Test**: seed boards, call `GET /shops/:shopId/rank` as a member and as a stranger.

**Acceptance Scenarios**:

1. **AS-24** (my rank) — **Given** week `2026-W41` with `B 10001`, `A 10000`, `C 500`, **When** a member (any role, including viewer) of shop `A` calls `GET /shops/A/rank?period=week`, **Then** `200 {period, category: null, rank: 2, of: 3, topPercent: 67, revenueMinor: 10000}` parsed by the contracts schema; with `category=accessories` in the AS-01 data it returns the shop's rank on that board; the rank is exact for every ranked shop.
2. **AS-25** (not ranked) — **Given** shop `C` has no sale in the requested board, **When** its member asks, **Then** `404 not_ranked`; the same for a category board without sales and for a period with no sales.
3. **AS-26** (tenant isolation and access) — **Given** a user who is not a member of shop `B`, **When** they call `GET /shops/B/rank`, **Then** `404 shop_not_found`, byte-identical (apart from `instance` and `requestId`) to the answer for a non-existing shop id and for a malformed id; no credentials → `401`; a member of a `SUSPENDED` shop gets `200`; a `DELETED` shop answers `404 shop_not_found`; no revenue of another shop is reachable by any route of this capability without membership.
4. **AS-27** (rank agrees with the top list) — **Given** 25 shops with distinct revenues, three of them tied on revenue and instant, **When** the top list (`limit=25`) and each shop's rank are read, **Then** every shop's `rank` equals its position in the list, and `of` is 25.
5. **AS-28** (rank in a frozen period) — **Given** week `2026-W40` frozen with 101 ranked shops, **When** the member of the shop at position 100 asks for `period=week&id=2026-W40`, **Then** `200` with `rank: 100`, `of: 101`, `topPercent: 100` and its frozen revenue; **When** the member of the shop at position 101 asks, **Then** `404 not_ranked` (the snapshot keeps the top 100 only).
6. **AS-29** (percentile, pure) — **Given** `rank` and `of`, **Then** `topPercent = max(1, ceil(rank / of × 100))`; table: `(1, 1) → 100`, `(1, 600000) → 1`, `(18342, 600000) → 4`, `(2, 3) → 67`, `(100, 101) → 100`, `(600000, 600000) → 100`.

7. **AS-30** (rank of a closed period that is not frozen yet) — **Given** week `2026-W40` closed at clock `T0` but not frozen, **When** a member of shop `A` asks `GET /shops/A/rank?period=week&id=2026-W40`, **Then** `200` from the live board with the shape of AS-24 (exact rank, `of`, `topPercent`, revenue); after the freeze (AS-31) the same call is answered from the snapshot (AS-28).

---

### User Story 4 — Closed periods are frozen as snapshots (Priority: P2)

When a week or month is over, the top 100 of every board is frozen so history stays stable even after the live data expires.

**Why this priority**: it is what makes "last week's winners" a fact rather than a moving number.

**Independent Test**: seed a closed week, run the snapshot job, read through US2/US3.

**Acceptance Scenarios**:

1. **AS-31** (snapshot after close) — **Given** week `2026-W40` with an overall board and boards `electronics` and `accessories`, 101 ranked shops on the overall board, and the clock at `2026-10-05T01:00:00Z` (period end plus 1 hour of grace), **When** the weekly job runs, **Then** for every board of the week the top 100 entries are stored with `{rank, shopId, shopName (as of that time), revenueMinor, participants}` (overall: 100 rows with `participants: 101`), the job reports `{periodId: "2026-W40", boards: 3, rows: <sum>}`; the same holds for month `2026-09` at `2026-10-01T01:00:00Z`.
2. **AS-32** (a period that is not closed is refused) — **Given** week `2026-W40` at `2026-10-05T00:59:59Z`, the current week `2026-W41`, a future week and a malformed id, **When** the snapshot is requested for each, **Then** each is refused with `period_not_closed` (or `invalid_period` for the malformed id), nothing is stored, and an existing snapshot is untouched.
3. **AS-33** (re-run, concurrent run, readers) — **Given** a stored snapshot of `2026-W40`, **When** the job runs again, then twice at once (`Promise.all`) while a reader polls the top list every few milliseconds, **Then** the stored rows are identical to the first run (exactly `min(100, participants)` per board, ranks `1..n` without gaps or duplicates) and the reader never sees an empty or partial list.
4. **AS-34** (catch-up) — **Given** the job did not run for two weeks so that `2026-W39` and `2026-W40` are closed and not frozen, **When** the next scheduled run happens, **Then** both are frozen, oldest first, and a period whose boards no longer exist in the board store is skipped with one warning and no rows.
5. **AS-35** (registration) — **Given** the worker boots three times, **Then** exactly two schedules exist (weekly: Monday `01:00` UTC; monthly: day 1 `01:00` UTC), and two worker replicas firing the same schedule run the job once.
6. **AS-36** (a snapshot is a historical record) — **Given** the snapshot of `2026-W40`, **When** shop `A` is renamed afterwards, **Then** the top list of that week still shows the name stored at snapshot time; **When** a shop was unknown to the read model at snapshot time, **Then** its snapshot name is `null` and the entry is kept.

---

### User Story 5 — A seller watches sales happen, live (Priority: P1)

During a flash sale a shop member sees the last minute of orders, units, revenue and checkout conversion update every second, plus a chart of today so far.

**Why this priority**: it is the capability's real-time showcase and the piece sellers watch during launches.

**Independent Test**: feed order events, subscribe to `shop:{id}:live`, call the "today" route.

**Acceptance Scenarios**:

1. **AS-37** (frame content) — **Given** shop `S`, clock at second `T`, four `order.reserved` events with `shopIds: [S]` and one paid order with a line `{S, quantity 2, lineTotalMinor 5000}`, all stamped second `T`, **When** the frame for `T` is computed, **Then** `{shopId: S, at: T (epoch seconds), windowSeconds: 60, last60s: {checkouts: 4, orders: 1, units: 2, revenueMinor: 5000}, ordersPerSecond: <60 numbers, oldest first, last = 1>, checkoutConversion: 0.25}`.
2. **AS-38** (several shops in one order) — **Given** a paid order with lines of shops `S1` (`lineTotalMinor 3000`, quantity 1) and `S2` (`2000`, quantity 3), and a reservation with `shopIds: [S1, S2, S1]`, **Then** `S1` has `orders 1, units 1, revenueMinor 3000, checkouts 1` and `S2` has `orders 1, units 3, revenueMinor 2000, checkouts 1` (a shop counts once per order and once per reservation).
3. **AS-39** (window edges) — **Given** frame second `T`, **When** events stamped `T − 59` and `T` exist, **Then** both are counted; an event stamped `T − 60` is not; an event stamped `T + 2` appears only in the frame of second `T + 2`; **When** an event older than 60 seconds at consumption time is delivered, **Then** it changes no live counter, the outcome counter `stale` is 1, and its sale still reaches the history of AS-46.
4. **AS-40** (conversion, pure) — **Given** `(checkouts, orders)`, **Then** `checkoutConversion = round(orders / checkouts, 3)` and `null` when `checkouts = 0`; table: `(0, 0) → null`, `(0, 3) → null`, `(4, 1) → 0.25`, `(3, 1) → 0.333`, `(3, 2) → 0.667`, `(1, 2) → 2` (the ratio is not capped, see Assumptions).
5. **AS-41** (counters are exactly-once and crash-safe) — **Given** the AS-37 events, **When** each is delivered again, and again ten times at once, **Then** every counter is unchanged; **Given** the counter store rejects the first attempt to apply an event (fault injected), **When** the event is redelivered, **Then** it is counted exactly once (the failed attempt left no "already seen" mark).
6. **AS-42** (a frame every second, only where someone watches) — **Given** a member subscribed to `shop:S:live`, **When** the ticker runs for seconds `T`, `T+1`, `T+2` (including seconds without any sale), **Then** exactly one `dashboard` frame per second arrives, `at` strictly increasing, and the frame decays to zeros once the sales leave the 60-second window; **Given** a shop without subscribers, **Then** no frame is computed for it (the "frames computed" counter does not move); a client that reconnects receives no earlier frames (no replay).
7. **AS-43** (one publisher per shop, failover) — **Given** two worker instances ticking at the same second for the same subscribed shop, **Then** exactly one frame is published for that second; **When** the instance that holds the shop stops, **Then** the other publishes frames for that shop within 5 seconds.
8. **AS-44** (a slow tick never piles up) — **Given** a tick still running when the next second starts, **When** the next tick is due, **Then** it is skipped (counter `ticks_skipped` +1), no two ticks of one instance overlap, and the next frame is correct for its own second.
9. **AS-45** (frames stay inside their shop) — **Given** members of shops `S1` and `S2` subscribed to their own topics and sales for both, **Then** each subscriber receives only frames whose `shopId` is its shop; a non-member's subscription is refused by the topic policy of S03 (AS-83 there).
10. **AS-46** (today chart) — **Given** clock `T0`, shop `S` with paid orders: `O1` (`paidAt 2026-10-06T11:58:30Z`, lines `1000` + `500` in one order, units 1 + 2 = 3), `O2` (`11:58:50Z`, `2000`, 1 unit), `O3` (`11:59:10Z`, `700`, 1 unit), `O4` (`2026-10-05T23:59:59Z`, `9999`), **When** a member calls `GET /shops/S/dashboard/today`, **Then** `200 {day: "2026-10-06", totals: {orders: 3, units: 5, revenueMinor: 4200}, series: [{minute: "2026-10-06T11:58:00Z", orders: 2, units: 4, revenueMinor: 3500}, {minute: "2026-10-06T11:59:00Z", orders: 1, units: 1, revenueMinor: 700}]}` (minutes ascending, only minutes with sales, the day is the UTC day, `O4` excluded), parsed by the contracts schema; delivering any of the orders again, or delivering the lines of one order in two separate batches, leaves every number unchanged.
11. **AS-47** (access to the dashboard routes) — **Given** the "today" route, **When** a stranger (not a member) calls it, **Then** `404 shop_not_found` identical to an unknown shop; no credentials → `401`; a malformed shop id → `404 shop_not_found`; a viewer, staff member and a member of a `SUSPENDED` shop get `200`; shop `S2`'s sales never appear in `S1`'s answer.
12. **AS-48** (analytics store down) — **Given** the analytics store is unreachable or exceeds its 3-second timeout, **When** a member calls "today" or "stats", **Then** `503 service_unavailable` with `Retry-After: 5` and a generic `detail` within 4 seconds; **and** live frames (AS-42) keep flowing because they use a different store.
13. **AS-49** (graceful shutdown) — **Given** a running ticker, **When** shutdown starts, **Then** the tick in progress finishes, no frame is published afterwards, and the process holds no shop lease (another instance takes over at once).

---

### User Story 6 — A seller reads shop stats (Priority: P2)

A shop member sees revenue, orders, units, unique buyers, refunds, a daily series and the top products over the last N days.

**Why this priority**: it is the analytical view; the numbers must be right and the source must be fed by every sale.

**Independent Test**: feed paid and refunded orders, call `GET /shops/:shopId/stats`.

**Acceptance Scenarios**:

1. **AS-50** (stats) — **Given** clock `T0`, shop `S` with paid orders `O1` (buyer `U1`, `2026-10-06T09:00Z`, lines `P1 × 1 = 3000` and `P2 × 2 = 2000`), `O2` (buyer `U1`, `2026-10-06T10:00Z`, `P1 × 1 = 1000`), `O3` (buyer `U2`, `2026-10-05T10:00Z`, `P1 × 1 = 3000`), and a full refund of `O3` on `2026-10-06T11:00Z`, **When** a member calls `GET /shops/S/stats?days=7`, **Then** `200` with `{shopId: S, days: 7, from: "2026-09-30", to: "2026-10-06", currency: "EUR", summary: {revenueMinor: 9000, orders: 3, unitsSold: 5, uniqueBuyers: 2, refundsCount: 1, refundedMinor: 3000, netRevenueMinor: 6000, avgOrderValueMinor: 3000}, daily: <7 entries, ascending, one per UTC day, zero-filled, {day, revenueMinor, orders, refundedMinor}>, topProducts: [{productId: P1, title, revenueMinor: 7000, unitsSold: 3}, {productId: P2, title, revenueMinor: 2000, unitsSold: 2}]}`; `daily` on `2026-10-05` is `{revenueMinor: 3000, orders: 1, refundedMinor: 0}`, on `2026-10-06` it is `{revenueMinor: 6000, orders: 2, refundedMinor: 3000}`; the body parses with the contracts schema; no buyer identity appears.
2. **AS-51** (validation) — **Given** the stats route, **When** `days` is `0`, `366`, `-1`, `abc`, `1.5`, empty, repeated, or an unknown parameter is sent, **Then** `400 validation_failed` naming the field; omitted `days` means 30; `1` and `365` are accepted.
3. **AS-52** (access and isolation) — **Given** a stranger, **Then** `404 shop_not_found` identical to an unknown shop; no credentials → `401`; a viewer gets `200`; shop `S2`'s orders never appear in `S1`'s stats.
4. **AS-53** (refunds) — **Given** paid order `O` with lines of `S1` (`3000`) and `S2` (`2000`), **When** `order.refunded {orderId: O, amountMinor: 5000}` is consumed, **Then** `S1`'s `refundedMinor` is `3000` and `S2`'s `2000` (each shop's recorded share), attributed to the refund's day; **When** it is delivered again (also at once), **Then** nothing changes; **When** a refund names an order with no recorded sale, **Then** it is retried with backoff and dead-lettered after 5 attempts with no effect; **When** `amountMinor` differs from the order's recorded total (a partial refund), **Then** it is dead-lettered with reason `partial_refund_unsupported` with no effect; refunds never change leaderboards or the live dashboard.
5. **AS-54** (a shop without sales) — **Given** a shop with no sale, **When** a member calls stats with `days=3`, **Then** `200` with all summary figures `0`, `avgOrderValueMinor: 0`, `daily` three zero entries, `topProducts: []`.
6. **AS-55** (every sale is counted once, and rebuildable) — **Given** the same paid order delivered three times, once after the analytics store compacted its data, and concurrently, **Then** stats, "today" and the live-independent history count it once; **When** the analytics store is emptied and the whole event log replayed in any order, **Then** stats and "today" are identical to before.
7. **AS-56** (average order value, pure) — **Given** `(revenueMinor, orders)`, **Then** `avgOrderValueMinor = floor(revenueMinor / orders + 0.5)` (half up) and `0` when `orders = 0`; table: `(0, 0) → 0`, `(9000, 3) → 3000`, `(10, 4) → 3` (2.5 → 3), `(10, 3) → 3`, `(11, 3) → 4`.
8. **AS-57** (window boundaries) — **Given** clock `T0` and orders at `2026-10-05T23:59:59Z` and `2026-10-06T00:00:00Z`, **When** `days=1`, **Then** only the second counts (`from = to = 2026-10-06`); **When** `days=2`, **Then** both count; an order at `2026-10-04T23:59:59Z` counts for `days=3` and not for `days=2`.

---

### User Story 7 — Read models, erasure and operability (Priority: P2)

The capability keeps its own copies of the shop names and product categories it needs, removes a deleted shop completely, and can be observed in production.

**Why this priority**: it keeps data ownership clean (IX) and keeps operators out of the dark.

**Independent Test**: deliver shop and product events, then run the boundary and metric checks.

**Acceptance Scenarios**:

1. **AS-58** (shop read model consumer) — **Given** `tenancy.shop_created {shopId A, name "Alpha", slug "alpha", shopVersion 1}` and `tenancy.shop_updated {name "Alpha Plus", slug "alpha", shopVersion 2}`, **When** delivered in the order 2, 1, 1, **Then** the model holds `Alpha Plus` / version 2 and no error occurs; a message with a missing `shopId` or a non-integer `shopVersion` is dead-lettered with no effect.
2. **AS-59** (product read model consumer) — **Given** `catalog.product_created {productId P1, shopId A, category "electronics", productVersion 1}`, `…_updated` version 3 with `category: "tablets"` and `…_updated` version 2, delivered in the order 3, 1, 2, 3, **Then** the model holds `tablets` / version 3; `catalog.product_deleted` with a higher version keeps the last category (past sales stay attributable); a message with a missing `productId` is dead-lettered with no effect.
3. **AS-60** (a deleted shop leaves every store) — **Given** shop `A` on live boards of two weeks and two months, in the frozen snapshot of `2026-W40` at rank 1 of 3, with dashboard counters and analytics history, **When** `tenancy.shop_deleted {shopId A}` is consumed, **Then** `A` is on no live board and has no revenue total, its snapshot rows are deleted and the remaining entries of that snapshot are renumbered `1..2`, its dashboard counters and analytics rows are gone, its read-model rows are gone; stats and "today" for `A` answer `404 shop_not_found` through the membership gate; other shops' figures are unchanged; delivering the event again changes nothing.
4. **AS-61** (observability) — **Given** the outcomes of AS-01, AS-02, AS-09, AS-10, AS-11 and AS-39, **Then** a counter `leaderboard_events_total{outcome}` has exactly the `applied`, `duplicate`, `sealed`, `rejected`, `category_unresolved` and `stale` increments stated in those scenarios (`applied`, `duplicate` and `sealed` count per event and period; `rejected` per message; `category_unresolved` per unresolved line; `stale` per event); the oldest-unprocessed-event age of each feed is exposed as a gauge; every log line of the feeds and of the ticker is structured JSON with `requestId` or `traceId` and contains no buyer id, e-mail, or payload body.
5. **AS-62** (data ownership, static) — **Given** the code of the domain, **Then** `pnpm --dir packages/backend check:table-ownership --strict` reports zero findings for `seller-insights` (no query, join, model injection or association touches a table owned by another domain), `pnpm check:boundaries` passes, and the domain's entry point exports no model and no projector class, only the modules the apps wire and the contracts' event types it consumes.

---

### Edge Cases

- **Delivery**: duplicates, concurrent duplicates, concurrent different orders of one shop, redelivery after a crash, replay in any order, events of other types on the same topic (AS-02, AS-03, AS-05, AS-10, AS-12, AS-41).
- **Time**: period boundaries and ISO year edge (AS-07); events for a closed but unfrozen period (AS-08); events for a frozen period (AS-09); stale and future-stamped live events (AS-39); UTC-only windows (AS-46, AS-57); snapshot due times and grace (AS-31, AS-32).
- **Ties**: equal revenue, equal instant, different resolutions per period kind (AS-04–AS-06); the same order on every read (AS-27).
- **Limits**: revenue ceiling of the ranking key (AS-13, AS-14); `limit` 1–100; `days` 1–365; top 100 frozen; public rate limit (AS-19, AS-21, AS-51, AS-28).
- **Security**: cross-tenant reads answer `404` (AS-26, AS-47, AS-52); public answers carry no revenue (AS-17); frames cannot cross shops (AS-45).
- **Failure**: board store down (AS-23); analytics store down (AS-48); limiter store down (AS-21); fault after a half-applied event (AS-13, AS-41); slow tick (AS-44); shutdown (AS-49).
- **Illegal state**: snapshot of an open, future or malformed period (AS-32); refund without a sale or a partial refund (AS-53); rename or category change with a stale version (AS-20, AS-59).
- **Data erasure**: a deleted shop (AS-60).

## Requirements *(mandatory)*

### Functional Requirements

**Boards and the feed that keeps them (US1)**

- **FR-001**: The capability MUST keep, for every ISO week and every calendar month (UTC), one overall board and one board per product category, ranking shops by the paid revenue of that period (AS-01, AS-07).
- **FR-002**: A shop's revenue from a paid order MUST be the sum of the order's `lineTotalMinor` over that shop's lines, in integer minor units of the platform currency; a line's category comes from the product category read model; a shop with revenue `0` MUST NOT appear on a board (AS-01, AS-15).
- **FR-003**: Every paid order MUST be applied exactly once per period, however many times, in whatever order, and by however many consumers at once it is delivered; the application of one order to all of its boards of one period MUST be atomic: all boards or none (AS-02, AS-03, AS-12, AS-13).
- **FR-004**: Ranking MUST be by revenue descending, then by the shop's latest sale instant ascending (resolution one second for weeks, one minute for months), then by shop id descending. The latest sale instant MUST NOT move backwards when an older sale is consumed later, so the final board is independent of delivery order (AS-04–AS-06, AS-12, AS-14).
- **FR-005**: A sale belongs to the week and month of its `paidAt` in UTC; a late event counts toward the period it happened in, unless that period is frozen, in which case it is acknowledged without being applied and counted as `sealed` (AS-07–AS-09).
- **FR-006**: The ranking key MUST support revenue up to `2^33 − 1` minor units per shop and period exactly; an order that would push a shop beyond it MUST be dead-lettered whole (AS-13, AS-14).
- **FR-007**: The feed MUST validate every message against the contracts schema before acting; invalid, unsupported-version or non-`EUR` messages MUST be dead-lettered with a reason code and no effect, and MUST NOT block later messages; messages of other types are ignored (AS-10).
- **FR-008**: Product categories MUST come from a read model owned by this capability, fed by the catalog's product snapshot events with a version guard; a sale of a product with no known category counts on the overall board only; categories are not re-attributed afterwards; a deleted product keeps its last category (AS-11, AS-59). **Mechanism: IX.7 R3.**
- **FR-009**: Boards are derived data, never the source of truth: replaying the order events from the start, in any order and with duplicates, MUST rebuild every board identically (AS-12).
- **FR-010**: Every stored board key MUST expire at the period end plus 35 days (AS-16).
- **FR-011**: Maximum staleness: a paid order is on the boards within 5 seconds at the 99th percentile under normal load (see SC-002).

**Public top list (US2)**

- **FR-012**: `GET /leaderboards` (no credentials) MUST return the top entries of one board: `period` (`week` default or `month`), `id` (a period id of that kind; default the current one), `category` (optional, normalised case-insensitively), `limit` (1–100, default 20). Each entry MUST carry only `rank`, `shopId`, `slug`, `name`. It MUST NOT carry revenue or any user identifier (AS-17, AS-18).
- **FR-013**: Invalid selectors MUST answer `400 validation_failed`; a period after the current one MUST answer `422 period_in_future`; an unknown but well-formed category answers `200` with no entries (AS-18, AS-19).
- **FR-014**: Shop names and slugs MUST come from a read model owned by this capability, fed by the tenancy shop events with a version guard; a shop without a row is shown with `name: null` and `slug: null` and keeps its rank (AS-20, AS-58). **Mechanism: IX.7 R3.**
- **FR-015**: The public endpoint MUST be rate limited per client address (policy `seller-insights.leaderboard-read.ip`, 60 per minute, fail open) with `429 rate_limited` and `Retry-After` (AS-21).
- **FR-016**: Once a period is frozen, reads of it MUST come from the snapshot only (`source: "snapshot"`), with long public caching; otherwise from the live board (`source: "live"`) with `public, max-age=10, s-maxage=30`. When the live store is unreachable, current and unfrozen periods MUST answer `503` and frozen periods MUST still answer (AS-17, AS-22, AS-23).
- **FR-017**: The top list is a bounded ranking (at most 100 entries), not a growing list, so it has no cursor.

**My rank (US3)**

- **FR-018**: `GET /shops/:shopId/rank` (shop-scoped, permission `shop.read`) MUST return `{period, category, rank, of, topPercent, revenueMinor}` with the same selectors as FR-012 (except `limit`); `rank` is exact; `topPercent = max(1, ceil(rank / of × 100))` (AS-24, AS-29).
- **FR-019**: A shop with no revenue on the board MUST get `404 not_ranked`; in a frozen period only the top 100 are known, others get `404 not_ranked` (AS-25, AS-28).
- **FR-020**: Non-members, unknown, malformed and deleted shops MUST be indistinguishable (`404 shop_not_found`); a shop's revenue MUST never be returned to a non-member (AS-26).
- **FR-021**: The rank of a shop MUST equal its position in the top list of the same board at the same moment (AS-27).

**Snapshots (US4)**

- **FR-022**: One hour after a period ends, the top 100 of each of its boards MUST be frozen as `{period, category, rank, shopId, shopName, revenueMinor, participants}`; weekly job Monday `01:00` UTC, monthly job on day 1 `01:00` UTC (AS-31, AS-35).
- **FR-023**: Freezing MUST be idempotent and atomic per board: a re-run or concurrent run leaves exactly one consistent set and readers never see an empty or partial one (AS-33).
- **FR-024**: Freezing a period that is not yet closed (before end plus 1 hour), a future period or a malformed id MUST be refused and change nothing (AS-32).
- **FR-025**: Each run MUST also freeze every closed, unfrozen period that still has boards (catch-up) (AS-34).
- **FR-026**: A snapshot stores the shop name as of snapshot time and is never re-written by later renames (AS-36). Snapshots are kept indefinitely.
- **FR-027**: Schedules MUST be registered idempotently and run once per schedule across replicas (AS-35).

**Live dashboard (US5)**

- **FR-028**: For every shop the capability MUST keep per-second counters of checkouts started (from `order.reserved`, once per shop per reservation), orders, units and revenue (from `order.paid`, once per shop per order), keyed by the event's own second and kept long enough to serve a 60-second window (AS-37, AS-38).
- **FR-029**: Counter updates MUST be exactly-once per event and at-least-once safe: the "already seen" mark and the increments of one event are one atomic step, so a failed attempt can be retried (AS-41).
- **FR-030**: Events older than 60 seconds at consumption time MUST NOT change live counters (they still reach analytics) (AS-39).
- **FR-031**: Once per second, for every shop that has at least one subscriber to `shop:{shopId}:live`, and only for those, exactly one `dashboard` frame MUST be published, without replay: `{shopId, at, windowSeconds: 60, last60s: {checkouts, orders, units, revenueMinor}, ordersPerSecond[60], checkoutConversion}` (AS-37, AS-42).
- **FR-032**: Several worker instances MUST share the shops (one lease per shop); a stopped holder is replaced within 5 seconds; an overrunning tick is skipped, not overlapped; shutdown completes the tick in progress and releases leases (AS-43, AS-44, AS-49).
- **FR-033**: Subscription to `shop:{shopId}:live` is allowed only for members of the shop (policy of S03); frames of one shop MUST never reach another shop's subscribers (AS-45).
- **FR-034**: `GET /shops/:shopId/dashboard/today` (permission `shop.read`) MUST return the UTC day's totals and the per-minute series from the analytics store; the numbers MUST be exact under redelivery, replay and multi-batch orders (AS-46, AS-47, AS-55).
- **FR-035**: Dashboards MUST never count rows of the order tables for a viewer's refresh.
- **FR-036**: Both analytics routes MUST answer `503` with `Retry-After` and a generic detail when their store is down or slower than 3 seconds; live frames MUST be independent of it (AS-48).

**Seller stats (US6)**

- **FR-037**: `GET /shops/:shopId/stats?days=N` (permission `shop.read`; `N` 1–365, default 30) MUST return `{shopId, days, from, to, currency, summary, daily, topProducts}` for the `N` UTC calendar days ending today (AS-50, AS-51, AS-57).
- **FR-038**: `summary` MUST hold `revenueMinor`, `orders`, `unitsSold`, `uniqueBuyers`, `refundsCount`, `refundedMinor`, `netRevenueMinor`, `avgOrderValueMinor` (half-up rounding, `0` without orders); `daily` MUST have one zero-filled entry per day; `topProducts` the 5 best by gross revenue (ties by product id ascending) with the product title as recorded on the sale (AS-50, AS-54, AS-56).
- **FR-039**: Every paid order MUST feed the sales history that stats and "today" read; a full refund MUST be recorded against each shop's recorded share and refund day; a partial refund, or a refund without a recorded sale, MUST NOT change anything (AS-53, AS-55).
- **FR-040**: `uniqueBuyers` is exact up to 1,000 distinct buyers and within 2% above; responses never contain a buyer identifier.
- **FR-041**: Maximum staleness of "today" and stats: 30 seconds at the 99th percentile.

**Data ownership, privacy, operations (US7)**

- **FR-042**: The capability MUST read no table or model of another domain and consume other domains' data only through IX.7 mechanisms: shop names and product categories by **R3** (events into its own read models), order facts by **R3** (events into its boards, counters and analytics history), membership by **R1** (`ShopAccessService` through the shop-scoped gate); screens that combine its data with other domains' (stock left, shop details) are **R2** compositions in `libs/composition` (AS-62).
- **FR-043**: On `tenancy.shop_deleted` the capability MUST remove every trace of the shop from boards, snapshots (renumbering the rest), counters, analytics history and read models, idempotently (AS-60).
- **FR-044**: Every response MUST go through an explicit response schema in `packages/contracts`; errors are problem+json from the global filter; no 5xx exposes store hosts, commands, SQL or stack traces (AS-17, AS-23, AS-48).
- **FR-045**: Every outbound call to a store sets an explicit timeout (board store 500 ms, analytics store 3 s) and is retried at most once on transient failure on reads, never in the feeds' hot path beyond the framework's redelivery (AS-23, AS-48).
- **FR-046**: Outcome counters, feed lag gauges, tick counters and structured logs MUST exist as in AS-61.
- **FR-047**: Feeds document their idempotency mechanism: boards by a per-period set of applied order ids; counters by a short-lived per-event mark applied atomically with the increments; analytics history by a unique key on `(orderId, productId)`; read models by a version-guarded upsert.

### Key Entities

- **Board**: one ranking (period × overall-or-category): entries of shop, revenue, latest sale instant. Derived, expiring, rebuildable.
- **Period**: an ISO week or calendar month in UTC with an id (`2026-W41`, `2026-10`), start, exclusive end, `closed` flag, and a frozen flag.
- **Leaderboard snapshot**: the frozen top 100 of a board: rank, shop, shop name at that time, revenue, participants.
- **Shop read model**: the shop's name, slug and version, copied from tenancy events.
- **Product category read model**: the product's shop, category and version, copied from catalog events.
- **Live counter**: per shop and second: checkouts, orders, units, revenue; short-lived.
- **Dashboard frame**: the last-60-seconds view pushed once per second.
- **Sale fact**: one row per paid order line of a shop: order, shop, product, title, buyer, units, revenue, time; refund facts by shop and order.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In a replay test of 200 mixed events, 100% of boards equal the recorded boards after an emptied-store rebuild in random order with duplicates (AS-12).
- **SC-002**: A paid order appears on the boards and in the live counters within 5 seconds for 99% of orders, and in "today" and stats within 30 seconds for 99%.
- **SC-003**: A seller's live panel changes within 2 seconds of a payment for 99% of payments while someone is watching.
- **SC-004**: Zero double-counted orders and zero lost updates across 1,000 redeliveries and 50 concurrent orders in the tests (AS-02, AS-03, AS-41).
- **SC-005**: The public top list answers 99% of requests in under 100 ms at 50,000 requests per second (cached) and never exposes a shop's revenue.
- **SC-006**: 100% of cross-shop reads answer `404` and 100% of frames reach only their shop's members.
- **SC-007**: A frozen period never changes after it is frozen: 0 differences between the snapshot and later reads.
- **SC-008**: A shop deletion leaves 0 rows, entries or counters of the shop in any store of the capability.
- **SC-009**: A dashboard viewer causes no load on the order database: 0 queries against order tables per viewer refresh.

## Assumptions

- **Ranking by gross paid revenue.** Refunds do not change leaderboards or live counters; they appear in seller stats only (the order refund event carries no line split, and S10 lists only `order.paid` as S40's input for ranking). Gaming through refunds is a known limit, see questions.
- **Platform currency is `EUR`.** Events in another currency are dead-lettered rather than summed.
- **Weekly and monthly periods are UTC**, one global calendar for every viewer; "today" is the UTC day.
- **Boards live in a fast store**, are derived data, and are rebuilt by replay (IX.7 R3); the exact sales history for stats and "today" lives in an analytics store, also fed by the same events.
- **Frozen = top 100.** Exact rank and percentile are served for every shop while the period is live (the exact method suffices at showcase scale; the approximate-percentile fallback for very large boards in the notes is not built). Ranks beyond 100 in a frozen period are unavailable.
- **Hiding suspended shops from public boards** is not built; deletion is handled (FR-043).
- **Conversion** is the ratio of orders to checkouts in the same 60-second window and may exceed 1; it is a live indicator, not a cohort metric.
- **Staleness accepted** (IX.7 R3): boards and counters 5 s, shop and product read models 30 s, analytics 30 s (all at the 99th percentile).
- **Stock left** in the notes' launch dashboard is shown by the client through an R2 composition, not by this capability.
- **No pagination** on the top list (bounded at 100), so III.10 does not apply.
- **This capability emits no events**; none is required by any listed consumer.
- **Late-category reconciliation, partial-refund attribution and moderation filtering** are future work.
- **Pattern P0323 (sorted-set boards)** is specified behaviourally: one ranked board per period and category, incremental updates (FR-003), top-k read and exact rank (FR-012, FR-018, FR-021), per-period expiry (FR-010), tie-breaking encoded in the ranking key (FR-004, FR-006, AS-14) and snapshots at period end (FR-022). The store choice is the plan's, not the spec's.
- Every default above is also a line in `questions.md`.

## Cross-capability contracts

### Provides

- **HTTP `GET /leaderboards`** (anonymous; rate limit policy `seller-insights.leaderboard-read.ip`) → `leaderboardPageSchema`: `{period: {kind: "week"|"month", id, startsAt, endsAt, closed}, category: string | null, source: "live"|"snapshot", generatedAt, entries: [{rank, shopId, slug: string|null, name: string|null}]}`; query `period`, `id`, `category`, `limit`. Guarantee: no revenue; ranks `1..n`; ≤ 100 entries; boards within 5 s of the sale (p99). **Consumers: public web pages (later web capability), J02.**
- **HTTP `GET /shops/:shopId/rank`** (`ShopScoped('shop.read')`) → `shopRankSchema`: `{period, category: string|null, rank, of, topPercent, revenueMinor}`; errors `404 not_ranked`, `404 shop_not_found`. **Consumers: W04, J02** (J02 may poll until `200`, at most 10 s after payment).
- **HTTP `GET /shops/:shopId/dashboard/today`** (`ShopScoped('shop.read')`) → `dashboardTodaySchema`: `{day: "YYYY-MM-DD", totals: {orders, units, revenueMinor}, series: [{minute: ISO-8601 UTC, orders, units, revenueMinor}]}`. **Consumer: W04.**
- **HTTP `GET /shops/:shopId/stats?days=`** (`ShopScoped('shop.read')`) → `sellerStatsSchema`: `{shopId, days, from, to, currency, summary: {revenueMinor, orders, unitsSold, uniqueBuyers, refundsCount, refundedMinor, netRevenueMinor, avgOrderValueMinor}, daily: [{day, revenueMinor, orders, refundedMinor}], topProducts: [{productId, title, revenueMinor, unitsSold}]}`. **Consumer: W04.** Replaces `GET /sellers/me/stats`.
- **Realtime topic `shop:{shopId}:live`**, event name `dashboard`, payload `liveDashboardFrameSchema`: `{shopId, at, windowSeconds: 60, last60s: {checkouts, orders, units, revenueMinor}, ordersPerSecond: number[60], checkoutConversion: number | null}`; one frame per second per subscribed shop; no replay. The topic prefix `shop`, suffix `live` and the member-only subscription policy are registered by tenancy (S03 AS-83); this capability only publishes. **Consumer: W04.**
- No R1 export, no event, no outbox row. The domain's entry point exports only its modules (core, worker, projector) for the apps.

### Requires

- **S10 (`orders`)**, topic `orders.events`, key `orderId`, envelope `{eventId, type, version: 1, occurredAt, aggregateId}`:
  - `order.paid` `{orderId, userId, totalMinor, currency, paymentRef, paidAt, lines: [{productId, shopId, title, quantity, unitPriceMinor, discountMinor, lineTotalMinor}], shopOrders: [{shopOrderId, shopId, subtotalMinor}], orderVersion}`: `shopId` non-null, `currency` `EUR`.
  - `order.reserved` `{orderId, userId, totalMinor, currency, shopIds: ShopId[], reservedUntil, orderVersion}`.
  - `order.refunded` `{orderId, userId, amountMinor, currency, reason, orderVersion}`, emitted only for a full refund, after `order.paid` of the same order (same key, same partition).
  - S10 currently lists S40 as consumer of `order.paid` only; S40 adds `order.reserved` and `order.refunded` (no payload change).
- **S05 (`catalog`)**, topic `products.events`, key `productId`: `catalog.product_created|updated|archived|restored` with `{productId, shopId, category, productVersion, …}` and `catalog.product_deleted` `{productId, shopId, productVersion}`.
- **S03 (`tenancy`)**, tenancy events keyed by `shopId`: `tenancy.shop_created` `{shopId, ownerId, name, slug, plan, region, shopVersion}`, `tenancy.shop_updated` `{shopId, name, slug, shopVersion}`, `tenancy.shop_deleted` `{shopId}`; guard `ShopScoped(permission)` with the status gate and `404 shop_not_found` for non-members (S03 AS-09, AS-12, FR-011); `ShopAccessService.assertMember(shopId, userId, permission?)` (R1) for the topic policy; the registration of topic prefix `shop` with suffix `live` and the realtime policy of S03 AS-83 for `shop:<id>:live` (members of `ACTIVE` or `SUSPENDED` shops), already in tenancy's realtime topics. S40 does not call `ShopQueryService.getShopsByIds`: names come from its R3 model.
- **S01 (`identity`)**: `Firewall({ anonymous? })`, `@User()`, `AuthenticatedUser = {id, role, sessionId, amr}`.
- **S51 (realtime)**: `publish(topic, event, payload, { replay: false })`; a way to list the `shop:*:live` topics that currently have at least one subscriber (`topicsWithSubscribers(prefix, suffix): Promise<string[]>`).
- **S53 (events and projections)**: the projector framework (versioned envelope, zod validation before acting, DLQ with reason code, replay, per-message retry with backoff, redelivery after a thrown error).
- **S49 (job scheduler)**: `upsertSchedule`, `@JobHandler`, one run per schedule across replicas, UTC cron.
- **S50 (rate limiter)**: policy registration with a fail-open mode and `429` with `Retry-After`.
- **S54 (platform toolkit)**: global problem+json filter, request context, health probes, graceful shutdown.
