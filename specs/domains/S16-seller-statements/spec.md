# Feature Specification: S16 — Seller Statements: Bitemporal Commission Rates, Monthly Statements, Period Close, Adjustments, As-Of Reports, CSV Export (domain `statements`)

**Feature Branch**: `S16-seller-statements` (spec directory `specs/domains/S16-seller-statements`)

**Created**: 2026-10-05

**Status**: Draft

**Input**: User description: "Bitemporal commission rates, monthly statements, period close, adjustments, as-of reports, CSV export (domain `statements`)". Sources: `docs/showcase/sections/SD-41-payout-statements-as-of.md`, Interview-Prep `03-Databases/03-schema-migrations-and-scaling.md` §7 (temporal data, bitemporal modelling, snapshots), `10-System-Design/02-worked-examples.md` Example 5 (period snapshots, adjustment rows, reconciliation, golden datasets), `06-Distributed-Systems/02-consistency-sagas-and-data-sync.md` §5 (period close), `02-Node.js/02-streams-and-backpressure.md` §4.1 (streamed export); pattern-map rows P0207 (streams and backpressure), P0321 (temporal / bitemporal data), P0614 (reconciliation and period close); constitution v3.1.0 (III, IV, V, VII, VIII, IX, X).

## Scope

Sellers pay the marketplace a commission on every sale. That commission changes over time, and sometimes the decision is taken after the fact ("the electronics fee is 7% since March 1st, decided on April 5th"). Sellers and finance ask two different questions about the same month: "what was my March statement **as we knew it on April 1st**?" and "what **should** March have been, given what we know now?". A month that has been closed and shown to a seller never changes silently: later knowledge arrives as visible **adjustments** booked in the month that is open at that moment.

In scope:

- **Bitemporal commission rates**: a rate per shop and category (and a marketplace default) with two time axes, the period in which the rate is true in the real world and the period in which the platform believed it. Setting a rate never overwrites history. Overlapping current beliefs are impossible. Rates are looked up "as of a date, as known at an instant".
- **Monthly statements**: per shop and UTC calendar month: gross sales, commission, net, number of sale lines, payouts paid, priced line by line with the rate that applied at the sale instant. Open months are computed live, closed months are served from a frozen snapshot, and any month can be shown **as known at** an earlier instant.
- **Period close**: a monthly job that freezes every shop's statement, in a fixed order, only when the month's facts are complete, resumable, batched, once per month across replicas.
- **Adjustments**: every later correction (a retroactive rate change, a sale or payout that arrives after the close) becomes an adjustment row referencing the original month and booked in the open month, so closed numbers never change and the corrected numbers are always derivable.
- **Facts in**: sale lines, paid payouts and ledger sale journals are copied into this domain's own store from other domains' events (R3), idempotently, version-guarded, rebuildable by replay.
- **Streamed CSV export** of a statement's lines with back-pressure, formula-injection-safe text cells and bounded concurrency.
- **Reconciliation**: closed statements are checked against the ledger's facts and against a fresh recomputation; differences become findings and alerts and are never auto-corrected.
- **Operator API** for rates, accounting periods and findings, and the seller API for statements.
- **Finance retention rules** that S10, S14 and S15 defer to this capability.

Out of scope (owners named):

- The ledger, balances, journals and the daily provider reconciliation → **S14**. Payouts and transfers → **S15**. Orders, checkout, refunds → **S10** / **S13**. This capability only copies facts from their events.
- Refunds, chargebacks and cancellations after payment are **not** reflected in statements in this version (no event carries a per-shop refund allocation, see `questions.md`).
- Shops, roles, the `payouts.read` permission → **S03**. Authentication and the admin role → **S01**. Jobs → **S49**, outbox/consumers → **S53**, rate limiter → **S50**, problem+json, idempotency facility, clock, config, metrics, shutdown → **S54**.
- Tax, VAT, invoices to sellers (subscription invoices are **S17**), multi-currency (one currency, `EUR`), seller-facing rate editing, a rate-negotiation workflow, heavy analytical dashboards (**S40**).
- The seller's statement screen: the web capability that owns the seller dashboard and journey **J01** (this capability provides the API; see `questions.md` for the surface decision).

Cross-domain data used (IX.7): sale lines by **R3** (`order.paid`, S10), paid payouts by **R3** (`payout.paid`, S15), ledger sale facts by **R3** (`ledger.journal_posted`, S14), shop access by **R1** (`ShopScoped`, S03), shop existence for shop-specific rates by **R1** (`ShopQueryService.getShopsByIds`, S03). **R2 is not used.** The sale-fact store, rates, snapshots, adjustments and periods are this domain's own data. This domain never reads another domain's tables.

## User Scenarios & Testing *(mandatory)*

Notation: money is integer minor units (`30500` = 305.00 EUR) in `…Minor` fields; currency `EUR`. "At `T`" means the injected clock reads `T`. Months are UTC calendar months written `YYYY-MM`. The marketplace default rate is `1000` basis points (10%) for every category from the beginning of time (`initial default`). **Commission of a line** = `floor((lineTotalMinor × rateBps + 5000) / 10000)` (half up, per line, then summed).

**Dataset DS-1** (used throughout). Shop `a`, March 2026 sales, every line paid at `2026-03-15T12:00:00Z`: order `o1` line `l1` electronics `10000`, order `o2` line `l2` electronics `20000`, order `o3` line `l3` books `500` (quantity 1, no discount). At 10%: shop `a` has `grossMinor 30500`, `commissionMinor 3050` (`1000 + 2000 + 50`), `netMinor 27450`, `lineCount 3`. Shop `b`, March, one line `l5` electronics `4005` paid `2026-03-20T09:00:00Z`: `grossMinor 4005`, `commissionMinor 401` (`400.5` rounds up), `netMinor 3604`, `lineCount 1`. Shop `c` has no sales. **DS-1 closed** means March was closed by a run started at `2026-04-02T02:00:00Z`, so the snapshot's `knowledgeCutoff` is that instant. **RC1** is the operator change made at `2026-04-05T09:00:00Z`: shop `a`, category `electronics`, `700` bps, valid from `2026-03-01T00:00:00Z`, reason `promo-2026-03`. After RC1, shop `a`'s March recomputed commission is `2150` (`30000 × 7% + 50`), so the correction is `-900`.

### User Story 1 — Commission rates keep every belief ever held (Priority: P1)

Finance sets rates, including rates that reach back in time. The platform must always be able to say what rate applied on any date, and what it believed that on any earlier day.

**Why this priority**: every statement number depends on a rate lookup; a rate history that can be overwritten makes every audit answer unreliable.

**Independent Test**: set, supersede and look up rates through the operator API and read the persisted history.

**Acceptance Scenarios**:

1. **AS-01** (set a rate) — **Given** an admin and the clock at `2026-04-01T09:00:00Z`, **When** they `POST /admin/commission-rates` with `Idempotency-Key: k1` and `{shopId: a, category: "electronics", rateBps: 700, validFrom: "2026-03-01T00:00:00Z", reason: "promo-2026-03"}`, **Then** `201` with `{changeId, shopId: a, category: "electronics", rateBps: 700, validFrom: "2026-03-01T00:00:00Z", validTo: null, recordedAt: "2026-04-01T09:00:00Z", changed: true, affectedClosedMonths: []}` (parses with the contracts schema); one new current belief exists for shop `a` / `electronics` valid `[2026-03-01, ∞)` recorded `[2026-04-01T09:00:00Z, ∞)` with the admin's ID and the reason; every other rate row is untouched.
2. **AS-02** (as-of lookup on both axes) — **Given** default `electronics` = `800` valid from `2026-01-01`, recorded at `2026-01-01T00:00:00Z`, then at `2026-04-10T00:00:00Z` a change to `750` valid from `2026-06-01`, **When** an admin calls `GET /admin/commission-rates/as-of?category=electronics&validAt=…&knownAt=…`, **Then**: `validAt=2026-07-01, knownAt=2026-04-01` → `800`; `validAt=2026-07-01, knownAt=now` → `750`; `validAt=2026-03-01, knownAt=now` → `800` (the uncovered remainder survived); `validAt=2025-12-01, knownAt=now` → `1000` with `rule: "default_any"`. Each answer carries `{rateBps, rule, recordedFrom, validFrom, validTo}` of the row used.
3. **AS-03** (history is never rewritten) — **Given** AS-02, **When** the history for default `electronics` is read, **Then** exactly three beliefs exist: the original `800` `[2026-01-01, ∞)` now recorded `[2026-01-01, 2026-04-10)`; the remainder `800` `[2026-01-01, 2026-06-01)` recorded `[2026-04-10, ∞)`; and `750` `[2026-06-01, ∞)` recorded `[2026-04-10, ∞)`. No belief changed except the closing of one recorded period.
4. **AS-04** (precedence) — **Given** rates: shop `a`+`electronics` `700`, shop `a`+`*` `900`, default+`electronics` `800`, default+`*` `1000`, all valid and current, **Then** lookups give: (`a`, `electronics`) → `700` `shop_category`; (`a`, `books`) → `900` `shop_any`; (`b`, `electronics`) → `800` `default_category`; (`b`, `books`) → `1000` `default_any`. A rate is valid for `validFrom ≤ t < validTo`: a sale at exactly `validFrom` gets the new rate, at exactly `validTo` the next one.
5. **AS-05** (the store refuses overlap) — **Given** a current belief for shop `a` / `x` valid `[2026-01-01, 2026-03-01)`, **When** a privileged write inserts a second current belief for the same shop and category valid `[2026-02-01, ∞)`, **Then** the store rejects it with an exclusion violation and nothing is inserted: no application check is involved.
6. **AS-06** (concurrent writers) — **Given** two admins, **When** at the same moment they set different rates for the same shop and category over overlapping ranges (`Promise.all`, different `Idempotency-Key`s), **Then** both answer `201`, in some serial order; afterwards no two current beliefs overlap, the later recorded change owns the overlap, both changes are in the history, and their recorded instants differ.
7. **AS-07** (strictly increasing record instants) — **Given** the clock frozen, **When** two changes to one shop and category are recorded at the same instant, **Then** the second is recorded at least one microsecond later, so every superseded belief has a non-empty recorded period.
8. **AS-08** (no-op change) — **Given** shop `a` / `electronics` already `700` valid `[2026-03-01, ∞)`, **When** the same rate and range is posted with a new key, **Then** `200` with `changed: false`, no row written, no job queued, no event.
9. **AS-09** (validation) — **When** the body has `rateBps` of `-1`, `10001`, `7.5` or `"7"`; a `category` that is empty, longer than 64 characters or only whitespace; `validTo` not after `validFrom`; `validFrom` not an ISO-8601 instant with an offset; an empty or 201-character `reason`; a `shopId` that is not a UUID; an unknown field, **Then** `400 validation_failed` (`422 rate_range_invalid` for the range case), and no row is written; **When** `shopId` names no shop, **Then** `404 shop_not_found`.
10. **AS-10** (the default rate never develops a hole) — **Given** the default rate `*` `1000` valid for all time, **When** an admin sets default `*` valid only `[2026-01-01, 2026-06-01)`, **Then** `422 default_rate_gap` and nothing changes; shop-level rates may leave gaps (lookups fall back by AS-04).
11. **AS-11** (who may write) — **When** there are no credentials, **Then** `401`; **When** a shop owner calls `POST /admin/commission-rates`, **Then** `403 permission_denied` and nothing changes; **When** an admin does, **Then** `201`. The same split holds for every `GET /admin/…` route.
12. **AS-12** (idempotency) — **Given** AS-01's request and key, **When** it is replayed with the same body, **Then** the stored `201` and body return with `Idempotency-Replayed: true` and one change exists; **When** the same key is used while the first request is still running, **Then** `409 idempotency_in_flight`; **When** the same key is used with a different body, **Then** `422 idempotency_key_reuse`; **When** the header is missing, **Then** `422 idempotency_key_required`.
13. **AS-13** (history and as-of reads) — **Given** 45 beliefs, **When** an admin calls `GET /admin/commission-rates?shopId&category&limit=20&cursor`, **Then** pages of 20, 20, 5 ordered by `recordedFrom` descending then `id` descending, with `nextCursor` null on the last; `limit=101` and a tampered cursor → `400 validation_failed` / `400 invalid_cursor`; `GET …/as-of` with `knownAt` in the future → `422 known_at_in_future`.

### User Story 2 — A seller reads any month, as it is now or as it was known (Priority: P1)

A seller opens a month and sees gross sales, commission and net, line count and payouts paid. For a closed month the numbers are exactly what was closed, with corrections shown beside them. For any month they can ask for the figures as known on an earlier date.

**Why this priority**: this is the product surface of the capability.

**Independent Test**: seed DS-1, read open, closed and as-known-at statements, and try every wrong principal.

**Acceptance Scenarios**:

1. **AS-14** (open month, live) — **Given** DS-1 and the clock at `2026-03-20T10:00:00Z` (March open), **When** a member with `payouts.read` calls `GET /shops/a/statements/2026-03`, **Then** `200` with `status: "OPEN"`, `source: "live"`, `own: {grossMinor: 30500, commissionMinor: 3050, netMinor: 27450, lineCount: 3, payoutsPaidMinor: 0}`, `total` equal to `own`, empty adjustment lists, `unpricedLineCount: 0`, `currency: "EUR"`, `knownAt` equal to the clock, `dataAsOf` equal to the ingestion watermark; the body parses with the contracts schema; nothing is written.
2. **AS-15** (closed month, from the snapshot) — **Given** DS-1 closed, **When** the same call is made for `2026-03`, **Then** `status: "CLOSED"`, `source: "snapshot"`, `own` identical to AS-14, `knownAt` equal to the snapshot's cutoff `2026-04-02T02:00:00Z`, `dataAsOf: null`, and zero reads of the sale-fact store or the rates were made.
3. **AS-16** (closed month with a correction) — **Given** DS-1 closed and RC1 processed, **When** the `2026-03` statement is read, **Then** `own` is unchanged (`commissionMinor: 3050`); `adjustmentsReferencing` has one entry `{refersToMonth: "2026-03", bookedMonth: "2026-04", causeKind: "rate_change", commissionDeltaMinor: -900, grossDeltaMinor: 0, lineCountDelta: 0, payoutsPaidDeltaMinor: 0, reason: "promo-2026-03"}`; `corrected` is `{grossMinor: 30500, commissionMinor: 2150, netMinor: 28350, lineCount: 3, payoutsPaidMinor: 0}`; `total` equals `own` (nothing was booked into March).
4. **AS-17** (the open month carries the adjustment) — **Given** AS-16 and the clock at `2026-04-20T10:00:00Z` with no April sales, **When** `2026-04` is read, **Then** `own` is all zeros, `adjustmentsBooked` has the same entry as AS-16, and `total.commissionMinor` is `-900`, `total.netMinor` is `900`.
5. **AS-18** (as known at an instant) — **Given** DS-1 closed and RC1 recorded at `2026-04-05T09:00:00Z`, **When** `GET /shops/a/statements/2026-03?knownAt=2026-04-01T00:00:00Z`, **Then** `source: "as_known_at"`, `knownAt: "2026-04-01T00:00:00Z"`, `own.commissionMinor: 3050`, both adjustment lists empty, `total` and `corrected` equal to `own`; **When** `knownAt=2026-04-06T00:00:00Z`, **Then** `own.commissionMinor: 2150`.
6. **AS-19** (facts have a recorded time too) — **Given** a March sale `l4` (books, `1000`, paid `2026-03-31T23:58:00Z`) whose event occurred then but was applied only on `2026-04-03`, **When** the March statement is read as known at `2026-03-31T23:59:00Z` and at `2026-04-04T00:00:00Z`, **Then** the first includes `l4` (event time is the recorded time, so a replay gives the same answer) and the second as well, and the statement as known at `2026-03-31T23:00:00Z` excludes it; no answer depends on when the event was applied.
7. **AS-20** (`knownAt` validation) — **When** `knownAt` is `yesterday`, `2026-04-01` (no time or offset), an empty value or 40 characters of garbage, **Then** `400 validation_failed`; **When** it is in the future, **Then** `422 known_at_in_future`; **When** it precedes every fact and rate, **Then** `200` with all-zero totals; no request changes state.
8. **AS-21** (empty, future and out-of-range months) — **Given** shop `c` with no sales, **When** `GET /shops/c/statements/2026-03`, **Then** `200` with all zeros; **When** the month is later than the current UTC month or before `2020-01`, **Then** `422 month_not_available`; **When** it is `2026-13`, `2026-00`, `2026-3`, `202603`, `2026-03-01`, `abc` or longer than 7 characters, or `shopId` is not a UUID, **Then** `400 validation_failed` and the stores are not queried.
9. **AS-22** (months list) — **Given** a shop with 14 snapshots and an open month, **When** `GET /shops/a/statements?limit=12&cursor`, **Then** pages of 12 and 3 (the open month first), newest first, each `{month, status, total}`; `limit=37` and a tampered cursor → `400`; every item equals what the single-month read returns.
10. **AS-23** (cross-tenant and permissions) — **Given** a member of shop `b` and DS-1, **When** they call each of the three seller routes (statement, list, CSV) for shop `a`, **Then** `404 shop_not_found` with the same body as for a shop that does not exist, and no data of `a` appears; **Given** a member of `a` per role (owner, admin, staff, viewer), **Then** owner and admin get `200`, staff and viewer get `403 permission_denied`, for all three routes.
11. **AS-24** (unauthenticated) — **When** there are no credentials or an expired session, **Then** `401` on the three seller routes and on every `/admin/…` route.
12. **AS-25** (rate limits and fail modes) — **Given** the read limit of 120 per minute per user, **When** a user makes the 121st statement read within a minute, **Then** `429 rate_limited` with `Retry-After`; **Given** the limiter's store is down, **Then** statement reads still succeed (fail open) and operator writes answer `503` (fail closed) with nothing changed.
13. **AS-26** (reads never change state) — **Given** any seller or operator `GET`, **When** it is called, **Then** no row, cache entry or outbox row is written (compared before and after).
14. **AS-27** (unpriced lines are visible, never dropped) — **Given** a sale line for which no rate resolves (the default rate removed by a privileged test helper), **When** the month is read live, **Then** `unpricedLineCount` is `1`, the line is counted in `lineCount` and `grossMinor` and carries no commission, and the response is `200`; a line is never silently omitted from a statement.

### User Story 3 — Closing a month freezes it, exactly once, in order (Priority: P1)

After a month ends the platform freezes every shop's statement. The close waits until the month's facts are complete, never runs twice, survives a crash, and leaves a frozen result that nothing can edit.

**Why this priority**: "closed months never silently change" is the core promise.

**Independent Test**: run the close job and the admin close route against DS-1 under delay, crash and concurrency.

**Acceptance Scenarios**:

1. **AS-28** (close a month) — **Given** DS-1, March ended and every fact stream's watermark past `2026-04-01T00:10:00Z`, **When** an admin calls `POST /admin/accounting-periods/2026-03/close` with a key at `2026-04-02T02:00:00Z`, **Then** `202` with `{month: "2026-03", status: "CLOSING", runId}`; once the job finishes `GET /admin/accounting-periods/2026-03` shows `status: "CLOSED"`, `knowledgeCutoff: "2026-04-02T02:00:00Z"`, `shopCount: 2`; a snapshot exists for shop `a` (`30500 / 3050 / 27450 / 3`) and for shop `b` (`4005 / 401 / 3604 / 1`) and none for shop `c`; one `statements.period_closed` event is in the outbox.
2. **AS-29** (scheduled close, once) — **Given** the monthly schedule (02:00 UTC on the 2nd) and the clock at `2026-04-02T02:00:00Z`, **When** two workers fire it at the same moment (`Promise.all`), **Then** exactly one run exists, one snapshot per shop, one event; a job without a month closes the previous UTC month relative to the injected clock; a payload month that is malformed or not a past month is rejected without effects.
3. **AS-30** (idempotent re-delivery) — **Given** March `CLOSED`, **When** the close job is delivered again, **Then** it ends as a no-op: no snapshot row, period field or outbox row changes and no second event is written.
4. **AS-31** (a month that has not ended) — **When** the close is requested for the current or a future month, **Then** `409 period_not_ended` and nothing is written.
5. **AS-32** (facts incomplete) — **Given** an `order.paid` event that occurred `2026-03-31T23:50:00Z` has not been applied (stream lag), so the orders watermark is `2026-03-31T23:40:00Z`, **When** the close is requested, **Then** `409 period_not_ready` with `details {stream: "orders", watermark}` and no snapshot is written; **When** the consumer catches up and the close is requested again, **Then** it succeeds and includes that sale; the scheduled job retries with backoff instead of closing early.
6. **AS-33** (months close in order) — **Given** February still `OPEN` and March ready, **When** March's close is requested, **Then** `409 previous_period_open` with `details {month: "2026-02"}`; **Given** both are due when the scheduled job runs, **Then** it closes February, then March (catch-up, oldest first), each with its own cutoff.
7. **AS-34** (illegal transitions) — **When** a `CLOSED` month's close is requested, **Then** `409 period_closed`; **When** a month in `CLOSING` is requested again with a different key, **Then** `409 period_closing`; **When** `POST /admin/accounting-periods/2026-03/reopen` is called, **Then** `404` (no such route exists); **When** a privileged write sets a closed period back to `OPEN`, **Then** the store rejects it; the allowed transitions are exactly `OPEN → CLOSING`, `CLOSING → CLOSED`, `CLOSING → OPEN` (failed run).
8. **AS-35** (concurrent closes) — **When** two admins request the same month's close at the same moment with different keys (`Promise.all`), **Then** exactly one answers `202` and the other `409 period_closing`; one run, one set of snapshots.
9. **AS-36** (a crash is resumable and deterministic) — **Given** 5 shops, batches of 2, and the worker killed after two batches, **Then** the period stays `CLOSING`, no snapshot is visible to readers, and the statements of the month are still served live with the same numbers; **When** the job is re-delivered after its lease expires, **Then** it resumes with the **same** `knowledgeCutoff`, the final snapshots are identical to an uninterrupted run's, there is no duplicate row, and exactly one `statements.period_closed` event exists.
10. **AS-37** (snapshots and adjustments are immutable) — **When** a privileged `UPDATE` or `DELETE` targets a snapshot, an adjustment or a closed period, **Then** the store rejects it and the rows are unchanged; closing again never replaces a snapshot.
11. **AS-38** (a failed close leaves nothing visible) — **Given** a sale line that cannot be priced (AS-27), **When** the close runs, **Then** the run ends `FAILED` with `failureCode: "unpriced_lines"` and `details {count: 1}`, the period returns to `OPEN`, no snapshot is visible, and an alert metric moves.
12. **AS-39** (batched and bounded) — **Given** 25 shops with sales and a batch size of 10, **When** the month closes, **Then** snapshots are written in three batches (10, 10, 5), each at most the configured size, and the period is `CLOSED` only after all 25 are written and counted.

### User Story 4 — Late knowledge becomes an adjustment, never an edit (Priority: P1)

A rate is changed retroactively, or a sale or payout arrives after its month closed. The closed statement stays as it was shown; the difference is booked as an adjustment in the open month and is visible on both months.

**Why this priority**: it is the other half of the core promise and the finance audit trail.

**Independent Test**: close DS-1, then apply changes, late facts, replays and races, and compare against a fresh recomputation.

**Acceptance Scenarios**:

1. **AS-40** (retroactive rate change) — **Given** DS-1 closed, **When** RC1 is recorded and the adjustment work runs, **Then** exactly one adjustment exists `{shopId: a, refersToMonth: "2026-03", bookedMonth: "2026-04", causeKind: "rate_change", causeRef: <changeId>, grossDeltaMinor: 0, commissionDeltaMinor: -900, lineCountDelta: 0, payoutsPaidDeltaMinor: 0}`, one `statements.adjustment_booked` event is in the outbox, and the March snapshot rows are byte-identical to before.
2. **AS-41** (replay and concurrency) — **When** the adjustment job for RC1 is delivered twice, and also twice at the same moment (`Promise.all`), **Then** still one adjustment row and one event.
3. **AS-42** (a second change, the same reason text) — **Given** AS-40, **When** at `2026-04-10T09:00:00Z` an admin sets shop `a` `electronics` `600` bps from `2026-03-01` with the same reason `promo-2026-03`, **Then** a second adjustment `commissionDeltaMinor: -300` is booked (`30000 × 1%`); `corrected.commissionMinor` is `1850`; the two adjustments are not collapsed by their identical reason text.
4. **AS-43** (a change to the default rate reaches every shop) — **Given** DS-1 closed, **When** default `*` is set to `900` bps from `2026-03-01`, **Then** adjustments `-305` for shop `a` (`2745` vs `3050`) and `-41` for shop `b` (`360` vs `401`) are booked, none for shop `c`; **When** the work for shop `b` fails once, **Then** shop `a`'s adjustment stays booked, shop `b`'s is booked by the retry, and no shop is booked twice; shops are processed in keyset batches of at most 1,000.
5. **AS-44** (a change that touches nothing closed) — **When** a rate valid from `2026-04-01` is set while only March is closed, **Then** `affectedClosedMonths: []`, no adjustment is booked, and the April close later uses the new rate; **When** a retroactive change leaves every March line's commission unchanged (a category with no sales), **Then** the job completes and books nothing.
6. **AS-45** (a sale that arrives after the close) — **Given** DS-1 closed and the `l4` sale of AS-19 applied on `2026-04-03`, **When** the adjustment work runs, **Then** one adjustment `{causeKind: "late_sale", causeRef: l4's order, grossDeltaMinor: 1000, commissionDeltaMinor: 100, lineCountDelta: 1}` is booked in `2026-04`, March's `own` is unchanged, `corrected` is `{grossMinor: 31500, commissionMinor: 3150, netMinor: 28350, lineCount: 4}`.
7. **AS-46** (a payout that arrives after the close) — **Given** DS-1 closed and a `payout.paid` for shop `a`, `amountMinor 25000`, `paidAt 2026-03-30T10:00:00Z`, applied on `2026-04-04`, **Then** one adjustment `{causeKind: "late_payout", payoutsPaidDeltaMinor: 25000}` is booked in April and March's `own.payoutsPaidMinor` stays `0`.
8. **AS-47** (completeness invariant) — **Given** any sequence of rate changes, late sales and late payouts, **When** all queued adjustment work has drained, **Then** for every shop and closed month, snapshot `own` plus the sum of the adjustments referencing it equals a fresh recomputation of that month with current knowledge, for gross, commission, line count and payouts paid (property over generated sequences, plus one explicit sequence end to end).
9. **AS-48** (race with the close) — **Given** March `CLOSING` with cutoff `T`, **When** RC1 is recorded after `T` but before the period turns `CLOSED`, **Then** after the close completes the correction is still booked (the close's own follow-up finds it) and AS-47 holds; **When** RC1 is recorded before `T`, **Then** the snapshot already includes it and no adjustment is booked.
10. **AS-49** (which month an adjustment lands in) — **Given** a booking instant `2026-04-30T23:59:59Z`, **Then** it is booked in `2026-04`; at `2026-05-01T00:00:00Z` in `2026-05`; **Given** the booking month is `CLOSING` or `CLOSED` at that instant, **Then** it is booked in the earliest open month after it; a month that is not open is never a target.
11. **AS-50** (adjustments ride the next close) — **Given** AS-40 and April closed later, **Then** April's snapshot includes the `-900` in its adjustment totals and April's `total.commissionMinor` equals April's own commission plus `-900`.

### User Story 5 — Facts arrive once, in any order, and can be replayed (Priority: P2)

Statements are computed from copies of facts that other domains announce. Duplicates, reordering, garbage and outages must not change a number.

**Why this priority**: every statement depends on it, but its visible behaviour is covered by the stories above.

**Independent Test**: deliver events to the consumers directly, twice, out of order and malformed.

**Acceptance Scenarios**:

1. **AS-51** (sale facts applied) — **Given** an `order.paid` event for `o1` with one `electronics` line, **When** it is consumed, **Then** one fact per line exists keyed by `(orderId, lineId)` with `shopId`, normalised `category` (trimmed, lower case), `quantity`, `unitPriceMinor`, `discountMinor`, `lineTotalMinor`, `paidAt`, `recordedAt = occurredAt`, `orderVersion`; no buyer identifier is stored; the next statement read includes it.
2. **AS-52** (duplicate delivery) — **When** the same event (same `eventId`) is delivered twice and concurrently, **Then** one set of facts and a single effect; the second delivery is counted as `duplicate`.
3. **AS-53** (out of order and replays) — **When** an event with the same `orderId` and a lower `orderVersion` than the stored one arrives, **Then** it is discarded and nothing changes; **When** a higher `orderVersion` arrives, **Then** the facts are replaced by the newer values; **When** a copy with a new `eventId` and the same version arrives (topic replay), **Then** nothing changes.
4. **AS-54** (invalid payloads) — **When** an event has a missing `lines`, a `shopId` that is not a UUID, a negative or non-integer money value, a currency other than `EUR`, an empty `category`, a `paidAt` that is not ISO-8601, a `lineTotalMinor` that is not `quantity × unitPriceMinor − discountMinor`, a `lineTotalMinor` above `1000000000000`, or an unknown `version`, **Then** it is dead-lettered with its reason, no fact is written, `statements_events_rejected_total{stream,reason}` moves, and the next valid event is processed (a poison message never blocks the queue).
5. **AS-55** (UTC month assignment) — **Then** `paidAt` `2026-03-31T23:59:59.999Z` belongs to `2026-03`; `2026-04-01T00:00:00.000Z` to `2026-04`; `2026-04-01T01:30:00+02:00` (that is `2026-03-31T23:30:00Z`) to `2026-03`.
6. **AS-56** (payouts) — **Given** a `payout.paid` `{payoutId, shopId: a, amountMinor: 25000, paidAt: "2026-03-30T10:00:00Z", payoutVersion: 3}`, **When** it is consumed twice, **Then** one fact exists and the March statement shows `payoutsPaidMinor: 25000`; a `payout.failed`, `payout.cancelled`, `payout.created` or `payout.in_doubt` event has no effect; a `payout.paid` with a lower `payoutVersion` than stored is discarded.
7. **AS-57** (ledger facts) — **Given** a `ledger.journal_posted` of kind `SALE` with an `orderId`, lines crediting `SHOP_<a>` and `PLATFORM_FEES`, **When** it is consumed twice, **Then** one ledger fact exists per journal; journals of other kinds are ignored; no shard number is kept.
8. **AS-58** (watermarks and freshness) — **Given** the three streams, **Then** each has a watermark (the instant up to which every event that occurred has been applied) exposed in `GET /admin/accounting-periods/:month` and as `dataAsOf` on live statements; **When** a stream is more than 60 s behind, **Then** `statements_ingestion_lag_seconds{stream}` reports it, live statements still answer `200`, and the instance stays ready.
9. **AS-59** (rebuild by replay) — **Given** DS-1 with a rate change and a late sale applied, **When** the fact store is emptied and the order, payout and ledger topics replayed from the start, **Then** the facts, every live statement, and every as-known-at answer equal those before; snapshots and adjustments are untouched.
10. **AS-60** (no cross-aggregate ordering assumed) — **Given** a `payout.paid` consumed before the `order.paid` events of the same month, **Then** each is applied on its own and the month's statement is correct once both are in.

### User Story 6 — A seller downloads a statement as CSV without the server holding it in memory (Priority: P2)

**Why this priority**: required by finance and sellers; the mechanism proves streaming and back-pressure.

**Independent Test**: export DS-1 and a 200,000-line shop with a slow reader, a disconnect and a forced failure.

**Acceptance Scenarios**:

1. **AS-61** (export) — **Given** DS-1 closed, **When** a member with `payouts.read` calls `GET /shops/a/statements/2026-03/lines.csv`, **Then** `200`, `Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="statement-<shopId>-2026-03.csv"`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`; the first line is `rowType,orderId,lineId,paidAt,productId,category,quantity,unitPriceMinor,lineTotalMinor,rateBps,commissionMinor,refersToMonth,bookedMonth,cause`; three `sale` rows ordered by `paidAt`, `orderId`, `lineId`, with `rateBps` `1000` and commissions `1000`, `2000`, `50`; the sums of `lineTotalMinor` and `commissionMinor` equal the statement's `total.grossMinor` (`30500`) and `total.commissionMinor` (`3050`); nothing is written.
2. **AS-62** (closed months do not change) — **Given** DS-1 closed and RC1 processed, **When** the March CSV is downloaded, **Then** it is identical to the one downloaded before RC1 (priced as of the snapshot's cutoff; the `-900` appears in the April CSV as an `adjustment` row `{rowType: adjustment, lineTotalMinor: 0, commissionMinor: -900, refersToMonth: 2026-03, bookedMonth: 2026-04, cause: rate_change:<changeId>}`, and the April column sums equal April's `total`).
3. **AS-63** (as known at) — **When** `?knownAt=2026-04-06T00:00:00Z` is added to the March CSV, **Then** the rows are priced as known then (`rateBps 700` on the electronics rows), no adjustment rows appear, and the sums equal the as-known-at statement; invalid or future `knownAt` behaves as AS-20.
4. **AS-64** (cells are safe, numbers stay numbers) — **Given** categories that begin with `=`, `+`, `-`, `@`, a tab or a carriage return, **Then** each text cell is quoted, inner quotes doubled, and prefixed with `'` (`=HYPERLINK("http://evil")` becomes `"'=HYPERLINK(""http://evil"")"`); **Then** integer columns are written as bare integers, so `-900` is `-900`, not `'-900`; a null cell is empty.
5. **AS-65** (constant memory, back-pressure) — **Given** a shop with 200,000 lines and a client reading slowly, **When** it exports, **Then** the server never holds more than one batch of rows (at most 1,000) beyond the socket buffer, the database cursor pauses while the client is slow, and the process memory growth stays below 50 MB.
6. **AS-66** (client disconnects) — **When** the client closes the connection after the first chunk, **Then** the database query is cancelled, the connection is back in the pool within 5 s, and nothing is logged as a server error.
7. **AS-67** (server failure mid-stream) — **Given** the database fails after the first chunk, **Then** the response is aborted (no clean end of body, so the client sees a failed download, never a file that looks complete), `statements_export_aborted_total{reason="db_error"}` moves, the connection is released, and the log line carries `requestId` and `shopId` but no row content; a statement running longer than the export timeout ends the same way with `reason="timeout"`.
8. **AS-68** (bounded concurrency) — **Given** the policy of 2 concurrent exports per shop, **When** a third starts, **Then** `429 rate_limited` with `Retry-After` and no database connection is taken; **Given** the limiter's store is down, **Then** the export is refused with `503` (fail closed: exports protect the database) and nothing is streamed.
9. **AS-69** (empty month) — **When** a shop with no sales exports a month, **Then** `200` with the header line only.
10. **AS-70** (identity of lines) — **Given** two lines of one order for the same product, **Then** both appear as separate rows with different `lineId`s, and the order of rows is the same on every download.

### User Story 7 — Closed numbers are proven against the ledger and against themselves (Priority: P2)

**Why this priority**: it turns "we believe it is right" into a monitored, alarmed property (pattern P0614).

**Independent Test**: seed ledger facts and snapshots, run the verification job, tamper, run again.

**Acceptance Scenarios**:

1. **AS-71** (golden dataset) — **Given** the fixed golden dataset (three shops, twelve lines over two rate regimes, one retroactive change, one late sale, one late payout, checked into the test fixtures with its expected output), **When** it is closed and corrected, **Then** every snapshot, adjustment and statement equals the expected output to the minor unit, and the same output results from a rebuild by replay (AS-59).
2. **AS-72** (clean reconciliation) — **Given** DS-1 closed and `SALE` ledger facts whose `SHOP_<a>` credits total `27450` and `SHOP_<b>` credits `3604`, and `PLATFORM_FEES` credits `3451`, **When** `statements.verify-period` runs for March, **Then** no finding is open and the period's reconciliation summary is `clean`.
3. **AS-73** (differences become findings) — **Given** the ledger credited shop `a` `27400` (net), **Then** one finding `{kind: "net_mismatch", shopId: a, expectedMinor: 27450, actualMinor: 27400, differenceMinor: -50, status: "OPEN"}` exists; the platform-fee total `3401` against `3451` gives `{kind: "fee_mismatch", shopId: null, differenceMinor: -50}`; running the job again leaves one finding of each (idempotent per month, kind and shop); a later run that finds agreement marks them `CLEARED`; snapshots are never altered; `statements_reconciliation_findings_total{kind}` moves.
4. **AS-74** (missing on one side) — **Given** a closed-month sale with no ledger journal 24 hours after the close, **Then** `missing_in_ledger`; **Given** a `SALE` journal whose order has no sale fact, **Then** `missing_in_statement`; each is reported once.
5. **AS-75** (tampering is detected) — **Given** a snapshot altered by a privileged test helper so that snapshot plus adjustments no longer equals the recomputation, **When** the daily `statements.verify-periods` job runs, **Then** a `completeness_violation` finding for that shop and month is opened, `statements_completeness_violations_total` moves, nothing is auto-corrected, and `GET /admin/accounting-periods/2026-03/findings` lists it (paged, `invalid_cursor` on a bad cursor, admin only).

### User Story 8 — The domain is safe to run, move and keep (Priority: P3)

**Why this priority**: operational and governance requirements that must hold for every other story.

**Independent Test**: ownership check, migration on a seeded old-shape database, configuration and shutdown tests.

**Acceptance Scenarios**:

1. **AS-76** (retention) — **Given** a shop deleted through S03's offboarding, **Then** its rates, facts, snapshots, adjustments and periods remain readable by admins and reconciliation, no statements route deletes anything, and no stored fact or CSV column holds a buyer identifier.
2. **AS-77** (boundaries) — **Then** the ownership check lists no table outside `statements`' own set for any file of this domain, no file imports another domain except through its public entry point, and no code of this domain runs a query against orders, catalog or ledger data (R1/R3 only).
3. **AS-78** (migration keeps closed months) — **Given** a database holding the old shape (snapshots, adjustments with free-text reasons, periods `OPEN` or `CLOSED`, rates), **When** the migration runs and is run again, **Then** every closed month's statement body equals what it returned before (`gross` → `grossMinor` etc. renamed in the API only), old adjustments carry `causeKind: "rate_change"` and `causeRef: "legacy:<reason>"`, snapshots receive `knowledgeCutoff = closedAt`, no row is lost, and the old reader keeps working until the contract step.
4. **AS-79** (configuration) — **When** the process starts with a snapshot batch size outside `1–10000`, a close margin below `0`, an export concurrency below `1`, an export timeout below `1 s`, a malformed close schedule, or a retention below `10` years, **Then** it fails at startup naming the setting and does not serve.
5. **AS-80** (graceful shutdown) — **Given** a close run between batches and exports in flight, **When** the stop signal arrives, **Then** the close finishes the current batch, stops, leaves the period `CLOSING` with its lease released (resumable per AS-36), in-flight exports finish for up to 30 s and are then aborted as in AS-67, and the consumers stop after the current message.
6. **AS-81** (timeouts) — **Then** every database statement, job and outbound call of this domain runs under an explicit timeout; a statement that exceeds it fails the request with `500 internal_error` (generic `detail`, no SQL) and releases its connection.
7. **AS-82** (metrics and logs) — **Given** each outcome of AS-01–AS-75, **Then** the metrics named in FR-054 move by the stated amount, every log line is structured with `requestId` or `jobId`, and no line holds CSV content, a full request body or a buyer identifier.
8. **AS-83** (replica reads) — **Given** a configured reporting replica, **Then** statement reads of closed months and exports run on it, a live open-month statement states `dataAsOf` and may lag the primary by at most 60 s, and when the replica is unreachable reads fall back to the primary once, with a metric.

### Edge Cases

- A sale paid exactly at a rate boundary (AS-04), at a month boundary (AS-55) or in a different UTC offset (AS-55).
- Two rate changes at the same instant (AS-07), concurrent changes (AS-06), the same change replayed (AS-12) or already in force (AS-08).
- A change that reaches into closed months (AS-40), into none (AS-44), into all shops (AS-43), during the close (AS-48).
- Late, duplicated, reordered and malformed facts (AS-45, AS-52–AS-54), a stream that is behind at close time (AS-32), a replay from the start (AS-59).
- A month closed twice, concurrently, out of order, too early or after a crash (AS-29–AS-36); a month that cannot be priced (AS-27, AS-38).
- A seller of another shop, a staff member, no session (AS-23, AS-24); too many reads or exports (AS-25, AS-68).
- A client that is slow, leaves or whose download fails midway (AS-65–AS-67); a CSV cell that is a formula or a negative number (AS-64).
- A shop deleted while its history remains (AS-76).

## Requirements *(mandatory)*

### Functional Requirements

**Commission rates**

- **FR-001**: Every commission rate MUST carry two periods: the period in which it applies in the real world and the period in which the platform believed it; a rate row MUST never be edited in place except to close its recorded period (AS-02, AS-03).
- **FR-002**: Setting a rate MUST close the recorded period of every current belief it overlaps, re-record the parts of those beliefs it does not cover, and record the new belief, all in one atomic step (AS-01, AS-03).
- **FR-003**: The store itself MUST make two current beliefs for one shop and category with overlapping validity impossible (AS-05).
- **FR-004**: Lookup MUST prefer shop and category, then shop and any category, then default and category, then default and any category; validity is `validFrom ≤ t < validTo`; the answer carries the rule that matched (AS-02, AS-04).
- **FR-005**: The default rate for all categories MUST cover all time at all times; a change that would leave a gap MUST be refused (AS-10).
- **FR-006**: Writers for one shop and category MUST be serialised; recorded instants for one shop and category MUST be strictly increasing (AS-06, AS-07).
- **FR-007**: A change identical to what is already in force MUST be a no-op that writes nothing and triggers nothing (AS-08).
- **FR-008**: Rate requests MUST be validated (AS-09); only platform admins may read or write rates, and every change MUST record who, when and why (AS-11).
- **FR-009**: Rate writes MUST require an `Idempotency-Key` with the replay, in-flight and different-body semantics of V.6 (AS-12).
- **FR-010**: Rate history and as-of lookups MUST be available to admins, keyset-paged with a tiebreaker (AS-02, AS-13); other domains look rates up through the exported query service (see Provides).

**Pricing and statements**

- **FR-011**: Each sale line MUST be priced with the rate valid at its `paidAt` and known at the statement's knowledge instant; the line's commission is `floor((lineTotalMinor × rateBps + 5000) / 10000)`; statement figures are sums over lines of integer minor units (AS-14, AS-43, AS-55).
- **FR-012**: A sale belongs to the UTC month of its `paidAt` (AS-55).
- **FR-013**: A statement MUST report `own` (gross, commission, net, line count, payouts paid), the adjustments booked in this month, the adjustments referencing this month, `total` (own plus adjustments booked here), `corrected` (own plus adjustments referencing this month), `status`, `source`, `knownAt`, `dataAsOf`, `unpricedLineCount` (AS-14–AS-17).
- **FR-014**: A line that cannot be priced MUST be counted and reported, never dropped, and MUST block the close (AS-27, AS-38).
- **FR-015**: Open months MUST be computed live, closed months MUST be served from their snapshot without touching facts or rates, and any month MUST be answerable as known at any past instant on both axes (rates and facts) (AS-15, AS-18, AS-19).
- **FR-016**: `knownAt` MUST be a full ISO-8601 instant, not in the future; months MUST be `YYYY-MM` within `2020-01` and the current month; a month with no activity returns zeros (AS-20, AS-21).
- **FR-017**: Statement and list reads MUST put the principal in the access predicate: a non-member gets `404 shop_not_found` indistinguishable from an unknown shop, a member without `payouts.read` gets `403 permission_denied`, no credentials get `401` (AS-23, AS-24).
- **FR-018**: The months list MUST be keyset-paged (default 12, max 36) and consistent with single-month reads (AS-22).
- **FR-019**: Seller reads MUST be limited to 120 per minute per user (fail open) with `Retry-After` (AS-25); `GET` MUST never change state (AS-26).

**Period close**

- **FR-020**: An accounting period MUST be in exactly one of `OPEN`, `CLOSING`, `CLOSED`, with only the transitions of AS-34, each a conditional step with a history; a closed period MUST never reopen (AS-34).
- **FR-021**: A month MAY close only when it has ended, every fact stream's watermark is past its end plus the safety margin, and the previous month is `CLOSED` (AS-31–AS-33).
- **FR-022**: A close run MUST fix its `knowledgeCutoff` when it starts and keep it across retries, write snapshots in bounded batches, make none visible until all are written and counted, and then mark the period `CLOSED` and emit `statements.period_closed` in one transaction (AS-28, AS-36, AS-39).
- **FR-023**: The close MUST run once per month across replicas, MUST be idempotent, MUST be resumable after a crash, and a manual request MUST be accepted for exactly one run at a time (AS-29, AS-30, AS-35, AS-36).
- **FR-024**: Snapshots, adjustments and closed periods MUST be immutable, enforced by the store (AS-37).
- **FR-025**: A failed run MUST leave the period `OPEN`, no visible snapshot and a named failure code (AS-38).
- **FR-026**: Operators MUST be able to request a close, read a period (state, cutoff, shop count, watermarks, last run, reconciliation summary), list periods keyset-paged, and read findings (AS-28, AS-58, AS-75).

**Adjustments**

- **FR-027**: A change that alters the knowledge about a closed month MUST never edit that month; it MUST become an adjustment referencing it and booked in an open month (AS-40, AS-45, AS-46).
- **FR-028**: The adjustment for a (shop, month, cause) MUST be the difference between a fresh recomputation with current knowledge and the snapshot plus all earlier adjustments for that shop and month; a zero difference books nothing; the cause is `rate_change:<changeId>`, `late_sale:<orderId>` or `late_payout:<payoutId>` and is unique per shop and month, so repeats and identical reason texts neither duplicate nor collapse (AS-41, AS-42).
- **FR-029**: At every moment all queued adjustment work has drained, closed `own` plus adjustments referencing it MUST equal a recomputation with current knowledge, whatever the interleaving of changes, late facts and the close (AS-47, AS-48).
- **FR-030**: The booking month MUST be the UTC month of the booking instant, or the earliest open month after it when that month is not open (AS-49).
- **FR-031**: Adjustment work MUST be triggered by rate changes, by facts that land in a closed month, and by the completion of a close; it MUST run in keyset batches of at most 1,000 shops, isolate per-shop failures, and be idempotent (AS-43).
- **FR-032**: Each booked adjustment MUST emit `statements.adjustment_booked` through the outbox in its own transaction (AS-40).

**Facts in (R3)**

- **FR-033**: Sale lines, paid payouts and ledger sale journals MUST be copied from `order.paid`, `payout.paid` and `ledger.journal_posted` events into this domain's own store; no other route to those facts exists (AS-51, AS-56, AS-57).
- **FR-034**: Each consumer MUST validate its payload before acting, be idempotent per `eventId`, and be version-guarded per aggregate; invalid payloads MUST be dead-lettered without effects and without blocking (AS-52–AS-54, AS-56).
- **FR-035**: A fact's recorded time MUST be its event's `occurredAt`, so a rebuild by replay gives identical answers on both time axes (AS-19, AS-59).
- **FR-036**: The system MUST track a watermark per stream, expose it, and report lag; staleness above 60 s MUST raise a metric, not an error (AS-58).
- **FR-037**: The fact store MUST be rebuildable from the topics alone (AS-59); buyer identity MUST never be copied (AS-51, AS-76).

**CSV export**

- **FR-038**: The export MUST list the statement's own sale lines and the adjustments booked in the month, with the columns, ordering and headers of AS-61; its column sums MUST equal the statement's `total` (AS-61, AS-62, AS-70).
- **FR-039**: A closed month's export MUST be priced as of its snapshot cutoff and therefore never change; `knownAt` MUST give the as-known-at lines (AS-62, AS-63).
- **FR-040**: The export MUST stream with back-pressure, hold at most one batch of rows in memory, release its connection on disconnect or failure within 5 s, and abort (never complete) a response that fails midway (AS-65–AS-67).
- **FR-041**: Text cells MUST be formula-safe, integers MUST stay numeric (AS-64).
- **FR-042**: Exports MUST be limited to 2 concurrent per shop, failing closed when the limiter is down (AS-68).

**Reconciliation**

- **FR-043**: For each closed month the system MUST compare per-shop net and the platform-fee total with the ledger facts, and sale facts with sale journals, record each difference as one finding per (month, kind, shop), clear it when it agrees later, and never alter a snapshot (AS-72–AS-74).
- **FR-044**: A daily job MUST verify FR-029 for closed months of the last 90 days and open a `completeness_violation` finding and metric on any difference (AS-75).
- **FR-045**: A golden dataset with expected output MUST be part of the tests and MUST produce identical output after a rebuild (AS-71).

**Operations, governance**

- **FR-046**: Records of this domain are financial records: they MUST be kept at least 10 years after the month closes, MUST NOT be deleted by shop or user deletion, and MUST NOT contain buyer identifiers; no deletion route exists (AS-76).
- **FR-047**: The domain MUST read and write only the tables it owns, hold no foreign key to another domain's table, and reach shop data only through R1 exports (AS-77).
- **FR-048**: Existing rates, periods, snapshots and adjustments MUST be migrated without losing a row or changing a closed month's figures, safely repeatable, with old readers working until the contract step (AS-78).
- **FR-049**: Configuration MUST be validated at startup (AS-79); shutdown MUST be graceful (AS-80); every outbound operation MUST have an explicit timeout (AS-81).
- **FR-050**: Scheduled jobs MUST run once per schedule across replicas and be idempotent (AS-29, AS-72).
- **FR-051**: Every error MUST be RFC 9457 problem+json with the codes named in this spec and `requestId`; 5xx `detail` is generic (AS-81).
- **FR-052**: Every endpoint response and request MUST have a schema in `packages/contracts` and money MUST be named `…Minor` (all stories).
- **FR-053**: Statement reads of closed months and exports SHOULD run on a reporting replica and MUST state `dataAsOf` for live data (AS-83).
- **FR-054**: Metrics: `statements_rate_changes_total{outcome}`, `statements_period_close_total{status}`, `statements_period_close_duration_seconds`, `statements_adjustments_booked_total{cause}`, `statements_events_applied_total{stream,outcome}` (`applied`, `duplicate`, `stale`), `statements_events_rejected_total{stream,reason}`, `statements_ingestion_lag_seconds{stream}`, `statements_export_active`, `statements_export_aborted_total{reason}`, `statements_reconciliation_findings_total{kind}`, `statements_completeness_violations_total`. Logs MUST be structured, carry `requestId` or `jobId` and `shopId`, and never hold CSV rows or bodies (AS-82).

### Key Entities

- **Commission rate (belief)**: shop or marketplace default, category or any, `rateBps`, valid period, recorded period, who and why, change ID.
- **Sale fact**: one line of a paid order as announced: `(orderId, lineId)`, shop, normalised category, quantity, unit price, discount, line total, `paidAt`, `recordedAt`, order version. No buyer.
- **Payout fact**: a paid payout: payout ID, shop, amount, `paidAt`, payout version.
- **Ledger fact**: a sale journal: journal ID, order ID, per-shop credits, platform-fee credit, posted time.
- **Accounting period**: a month with state `OPEN` / `CLOSING` / `CLOSED`, knowledge cutoff, close run, shop count, history.
- **Statement snapshot**: one shop and month frozen at close: own totals, adjustment totals booked in that month, knowledge cutoff. Immutable.
- **Adjustment**: shop, referenced month, booked month, cause kind and reference, deltas for gross, commission, line count, payouts paid, reason. Immutable.
- **Reconciliation finding**: month, kind, shop or none, expected, actual, difference, `OPEN` / `CLEARED`.
- **Statement (view)**: not stored; the composition of the above for one shop, month and knowledge instant.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After any sequence of rate changes, late facts, replays and a crash during the close, for 100% of shops and closed months the frozen figures plus the adjustments referencing them equal a fresh recomputation (checked by the daily verification and the property tests).
- **SC-002**: A closed month's statement and CSV are byte-identical when read before and after any later rate change, in 100% of checked cases.
- **SC-003**: A seller can retrieve any month as known at any past instant, and the answer for a given instant never changes, including after a rebuild from the event topics, in 100% of checked cases.
- **SC-004**: Closing a month for 100,000 shops with sales completes in under 5 minutes, writes snapshots in batches of at most 10,000, and never makes a half-closed month visible (benchmark script plus the crash test).
- **SC-005**: 99% of statement reads of a closed month answer in under 2 seconds and 95% in under 300 ms with 5 years of history; reads touch no sales facts.
- **SC-006**: A 200,000-line export uses less than 50 MB of additional memory, and a client that disconnects frees the database connection within 5 seconds.
- **SC-007**: A sale shows on the seller's live statement within 60 seconds of payment at the 95th percentile, and the statement states how fresh it is.
- **SC-008**: 100% of seeded reconciliation differences (net, fee, missing on either side, tampered snapshot) appear exactly once as findings; a clean month yields none.
- **SC-009**: Zero cross-domain table reads, associations or foreign keys remain in the domain's code, and no buyer identifier is stored or exported.
- **SC-010**: An operator can set or backdate a rate with one request and see, per affected closed month and shop, the resulting adjustment, with a replay changing nothing.

## Assumptions

- Decisions taken unattended under the decision policy are in `questions.md` (BREAKING first); those that shape behaviour are repeated here.
- One currency, `EUR`. Money is integer minor units; sums are assumed to stay below 2^53 minor units; a single line is capped at `1000000000000`.
- Months are UTC calendar months; a sale belongs to the month of its `paidAt`. The close runs at 02:00 UTC on the 2nd, so late events of the previous month have more than a day to settle; the safety margin is 10 minutes past the month's end.
- Facts come only from events; this capability never reads orders, catalog, payments or ledger tables. `order.paid` lines must carry `lineId` and `category` (a contract request to S10, see Requires). Historical orders are loaded by S10 re-emitting history.
- The store for facts is a plan decision; the notes support month-partitioned immutable fact tables and an optional analytical replica for heavy reports. The spec requires only exactness, idempotency, rebuild by replay and the stated latencies.
- Refunds, chargebacks and cancellations after payment do not change statements in this version.
- Rates are set by platform admins only (`AuthenticatedUser.role === "admin"`). A shop's rate on a category that no catalog product has is allowed.
- `payouts.read` (owner and admin roles per S03) guards the three seller routes; there is no seller write.
- Rate limits: statements `statements.read` 120/min per user (fail open), `statements.export.concurrent` 2 per shop (fail closed), `statements.admin.read` 120/min (fail open), `statements.admin.write` 30/min (fail closed).
- Retention is 10 years after the month closes; no purge is built in this capability.
- The idempotency retention window is 24 h (S54). Pagination defaults: seller list 12 (max 36), admin lists 20 (max 100).
- A shop never has more than one statement per UTC month; sandbox shops produce no paid orders (S10).

## Cross-capability contracts

**Provides** (names exact; later specs read this section):

- **Modules** (public entry point `@app/domains/statements`; nothing else is exported, no model, no repository): `StatementsModule` (core: seller and operator HTTP), `StatementsWorkerModule` (worker: close, adjustment, verification jobs), `StatementsProjectorModule` (projector: the three fact consumers). Also exported: `CommissionRateQueryService`, its DTO types, and the event contracts below.
- **`CommissionRateQueryService`** (R1, DTOs only, batch only): `getRatesAsOf(queries: { shopId: string; category: string; validAt: Date }[], knownAt?: Date): Promise<RateAsOfDto[]>` — same length and order as the input, ≤ 500 queries (else `TooManyQueriesError`), `knownAt` default now and never in the future; `RateAsOfDto = { shopId, category, validAt, rateBps: number, rule: 'shop_category' | 'shop_any' | 'default_category' | 'default_any' }`. Guarantee: always answers (the default covers all time). **Consumers: S14 (to replace its flat fee when it adopts commissions; until then S14's fee differences show as `fee_mismatch` findings), S36 (optional).**
- **Finance retention rules** (referenced by S10, S14 and S15): financial records are kept at least 10 years after the month closes, are never deleted by shop or user deletion, and carry no buyer identifier; statements store only order, payout and journal IDs.
- **HTTP** (schemas in `packages/contracts`):
  - `GET /shops/:shopId/statements?limit&cursor` → `200 statementPageSchema {items: {month, status: "OPEN" | "CLOSING" | "CLOSED", total: totalsSchema}[], nextCursor: string | null}`; `ShopScoped('payouts.read')`; problems `validation_failed` 400, `invalid_cursor` 400, `shop_not_found` 404, `permission_denied` 403, `rate_limited` 429. Policy `statements.read`.
  - `GET /shops/:shopId/statements/:month?knownAt` → `200 statementSchema {shopId, month, currency: "EUR", status, source: "live" | "snapshot" | "as_known_at", knownAt: string, dataAsOf: string | null, own: totalsSchema, adjustmentsBooked: adjustmentSchema[], adjustmentsReferencing: adjustmentSchema[], total: totalsSchema, corrected: totalsSchema, unpricedLineCount: number}`; `totalsSchema {grossMinor, commissionMinor, netMinor, lineCount, payoutsPaidMinor}`; `adjustmentSchema {id, shopId, refersToMonth, bookedMonth, causeKind: "rate_change" | "late_sale" | "late_payout", causeRef, grossDeltaMinor, commissionDeltaMinor, lineCountDelta, payoutsPaidDeltaMinor, reason, createdAt}`; problems as above plus `month_not_available` 422, `known_at_in_future` 422.
  - `GET /shops/:shopId/statements/:month/lines.csv?knownAt` → `200 text/csv` (AS-61); policies `statements.read` and `statements.export.concurrent`; problems as the statement route plus `429`/`503`.
  - `POST /admin/commission-rates` (`Idempotency-Key` required) → `201`/`200` `commissionRateChangeResultSchema {changeId, shopId: string | null, category, rateBps, validFrom, validTo: string | null, recordedAt, changed: boolean, affectedClosedMonths: string[]}`; problems `validation_failed` 400, `rate_range_invalid` 422, `default_rate_gap` 422, `shop_not_found` 404, `idempotency_key_required | idempotency_key_reuse` 422, `idempotency_in_flight` 409, `permission_denied` 403. Policy `statements.admin.write`.
  - `GET /admin/commission-rates?shopId&category&limit&cursor` → `commissionRateHistoryPageSchema {items: {id, changeId, shopId: string | null, category, rateBps, validFrom, validTo, recordedFrom, recordedTo: string | null, reason, recordedBy}[], nextCursor}`; `GET /admin/commission-rates/as-of?shopId&category&validAt&knownAt` → `commissionRateAsOfSchema {rateBps, rule, validFrom, validTo, recordedFrom}`.
  - `GET /admin/accounting-periods?limit&cursor` and `GET /admin/accounting-periods/:month` → `accountingPeriodSchema {month, status, knowledgeCutoff: string | null, closedAt: string | null, shopCount: number | null, watermarks: {orders, payouts, ledger: string | null}, lastRun: {runId, status: "RUNNING" | "COMPLETED" | "FAILED", failureCode: string | null, startedAt, finishedAt: string | null} | null, reconciliation: "clean" | "findings" | "unverified"}`; `POST /admin/accounting-periods/:month/close` (`Idempotency-Key` required) → `202 {month, status: "CLOSING", runId}`; problems `period_not_ended`, `period_not_ready`, `previous_period_open`, `period_closed`, `period_closing` 409; `GET /admin/accounting-periods/:month/findings?limit&cursor` → `reconciliationFindingPageSchema {items: {id, month, kind: "net_mismatch" | "fee_mismatch" | "missing_in_ledger" | "missing_in_statement" | "completeness_violation", shopId: string | null, expectedMinor, actualMinor, differenceMinor, status: "OPEN" | "CLEARED", openedAt, clearedAt: string | null}[], nextCursor}`. Admin only; policies `statements.admin.read`, `statements.admin.write`.
- **Events** (outbox → topic `statements.events`, key = aggregate ID; envelope `{eventId, type, version: 1, occurredAt, aggregateId}`; money in `…Minor`):
  - `statements.period_closed` aggregate `month` `{month, knowledgeCutoff, shopCount, runId, closedAt}`.
  - `statements.adjustment_booked` aggregate `adjustmentId` `{adjustmentId, shopId, refersToMonth, bookedMonth, causeKind, causeRef, grossDeltaMinor, commissionDeltaMinor, lineCountDelta, payoutsPaidDeltaMinor}`.
  - **Consumers: S28 (optional: tell the seller their statement is ready, or that a correction was booked; finance alert on failed closes), J01.** Consumers dedupe by `eventId`.
- **Jobs** (registered with S49): `statements.close-month {month?}` (2nd of each month, 02:00 UTC, concurrency 1), `statements.reconcile-month {month, cause}` (adjustment work; per-cause, idempotent), `statements.verify-period {month}`, `statements.verify-periods {}` (daily).
- **Consumers this capability runs** (own consumer group `statements-facts`; dedupe by `eventId` through an inbox and by aggregate version; zod validation; dead-letter for poison): `orders.events` `order.paid`; `payouts.events` `payout.paid`; `ledger.events` `ledger.journal_posted`.
- **Metrics**: names in FR-054.

**Requires**:

- **S10** (`orders`): `order.paid` as published (`{orderId, totalMinor, currency, paymentRef, paidAt, lines: [{productId, shopId, title, quantity, unitPriceMinor, discountMinor, lineTotalMinor}], shopOrders, orderVersion}`, envelope with `eventId`, `occurredAt`, key `orderId`) **plus two additions this spec asks for: each line carries `lineId` (stable per line of an order) and `category` (the product's category copied at purchase time, IX.8)**; and a way to re-emit the history of paid orders to the topic for a rebuild or first load. Statements never read `BisOrder`, `BisOrderItem` or `Product`.
- **S15** (`payments`): `payout.paid` `{payoutId, shopId, periodStart, amountMinor, currency, transferRef, paidAt, payoutVersion}` on `payouts.events`, key `payoutId`.
- **S14** (`payments`): `ledger.journal_posted` v2 `{journalId, kind, currency, postedAt, lines: [{accountId, shard, amountMinor, balanceAfterMinor, balanceVersion}], paymentId?, orderId?}`; for kind `SALE` the journal carries `orderId`, credits `shopAccount(shopId)` (`SHOP_<shopId>`) per shop and credits `LEDGER_ACCOUNTS.PLATFORM_FEES`. Until S14 adopts `getRatesAsOf`, its flat fee differs from statement commission and produces `fee_mismatch` findings by design.
- **S03** (`tenancy`): `ShopScoped('payouts.read')` answering non-members `404 shop_not_found` and holders of other roles `403 permission_denied`; `ShopQueryService.getShopsByIds(ids ≤ 500)` (R1) to confirm a shop exists before a shop-specific rate is accepted; the permission matrix (owner and admin hold `payouts.read`).
- **S01** (`identity`): `Firewall`, `@User()`, `AuthenticatedUser = { id, role, sessionId, amr }` with `role === 'admin'` for operators.
- **S49** (jobs): a recurring cron schedule with a UTC time zone and a single-run lease across replicas; `enqueue(type, payload, { idempotencyKey, runAt? })` callable inside the caller's transaction; retries with backoff and jitter; handler concurrency limits; lease renewal; cooperative stop on shutdown.
- **S53** (events): `outbox.append(event)` in the caller's transaction and the relay to `statements.events`; consumer facilities (inbox, zod validation, dead-letter, replay from the start, a per-stream watermark or lag read).
- **S54** (platform toolkit): problem+json with `code` and `requestId`; the `Idempotency-Key` facility (24 h, `Idempotency-Replayed`); injected clock; configuration validation; metrics registry; graceful shutdown; a read-replica handle for reports.
- **S50** (rate limiter): policies `statements.read` 120/min per user (fail open), `statements.export.concurrent` 2 per shop (concurrency, fail closed), `statements.admin.read` 120/min (fail open), `statements.admin.write` 30/min (fail closed), with `Retry-After`.
