# Feature Specification: S15 — Seller Payouts: Weekly Run, Reserves, Provider Transfer with Idempotency, Payout States (domain `payments`)

**Feature Branch**: `S15-payouts` (spec directory `specs/domains/S15-payouts`)

**Created**: 2026-10-05

**Status**: Draft

**Input**: User description: "Seller payouts: weekly run, reserves, provider transfer with idempotency, payout states (domain `payments`)". Sources: `docs/showcase/sections/SD-20-payments-ledger-reconciliation.md` (seller payouts row), Interview-Prep `10-System-Design/02-worked-examples.md` (Example 1: external transfer flow, unknown outcome, exactly-once effect, deadlock-free ordering), pattern-map row P0414 (idempotency keys: replay, in-flight 409, different-body 422, TTL; payout transfers keyed by payout ID), constitution v3.1.0 (III.3, III.4, III.6–III.8, IV.3–IV.6, V.6, VII, VIII.6, IX, X).

## Scope

Money leaves the platform here. Every week the platform pays each seller what it owes them, minus a safety **reserve**, by moving the money first inside the books and then to the seller's own payment-provider account. The seller sees every payout and what the next one will be. Operators can hold a payout back, change a reserve, and register where a shop is paid. A payout is never created twice for a week, never sent twice to the provider, never lost when the provider does not answer, and never leaves the books out of balance.

In scope:

- **The weekly run**: for one calendar week, find shops owed at least the minimum, apply eligibility rules, deduct the reserve, apply the per-payout cap, and create one payout per shop in a single atomic step that also moves the money in the books (seller balance → payout clearing) and queues the transfer. Re-runs, concurrent runs, and resumed runs create nothing twice.
- **Reserves**: a platform default reserve percentage, an operator override per shop, exact integer rounding, and the amount that stays in the seller's balance.
- **The provider transfer**: one transfer per payout, keyed by the payout's own ID so a retry can never pay twice; a claim step so concurrent workers cannot both send; outcomes success, definite rejection (money returns to the seller), transient failure (retry), and unknown (the provider did not answer: ask it, never blindly resend); the provider's answers are checked before they are believed.
- **Payout states**: `PENDING → SENDING → PAID | FAILED | UNKNOWN`, `UNKNOWN → PAID | FAILED`, `PENDING → CANCELLED`; guarded transitions with a history; the books move with the state (sent, or reversed).
- **Payout destinations**: where each shop is paid (the shop's payment-provider account), who may change it, and a cooling period after a change.
- **Seller and operator API**: the seller's payout list, one payout, and the upcoming payout; operators' payout list, run list, destination, reserve, and cancel (with `Idempotency-Key`).
- **Payout audit**: a daily check that payouts marked paid really exist at the provider with the same amount, currency and destination.
- **Events** other capabilities react to: payout created, paid, failed, cancelled, in doubt, discrepancy detected.
- **Migration** of the existing `Payout` data and of the payment-provider account ID that today lives on `Shop`.

Out of scope (owners named):

- The ledger itself (journals, balances, the non-negative guard, the balance read model, `GET /shops/:shopId/balance`, daily reconciliation of charges and refunds) → **S14**. S15 only calls S14's exports.
- Payment intents, charges, refunds → **S13**. Orders, checkout, the provider's signed webhooks → **S10**. Monthly statements and commission rates → **S16**. Subscriptions → **S17**.
- Shops, roles, the `payouts.read` permission, `payoutsEnabled`, shop status → **S03**. Identity verification that sets `payoutsEnabled` → **S04** (S15 never reads bank details or documents).
- Notifications about payouts → **S28** (it consumes our events). The seller's payout screens → **W04** and journey **J01**; this capability provides the API.
- Jobs, schedules, leases → **S49**; outbox and consumers → **S53**; rate limiter → **S50**; problem+json, idempotency facility, clock, config, metrics, shutdown → **S54**; authentication → **S01**.
- Currency conversion, partial payouts on request, instant (on-demand) payouts, taxes, seller-initiated destination changes (a seller-facing connect flow), provider-side transfer reversals handled automatically, cold storage of old payouts.

Cross-domain data used (IX.7): shop status and `payoutsEnabled` by **R1** (`ShopQueryService.getShopsByIds`, S03); seller balances and journal postings by **R1** (`LedgerService`, S14); shop access by **R1** (`ShopScoped`, S03); the payout destination is **this domain's own data** (the payment-provider account ID moves off `Shop`); other capabilities learn about payouts by **R3** events (`payouts.events`). The payment provider is an external system behind a domain port.

## User Scenarios & Testing *(mandatory)*

Notation: amounts are integer minor units (`45000` = 450.00 EUR); the currency is `EUR`. "At `T`" means the injected clock reads `T`. Platform defaults: minimum payout `1000`, default reserve `1000` basis points (10%), per-payout cap `5000000`, cooling period 48 h, in-doubt flag after 24 h, provider call timeout 10 s. `W` is the week starting Monday `2026-10-05`. `SHOP_a` is shop `a`'s seller account, `PAYOUT_CLEARING` and `PAYOUTS_SENT` are system accounts (S14). A **negative** journal line is a debit, a positive one a credit. An **eligible shop** is active, `payoutsEnabled`, with an effective destination. `acct_a` is shop `a`'s destination.

### User Story 1 — The weekly run pays every eligible seller exactly once (Priority: P1)

Once a week the platform pays sellers what they are owed. The run can be repeated, can overlap with itself, can crash halfway, and can meet shops that are not ready to be paid, and the result is still one payout per shop per week with the books exactly right.

**Why this priority**: a missed payout is a support case; a double or phantom payout is lost money (SD-20 seller payouts, 10/02 Ex1 exactly-once effect).

**Independent Test**: seed balances through S14's posting API, call the run for `W`, repeat and race it; assert payout rows, journals, queued jobs and outbox rows in the real store.

**Acceptance Scenarios**:

1. **AS-01** (happy path) — **Given** shops `a` (`SHOP_a = +50000`) and `b` (`+20000`), both eligible, default reserve, **When** the run for `W` executes at `T`, **Then** payout `Pa` exists with `amountMinor 45000`, `reserveHeldMinor 5000`, `status PENDING`, `periodStart 2026-10-05`, destination snapshot `acct_a`; payout `Pb` with `18000` / `2000`; for each, exactly one `PAYOUT` journal with reference = payout ID and lines `[SHOP_x −amount, PAYOUT_CLEARING +amount]`, exactly one transfer job queued for the payout, one `payout.created` v1 event in the outbox, one history row (`∅ → PENDING`); after commit `SHOP_a = 5000`, `SHOP_b = 2000`, `PAYOUT_CLEARING = 63000`; the run record for `2026-10-05` is `COMPLETED` with `created 2`.
2. **AS-02** (re-run) — **Given** AS-01 completed, **When** the run for `W` executes again, **Then** no payout, journal, job or event is added; the run record counts `existing 2`, `created 0`; balances are unchanged.
3. **AS-03** (concurrent runs) — **Given** 20 eligible shops, **When** two runs for `W` start at once (`Promise.all`, repeated 20 times), **Then** exactly one payout per shop exists, exactly one `PAYOUT` journal per payout, 20 jobs, 20 events, and every balance moved once.
4. **AS-04** (reserve arithmetic) — **Given** the rule "reserve = ⌈balance × bps ÷ 10000⌉, payout = balance − reserve", **Then** `(50000, 1000) → reserve 5000, payout 45000`; `(12345, 1000) → 1235, 11110`; `(1001, 1000) → 101, 900`; `(20000, 0) → 0, 20000`; `(20000, 5000) → 10000, 10000`; `(1, 1000) → 1, 0`; `(9007199254740000, 1000) → 900719925474000, 8106479329266000` (no overflow); for any balance in `[0, 2^53)` and bps in `[0, 5000]`: `reserve + payout = balance`, `0 ≤ reserve ≤ balance`, `payout ≥ 0`.
5. **AS-05** (per-shop reserve) — **Given** an operator set shop `b`'s reserve to `0` bps and shop `c`'s to `2500`, **When** the run executes, **Then** `b` is paid its full balance, `c` is paid `balance − ⌈balance × 0.25⌉`, and a shop with no override uses the default.
6. **AS-06** (minimum payout) — **Given** shops with balances `1000`, `999`, `1050` and a `0` bps / `1000` bps / `1000` bps reserve respectively, **When** the run executes, **Then** the first is paid `1000` (the minimum is inclusive); the second is not considered (below the minimum before the reserve); the third (payout `945`) is skipped with reason `below_minimum`, creates no payout, journal or job, and its balance is untouched and counted by the run (`skipped.below_minimum 1`); the next week's run includes it.
7. **AS-07** (cap) — **Given** shop `a` at `+6000000` with a `0` bps reserve, **When** the run executes, **Then** the payout is `5000000` and `SHOP_a` keeps `1000000`; the reserve held is `0` (the cap is not a reserve); next week's run pays the rest.
8. **AS-08** (nothing owed) — **Given** shops at `0`, `−500` (a clawback), and `+500`, **When** the run executes, **Then** none gets a payout and none is counted as skipped for a reason (they never reach eligibility).
9. **AS-09** (eligibility gates) — **Given** otherwise payable shops, one each of: `payoutsEnabled = false`; status not `ACTIVE`; unknown to tenancy; no destination; a destination changed less than 48 h ago, **When** the run executes, **Then** each is skipped with its own reason (`payouts_disabled`, `shop_not_active`, `shop_unknown`, `destination_missing`, `destination_cooling`), no payout, journal, job or event exists for it, its balance is untouched, the run's `skipped` counters show one per reason, and a log line names the shop and reason.
10. **AS-10** (balance changed during the run) — **Given** shop `a` listed at `+50000` and an ad charge of `10000` booked before its creation step starts, **When** the run processes `a`, **Then** the payout is computed from the authoritative balance read inside the creation transaction (`40000`: reserve `4000`, payout `36000`), never from the listing; **Given** instead the ad charge is booked after that read and before the payout journal is posted (forced interleaving) so the payout of `45000` would overdraw `SHOP_a`, **Then** S14 refuses the journal with `insufficient_balance`, that shop's transaction rolls back (no payout row, no job, no event), it is skipped with reason `insufficient_balance`, the balance is `40000`, and the other shops proceed.
11. **AS-11** (ledger trouble) — **Given** the ledger's listing fails, **When** the run executes, **Then** the run record is `FAILED` with `failureCode ledger_unavailable`, nothing was created, and the job layer retries it; **Given** one shop's posting raises `LedgerBusy`, **Then** that shop is skipped with reason `ledger_busy` and the others are paid; a re-run pays it.
12. **AS-12** (paging, no N+1) — **Given** 450 eligible shops, **When** the run executes, **Then** all 450 get a payout, balances are listed in pages of 200 by keyset, tenancy is asked in batches of at most 200 IDs (3 calls, not 450), and the authoritative balance is read in batches.
13. **AS-13** (the period) — **Given** a run with no period at `2026-10-07T10:00Z`, **Then** `periodStart` is `2026-10-05`; at `2026-10-04T23:59:59Z` (Sunday) it is `2026-09-28`; at `2026-10-05T00:00:00Z` it is `2026-10-05`; **Given** an explicit period that is not a Monday (`2026-10-06`), in the future, malformed, or more than 52 weeks old, **Then** the run is refused with `period_invalid` and nothing is created.
14. **AS-14** (schedule) — **Given** application start, **Then** one schedule `payouts.run-weekly` exists for Monday 06:00 `Europe/Warsaw` (re-registering it changes nothing); **Given** a clock at that moment in a week that contains a daylight-saving change, **Then** exactly one run is due and its period is that Monday.
15. **AS-15** (crash midway) — **Given** 5 eligible shops and a forced process stop after the second payout committed, **When** the run is retried, **Then** shops 1–2 are untouched (`existing 2`), shops 3–5 get their payouts, and the totals equal an uninterrupted run: five payouts, five journals, five jobs.
16. **AS-16** (one atomic step) — **Given** a forced failure at each of: the payout insert, the journal posting, the job enqueue, the event append, **When** the shop is processed, **Then** none of the four exists afterwards (all rolled back), no provider call happened, and the shop is paid by the next run.

---

### User Story 2 — Each payout reaches the provider exactly once, and an unanswered request is never resent blindly (Priority: P1)

Sending money is the one step that cannot be undone. The transfer carries the payout's own ID as its idempotency key, only one worker may send a given payout, and when the provider does not answer the platform asks it instead of guessing.

**Why this priority**: a double transfer is a direct loss; a transfer marked failed while it actually happened pays the seller twice when the money is returned (10/02 Ex1; P0414).

**Independent Test**: drive a payout through the transfer step against a scriptable provider double (success, rejection, timeout, 429/5xx, garbage, crash after success) with a call log; assert provider calls, payout rows, journals and events.

**Acceptance Scenarios**:

17. **AS-17** (success) — **Given** payout `Pa` (`45000`, `PENDING`, destination snapshot `acct_a`), **When** its transfer job runs, **Then** the payout is first claimed (`PENDING → SENDING`, history row) and that claim commits before the provider is called; the provider receives exactly one transfer `{amountMinor 45000, currency EUR, destination acct_a, idempotencyKey = Pa, reference Pa}`; on success one transaction sets `PAID`, stores the provider's `transferRef` and `paidAt`, posts a `PAYOUT` journal with reference `Pa:sent` and lines `[PAYOUT_CLEARING −45000, PAYOUTS_SENT +45000]`, writes the history row and one `payout.paid` v1 event; `PAYOUT_CLEARING` is back to its earlier balance.
18. **AS-18** (duplicate and concurrent delivery) — **Given** `Pa` `PENDING`, **When** its transfer job is delivered 10 times at once (`Promise.all`, repeated 20 times), **Then** exactly one worker claims it, the provider double records exactly one transfer for `Pa`, the others finish without calling the provider, and the payout has one `PAID` transition, one sent journal and one event.
19. **AS-19** (crash after the provider accepted) — **Given** the provider accepted the transfer and the process stopped before the result was recorded (forced), **Then** the payout stays `SENDING` with the money still in `PAYOUT_CLEARING`; **When** the same job is redelivered, **Then** the provider is called again with the **same** key and answers with the same `transferRef` (one transfer at the provider), and the payout becomes `PAID` once; **When** instead the payout has been `SENDING` for more than 5 minutes with no job running, **Then** the resolver asks the provider for the transfer of reference `Pa`, finds it, and records `PAID` without any new transfer.
20. **AS-20** (the provider does not answer) — **Given** a transfer call that exceeds the 10 s limit, **When** it times out, **Then** the payout becomes `UNKNOWN` (history row), no reversal is posted, the money stays in `PAYOUT_CLEARING`, no second transfer with another key is ever created; the resolver asks the provider for reference `Pa` after delays of 1, 2, 4, … minutes with full jitter, capped at 15 minutes; when the provider reports the transfer, the payout becomes `PAID` (sent journal, event) exactly as in AS-17; when it reports the transfer as rejected, `FAILED` as in AS-23.
21. **AS-21** (the provider has no such transfer) — **Given** an `UNKNOWN` payout and a provider that answers "no transfer with this reference", **When** the resolver runs, **Then** it sends the transfer again with the same key (at most 3 times, spaced by the resolver's delays); a confirmed transfer becomes `PAID`; a definite rejection becomes `FAILED` with reversal; after the 3 attempts the payout stays `UNKNOWN`.
22. **AS-22** (the provider is unreachable while resolving) — **Given** an `UNKNOWN` payout, **When** the lookup times out, fails, or its breaker is open, **Then** the payout stays `UNKNOWN` (never `FAILED` because the provider was unreachable) and the next check is scheduled; **Given** it has been `UNKNOWN` or `SENDING` for more than 24 h, **Then** exactly one `payout.in_doubt` v1 event is emitted for it, `payout_in_doubt_age_seconds` shows the oldest, and nothing else changes (an operator decides outside this capability).
23. **AS-23** (definite rejection) — **Given** the provider answers with a definite rejection (`account_closed`, `invalid_destination`, `insufficient_platform_funds`) for `Pa`, **When** processed, **Then** one transaction sets `FAILED` with `failureCode` (`destination_rejected` or `provider_rejected`), a sanitized `failureReason` of at most 200 characters without the destination or any secret, posts a `PAYOUT_REVERSAL` journal with reference `Pa` and lines `[PAYOUT_CLEARING −45000, SHOP_a +45000]`, writes history and one `payout.failed` v1 event; `SHOP_a` is back to `50000` and `PAYOUT_CLEARING` is back to its earlier balance; the payout is not retried; the shop's next weekly run may pay it again (a new week, a new payout).
24. **AS-24** (transient failures) — **Given** the provider answers `429`, `502`, `503`, `504` or resets the connection, **When** the job runs, **Then** the payout stays `SENDING`, the job layer retries it (the only retry layer; the provider port retries nothing) with exponential backoff and full jitter, at most 5 attempts, each with the same key; a later success gives `PAID` once; after the fifth failure the payout becomes `UNKNOWN`; a `400`-class rejection is never retried (AS-23).
25. **AS-25** (the provider's answer is not trusted) — **Given** a "success" answer with an amount different from `45000`, a currency other than `EUR`, a destination other than `acct_a`, a missing or empty `transferRef`, or a malformed body, **When** processed, **Then** the payout is not marked `PAID`: it becomes `UNKNOWN`, `payout_provider_mismatch_total{kind}` increments, a `payout.discrepancy_detected` v1 event is emitted, and nothing is posted.
26. **AS-26** (the destination is fixed at creation) — **Given** `Pa` created with destination `acct_a`, **When** an operator changes shop `a`'s destination to `acct_new` before the transfer runs, **Then** the transfer goes to `acct_a` (the snapshot), and the new destination applies from the next payout (after the cooling period).
27. **AS-27** (the state machine) — **Given** each (state, event) pair over states `PENDING, SENDING, UNKNOWN, PAID, FAILED, CANCELLED` and events `claim, provider_success, provider_rejected, provider_unknown, retries_exhausted, resolver_found_paid, resolver_found_rejected, cancel`, **Then** exactly these transitions are allowed: `PENDING+claim→SENDING`, `PENDING+cancel→CANCELLED`, `SENDING+provider_success→PAID`, `SENDING+provider_rejected→FAILED`, `SENDING+provider_unknown→UNKNOWN`, `SENDING+retries_exhausted→UNKNOWN`, `SENDING+resolver_found_paid→PAID`, `SENDING+resolver_found_rejected→FAILED`, `UNKNOWN+resolver_found_paid→PAID`, `UNKNOWN+resolver_found_rejected→FAILED`, `UNKNOWN+provider_success→PAID`, `UNKNOWN+provider_rejected→FAILED`; every other pair is refused; `PAID`, `FAILED` and `CANCELLED` accept nothing; every status switch is exhaustive.
28. **AS-28** (late conflicting outcome) — **Given** a payout already `PAID` (by the resolver), **When** a delayed transfer job reports a rejection, or one already `FAILED` and a delayed job reports success, **Then** the payout is unchanged, no journal is posted, `payout_conflicting_outcome_total` increments, and a `payout.discrepancy_detected` event is emitted once.
29. **AS-29** (no network inside a transaction) — **Given** a provider double that blocks mid-call, **When** the transfer is in flight, **Then** the payout row is readable and no database transaction or lock held by the transfer job is open (a second connection can read and update unrelated rows of the payout table without waiting); the claim and the result are two separate short transactions.
30. **AS-30** (job and resolver at once) — **Given** a `SENDING` payout that is stale, **When** the redelivered job and the resolver both finish with success at the same time (`Promise.all`, repeated 50 times), **Then** exactly one `PAID` transition, one sent journal, one event; the other is a no-op.

---

### User Story 3 — Sellers see what they were paid and what comes next (Priority: P1)

A seller can see every payout with a plain status, and what next Monday's payout will be, without asking support.

**Why this priority**: payouts are why sellers use the marketplace; an unexplained gap generates the most expensive support tickets.

**Independent Test**: seed payouts and balances, sign in as shop members, call the three seller routes; assert bodies against the shared contracts and that nothing about other shops or internal fields leaks.

**Acceptance Scenarios**:

31. **AS-31** (the list) — **Given** shop `a` has payouts for `2026-09-14` (`PAID`), `2026-09-21` (`FAILED`), `2026-09-28` (`SENDING`), `2026-10-05` (`PENDING`) and user `m` is a member of `a` with `payouts.read`, **When** `m` calls `GET /shops/a/payouts?limit=10`, **Then** `200 {items, nextCursor: null}` ordered by `periodStart` descending then ID descending; each item is `{id, shopId, periodStart, amountMinor, reserveHeldMinor, currency, status, transferRef: string | null, failureCode: string | null, createdAt, paidAt: string | null}`; the body parses with `payoutPageSchema`; `SENDING` and `UNKNOWN` are shown as `IN_TRANSIT`, so the statuses are `PENDING | IN_TRANSIT | PAID | FAILED | CANCELLED`; the destination, attempt counts, raw failure reason and other shops' payouts never appear.
32. **AS-32** (paging) — **Given** 5 payouts, **When** `m` pages with `limit=2` and the returned cursor, **Then** pages hold 2, 2, 1 items in order with no repeat or gap, even if a new payout is created between pages; **Given** a missing `limit`, **Then** the default is 20; **Given** `limit=0`, `limit=101`, or a non-number, **Then** `400 validation_failed`; **Given** a tampered or foreign cursor, **Then** `400 invalid_cursor`.
33. **AS-33** (one payout) — **Given** payout `P` of shop `a`, **When** `m` calls `GET /shops/a/payouts/P`, **Then** `200` with the item of AS-31 plus `timeline: [{status, at}]` (the public statuses in order, from the history); **Given** `P` belongs to shop `b`, **When** `m` calls `GET /shops/a/payouts/P`, **Then** `404 payout_not_found` identical to an ID that does not exist (the owner is in the lookup, never checked afterwards); a malformed ID is `400 validation_failed`.
34. **AS-34** (access) — **Given** no session, **Then** `401` on all three routes; **Given** a user who is not a member of `a`, **Then** `404 shop_not_found` byte-identical to the answer for a shop that does not exist; **Given** a member whose role lacks `payouts.read`, **Then** `403 permission_denied`; no route returns anything for another shop's payout under any path.
35. **AS-35** (what comes next) — **Given** `SHOP_a = +50000`, an effective destination, `payoutsEnabled`, and the clock at Wednesday `2026-10-07T10:00Z`, **When** `m` calls `GET /shops/a/payouts/upcoming`, **Then** `200 {shopId, currency: "EUR", availableMinor: 50000, reserveMinor: 5000, estimatedPayoutMinor: 45000, nextRunAt: "2026-10-12T04:00:00.000Z", blockedReason: null}` (Monday 06:00 Warsaw, daylight time, in UTC); **Given** payouts disabled, no destination, a destination still cooling, or an estimated payout below the minimum, **Then** `estimatedPayoutMinor` is `0` and `blockedReason` is `payouts_disabled`, `destination_missing`, `destination_cooling`, or `below_minimum`; the route name is never read as a payout ID.
36. **AS-36** (rate limit) — **Given** the seller read limit of 120 per minute per user, **When** a user makes the 121st call within a minute, **Then** `429 rate_limited` with `Retry-After`; **Given** the limiter's store is down, **Then** seller reads still succeed (fail open).
37. **AS-37** (the journey) — **Given** a signed-in shop owner with one `PAID` and one `PENDING` payout, **When** they open the payouts page of the seller dashboard, **Then** they see both payouts with amounts, statuses and week, and the upcoming payout with its reserve and next run date (UI journey, owned by W04 and J01; this capability provides AS-31 and AS-35).

---

### User Story 4 — Operators set destinations and reserves and can stop a payout in time (Priority: P2)

Support and finance staff decide where a shop is paid, how much is held back, and can cancel a payout that has not gone to the provider yet. Every change is recorded, safe to repeat, and protected against redirecting a seller's money.

**Why this priority**: it is the control surface for fraud holds and chargeback risk; without it the weekly run is all-or-nothing.

**Independent Test**: call the operator routes as an admin and as other users with `Idempotency-Key`; assert responses, rows, history and that the next run reflects them.

**Acceptance Scenarios**:

38. **AS-38** (set a destination) — **Given** an admin and shop `a` with no destination, **When** they `PUT /finance/shops/a/payout-destination` with `Idempotency-Key: k1` and `{providerAccountId: "acct_1Abc23XyZ"}`, **Then** `200 {shopId, providerAccountId: "acct_…XyZ" (masked: first 5 and last 3 characters), status: "ACTIVE", effectiveFrom: T, changedAt: T}`; the full value is stored once and is never logged or returned again; **Given** a value that does not match `acct_` followed by 8–64 letters or digits (`abc`, empty, 65 characters, spaces), **Then** `422 destination_invalid`; **Given** shop `zzz` unknown to tenancy, **Then** `404 shop_not_found`; **Given** a non-admin (including the shop's owner), **Then** `403 permission_denied`; **Given** no session, `401`.
39. **AS-39** (cooling after a change) — **Given** shop `a` has destination `acct_a`, **When** an admin sets `acct_new` at `T`, **Then** `effectiveFrom = T + 48 h`; **When** the run executes at `T + 47 h 59 min`, **Then** `a` is skipped `destination_cooling` and any earlier `PENDING` payout is unaffected; **When** it executes at `T + 48 h`, **Then** `a` is paid to `acct_new`; **Given** the same value is set again, **Then** nothing changes (no new cooling).
40. **AS-40** (set a reserve) — **Given** an admin, **When** they `PUT /finance/shops/a/payout-reserve` with `Idempotency-Key: k2` and `{reserveBps: 2500, reason: "chargeback risk"}`, **Then** `200 {shopId, reserveBps: 2500, reason, updatedBy, updatedAt}`, one history row, and the next run uses it; `reserveBps` of `-1`, `5001`, `12.5`, a string, a missing field, or a `reason` that is empty or over 200 characters is `400 validation_failed`; non-admin `403`.
41. **AS-41** (idempotency of operator writes) — **Given** AS-40's request, **When** it is replayed with the same key and the same body, **Then** the identical `200` is returned with `Idempotency-Replayed: true` and no second history row; **When** the same key is in flight twice at once, **Then** one succeeds and the other gets `409 idempotency_in_flight`; **When** the same key is sent with a different body, **Then** `422 idempotency_key_reuse` and nothing changes; **When** the header is missing, **Then** `422 idempotency_key_required`; **When** the same key is sent again after the retention window of 24 h, **Then** it is processed as a new request; a request that failed validation does not consume its key.
42. **AS-42** (cancel a pending payout) — **Given** payout `Pa` `PENDING`, **When** an admin calls `POST /finance/payouts/Pa/cancel` with `Idempotency-Key` and `{reason: "fraud hold"}`, **Then** `200` with the payout `CANCELLED`; one transaction posts a `PAYOUT_REVERSAL` journal (reference `Pa`, `[PAYOUT_CLEARING −45000, SHOP_a +45000]`), writes history with the actor and reason and one `payout.cancelled` v1 event; `SHOP_a` is `50000` again; when the queued transfer job runs later it finds `CANCELLED` and never calls the provider.
43. **AS-43** (illegal cancel) — **Given** a payout in `SENDING`, `UNKNOWN`, `PAID`, `FAILED` or `CANCELLED`, **When** an admin cancels it, **Then** `409 payout_state_conflict` with `details {status}`; nothing changes (a transfer that may already be at the provider is never cancelled from here).
44. **AS-44** (cancel against send) — **Given** `Pa` `PENDING`, **When** the cancel request and the transfer job run at once (`Promise.all`, repeated 50 times), **Then** exactly one wins: either `CANCELLED` (provider never called, one reversal) or the cancel returns `409 payout_state_conflict` and the payout goes on to `PAID`; in every run the sum of ledger lines is `0`, `PAYOUT_CLEARING` equals the sum of payouts in `PENDING`, `SENDING` and `UNKNOWN`, and no shop is both refunded and paid.
45. **AS-45** (who may cancel, and what exists) — **Given** a shop owner or any non-admin, **Then** `403 permission_denied` and nothing changes; **Given** no session, `401`; **Given** an ID that does not exist, `404 payout_not_found`; a malformed ID `400 validation_failed`; a missing or empty `reason` `400 validation_failed`.
46. **AS-46** (the operator list) — **Given** payouts in several shops and states, **When** an admin calls `GET /finance/payouts?status=UNKNOWN&shopId=a&periodStart=2026-10-05&limit=2`, **Then** `200 {items, nextCursor}` filtered, newest first by `(createdAt, id)` keyset, with the internal statuses (`SENDING` and `UNKNOWN` shown as they are) and, per item, `attempts`, `failureReason`, `destination` masked as in AS-38; bad filters or limits are `400 validation_failed`, a bad cursor `400 invalid_cursor`; non-admin `403`; no session `401`.
47. **AS-47** (the runs) — **Given** completed, failed and resumed runs, **When** an admin calls `GET /finance/payouts/runs?limit&cursor`, **Then** `200` with items `{periodStart, status: "RUNNING" | "COMPLETED" | "FAILED", created, existing, skipped: {reason: count}, failureCode: string | null, startedAt, finishedAt: string | null}` newest first; non-admin `403`.
48. **AS-48** (operator rate limit) — **Given** the operator write limit of 30 per minute per user, **When** an admin makes the 31st write within a minute, **Then** `429 rate_limited`; **Given** the limiter's store is down, **Then** operator writes answer `503` (fail closed) and nothing changes.

---

### User Story 5 — Payouts are proven against the provider and the domain is safe and observable (Priority: P3)

Every day the platform checks that what it calls paid was really paid; every failure mode leaves a signal; the domain touches only its own data.

**Why this priority**: it turns silent drift into an alert and closes the loop that S14's reconciliation deliberately leaves open (transfer lines are skipped there).

**Independent Test**: run the audit against a scripted provider; scan the code and the store for cross-domain access; start the app with bad configuration.

**Acceptance Scenarios**:

49. **AS-49** (payout audit) — **Given** payouts `PAID` on day `D` and a provider double answering their transfers by reference, **When** the daily audit runs for `D`, **Then** a matching payout yields nothing; a transfer with another amount, currency or destination, a payout with no transfer at the provider, and a transfer the provider shows as reversed after we marked it `PAID` each increments `payout_discrepancy_detected_total{kind}` and emits one `payout.discrepancy_detected` v1 event, and the payout is unchanged; running the audit twice for `D` emits nothing new; a provider outage ends the run `FAILED` and retries without partial output.
50. **AS-50** (the events) — **Given** any payout transition, **Then** its event is appended to the outbox in the same transaction (rolled back together), with envelope `{eventId, type, version: 1, occurredAt, aggregateId = payoutId}` and the payload of the "Provides" section including `payoutVersion`; payloads contain no destination, no provider account ID and no secret; every event parses with its `packages/contracts` schema; delivery is by the relay to the topic, never a direct publish.
51. **AS-51** (metrics and logs) — **Given** each outcome of AS-01–AS-49, **Then** the metrics named in FR-052 move by the stated amount, every log line is structured with `requestId` or `jobId` and `payoutId`/`shopId`, and no log line contains a destination account ID, a provider key, or a request body.
52. **AS-52** (boundaries) — **Given** the ownership check, **Then** payout code references only tables the payments domain owns (`Payout`, `PayoutHistory`, `PayoutRun`, `PayoutDestination`, `PayoutReserve`), has no foreign key to `Shop`, injects no `Shop`, `User` or `BisOrder` model, uses no raw SQL on `LedgerEntry`, and the barrel exports no payout model; shop facts come through R1 `getShopsByIds` and balances through R1 `getBalances` / `listSellerBalances`.
53. **AS-53** (migration of existing data) — **Given** existing `Payout` rows (`amount`, status `PENDING|PAID|FAILED`, `failureReason`) and `Shop.stripeAccountId` values, **When** the migration runs (twice), **Then** every existing payout keeps its ID, status, week and amount (now `amountMinor`), gets `reserveHeldMinor 0`, a destination snapshot where the shop had an account, one history row, and no `Shop` foreign key remains; every non-null `stripeAccountId` becomes an `ACTIVE` destination effective immediately; running it again changes nothing; code that still reads the old columns keeps working until the contract step.
54. **AS-54** (configuration) — **Given** a default reserve above `5000` or below `0`, a minimum payout of `0` or negative, a cap below the minimum, a provider timeout of `0`, a cooling period negative, or a missing provider credential, **When** the application starts, **Then** startup fails naming the key and the rule; no secret value appears in the message.
55. **AS-55** (shutdown during a run) — **Given** a run in progress, **When** the process receives its stop signal, **Then** the shop being processed commits or rolls back whole, no new shop is started, the run record is `FAILED` with `failureCode interrupted`, and the job layer's retry resumes it (AS-15).

---

### Edge Cases

- A shop is paid, and in the same week a refund or clawback pushes its balance negative: the next run sees `≤ 0` and creates nothing (AS-08); the payout already made is not clawed back here.
- A shop deleted or suspended between the run's start and its payout: it is skipped (`shop_unknown`, `shop_not_active`); if it was paid before, the transfer still completes (the money already left the shop's balance).
- The same week run by two replicas, by a manual re-run, or by a retry after a crash: one payout per shop (AS-02, AS-03, AS-15).
- A transfer job delivered twice, late, or after the payout was cancelled or resolved: no second provider call, no second journal (AS-18, AS-28, AS-42).
- The provider is slow, down, answers garbage, or answers success with a different amount (AS-20, AS-22, AS-25).
- A destination changed right before a run, or between creation and transfer (AS-26, AS-39).
- A payout below the minimum after the reserve, at exactly the minimum, or above the cap (AS-06, AS-07).
- Boundary weeks: Sunday night versus Monday morning in UTC, a daylight-saving week, a period in the future (AS-13, AS-14).
- A balance changed between listing and posting (AS-10); the ledger busy or down (AS-11).
- A seller reading another shop's payout, a viewer-role member, a non-member (AS-33, AS-34).
- An operator replaying, racing, or reusing a key with a different body (AS-41); cancelling something already sent (AS-43, AS-44).
- Money amounts at the safe-integer edge (AS-04); a transfer in a currency other than the payout's (AS-25).
- A transfer that succeeded at the provider but whose result we lost (AS-19); stuck in doubt for a day (AS-22).

## Requirements *(mandatory)*

### Functional Requirements

**The weekly run**

- **FR-001**: A scheduled run MUST execute every Monday at 06:00 `Europe/Warsaw` (once per week across all replicas, idempotent) for the period starting that Monday (UTC date); an explicit period MUST be a Monday, not in the future, and at most 52 weeks old, else `period_invalid` (AS-13, AS-14).
- **FR-002**: The run MUST consider only shops whose seller-account balance is at least the minimum payout, listing them by keyset pages of 200 and reading each shop's authoritative balance inside the creation step; it MUST NOT sum ledger history (AS-10, AS-12).
- **FR-003**: Eligibility MUST require: shop known to tenancy, status `ACTIVE`, `payoutsEnabled`, an effective destination (not cooling); a shop failing a gate MUST be skipped with a named reason, creating nothing (AS-09).
- **FR-004**: Per shop, one transaction MUST create the payout, post the `PAYOUT` journal (seller account → payout clearing), write the history row, append `payout.created`, and enqueue the transfer job; any failure MUST roll all of them back (AS-01, AS-16).
- **FR-005**: There MUST be at most one payout per (shop, period) enforced by the store; re-runs, concurrent runs and resumed runs MUST create nothing twice (AS-02, AS-03, AS-15).
- **FR-006**: The amount MUST be `balance − reserve`, capped at the per-payout cap, and MUST be at least the minimum, else the shop is skipped `below_minimum`; the capped remainder stays in the seller's balance (AS-06, AS-07).
- **FR-007**: A refused posting (`insufficient_balance`, `LedgerBusy`) MUST skip that shop only, with a named reason, and a ledger-wide failure MUST fail the run for retry without creating anything (AS-10, AS-11).
- **FR-008**: Each run MUST be recorded per period with status, counts (`created`, `existing`, `skipped` per reason), failure code and times; a re-execution updates the same record (AS-01, AS-02, AS-47).
- **FR-009**: Network calls (tenancy batches, ledger reads) MUST be batched, never one per shop (AS-12); no provider call may happen in the run (AS-16).
- **FR-010**: An interrupted run MUST stop between shops and be resumable by re-running the same period (AS-15, AS-55).

**Reserves**

- **FR-011**: Reserve MUST be `⌈balance × bps ÷ 10000⌉` in integer arithmetic that cannot overflow for any balance below 2^53, payout `balance − reserve`; `reserve + payout = balance` MUST hold exactly (AS-04).
- **FR-012**: The platform default reserve MUST be configurable; an operator MAY override it per shop within 0–5000 basis points with a reason; the payout MUST record the reserve it held (`reserveHeldMinor`) (AS-05, AS-40).

**Provider transfer and idempotency**

- **FR-013**: The transfer step MUST claim the payout (`PENDING → SENDING`, committed) before any provider call; a payout that is not claimable MUST be left alone (AS-17, AS-18).
- **FR-014**: The transfer MUST carry the payout ID as the provider idempotency key and reference, the payout's amount, currency and destination snapshot; every retry of the same payout MUST reuse the same key (AS-17, AS-19, AS-24).
- **FR-015**: No provider call MUST happen inside an open database transaction; the claim and the result are separate short transactions (AS-29).
- **FR-016**: Every provider call MUST have a 10 s timeout; the provider port MUST NOT retry; retries happen only in the job layer and only for transient failures (429, 502, 503, 504, reset), at most 5 attempts, exponential backoff with full jitter (AS-24).
- **FR-017**: A timeout, an exhausted retry budget, or an untrusted answer MUST leave the payout `UNKNOWN` with the money in payout clearing; the transfer MUST NOT be reversed or re-created under another key (AS-20, AS-24, AS-25).
- **FR-018**: A resolver MUST settle `SENDING` payouts stale for more than 5 minutes and `UNKNOWN` payouts by asking the provider for the payout's reference, with backoff (1, 2, 4 … minutes, full jitter, capped at 15 minutes); a provider that does not know the transfer MUST be sent the same transfer again, at most 3 times; an unreachable provider MUST NOT cause `FAILED` (AS-19, AS-20, AS-21, AS-22).
- **FR-019**: A definite rejection MUST end `FAILED` with a reversal journal returning the amount to the seller account, in the same transaction, with a sanitized reason (AS-23).
- **FR-020**: The provider's answer MUST be validated (amount, currency, destination, non-empty reference, shape) before a payout becomes `PAID`; a mismatch MUST be reported and the payout left `UNKNOWN` (AS-25).
- **FR-021**: The `PAID` transition MUST post a `PAYOUT` journal with reference `<payoutId>:sent` (payout clearing → payouts sent), exactly once, in the transaction that sets `PAID` (AS-17, AS-30).
- **FR-022**: A payout in doubt for more than 24 h MUST raise one `payout.in_doubt` event and a metric, and MUST NOT change state on its own (AS-22).
- **FR-023**: The destination used by a transfer MUST be the snapshot taken at creation (AS-26).

**Payout states**

- **FR-024**: Statuses are `PENDING, SENDING, UNKNOWN, PAID, FAILED, CANCELLED`; the allowed transitions are exactly those of AS-27; each transition MUST be a conditional update that asserts one row changed, with a history row (from, to, at, actor or `system`, reason) in the same transaction (AS-27, AS-28).
- **FR-025**: `PAID`, `FAILED` and `CANCELLED` MUST be final; a late or conflicting outcome MUST change nothing and MUST be counted and reported (AS-28).
- **FR-026**: The books MUST follow the state: payout clearing equals the sum of payouts in `PENDING`, `SENDING` and `UNKNOWN`; `PAID` moves the amount to payouts sent; `FAILED` and `CANCELLED` return it to the seller account (AS-17, AS-23, AS-42, AS-44).
- **FR-027**: All S15 journals MUST be posted through S14's exported posting call with `(kind, reference)` = `(PAYOUT, payoutId)`, `(PAYOUT, payoutId:sent)`, `(PAYOUT_REVERSAL, payoutId)`, inside the caller's transaction, and MUST rely on S14's atomic non-negative guard rather than a check-then-write (AS-10, AS-44).

**Destinations**

- **FR-028**: Each shop has at most one current payout destination (a payment-provider account ID) owned by this capability; only a platform admin MAY set it; the value MUST match `acct_` + 8–64 letters or digits (AS-38).
- **FR-029**: Changing an existing destination to a different value MUST make the new one effective only after the cooling period (48 h, configurable); a first destination is effective immediately; setting the same value again changes nothing (AS-39).
- **FR-030**: The destination MUST be masked in every response and absent from logs, events and seller responses (AS-38, AS-50, AS-51).

**Seller API**

- **FR-031**: `GET /shops/:shopId/payouts` MUST return a keyset page (default 20, max 100, opaque cursor, order `periodStart DESC, id DESC`) of explicit payout DTOs with the public statuses `PENDING | IN_TRANSIT | PAID | FAILED | CANCELLED`, for members with `payouts.read` only (AS-31, AS-32).
- **FR-032**: `GET /shops/:shopId/payouts/:payoutId` MUST look the payout up by (ID, shop) together and return the DTO plus a status timeline; another shop's or an unknown payout MUST be an identical `404 payout_not_found` (AS-33).
- **FR-033**: `GET /shops/:shopId/payouts/upcoming` MUST return the current available balance, the reserve, the estimated payout, the next run time and the blocking reason, using the same rules as the run (AS-35).
- **FR-034**: Non-members MUST get the same `404 shop_not_found` as for an unknown shop; members without the permission `403`; unauthenticated `401`; invalid input `400 validation_failed`; a bad cursor `400 invalid_cursor` (AS-32, AS-34).
- **FR-035**: Seller reads MUST be limited to 120 per minute per user (fail open), with `Retry-After` on `429` (AS-36).

**Operator API**

- **FR-036**: `PUT /finance/shops/:shopId/payout-destination`, `PUT /finance/shops/:shopId/payout-reserve` and `POST /finance/payouts/:payoutId/cancel` MUST require the platform admin role and a mandatory `Idempotency-Key`, with stored replay, in-flight `409`, different-body `422`, a 24 h retention, and the `Idempotency-Replayed` header (AS-38, AS-40, AS-41, AS-42).
- **FR-037**: Cancel MUST be allowed only from `PENDING`, with a reason, and MUST reverse the journal in the same transaction; any other state MUST be `409 payout_state_conflict` with the current status (AS-42, AS-43).
- **FR-038**: Cancel and the transfer claim MUST be mutually exclusive: exactly one of them wins a race (AS-44).
- **FR-039**: `GET /finance/payouts` (filters `status`, `shopId`, `periodStart`; keyset by `(createdAt, id)`) and `GET /finance/payouts/runs` MUST be admin-only, with internal statuses and masked destinations (AS-46, AS-47).
- **FR-040**: Operator writes MUST be limited to 30 per minute per user, failing closed when the limiter is down; operator reads 120 per minute, failing open (AS-48).
- **FR-041**: Every operator change MUST record who made it, when, and why (history), and MUST apply to payouts created afterwards, never to ones already created (AS-26, AS-40).

**Audit, events, safety**

- **FR-042**: A daily audit MUST compare payouts marked `PAID` on the previous UTC day with the provider's transfers by reference (amount, currency, destination, not reversed), report every difference once as a metric and an event, and change nothing; it MUST be idempotent per day (AS-49).
- **FR-043**: Events (`payout.created`, `payout.paid`, `payout.failed`, `payout.cancelled`, `payout.in_doubt`, `payout.discrepancy_detected`) MUST leave through the outbox in the transition's own transaction, with the envelope and payloads of "Provides", no destination or secret, each carrying `payoutVersion` (AS-50).
- **FR-044**: Every transition MUST increment `payoutVersion` so consumers can discard out-of-order or duplicate events (AS-50).
- **FR-045**: The domain MUST read and write only the tables it owns, hold no foreign key to another domain's table, and reach shop and ledger data only through R1 exports (AS-52).
- **FR-046**: Money MUST be integer minor units everywhere, in the store, the API (`…Minor`), the events and the provider call; floating point MUST NOT appear in money paths (AS-04, AS-05).
- **FR-047**: Existing payouts and the destination now on `Shop` MUST be migrated without losing a row or a status, safely repeatable, with old readers working until the contract step (AS-53).
- **FR-048**: Configuration (default reserve, minimum, cap, cooling, timeouts, retry and doubt limits, provider credential) MUST be validated at startup, failing with the key and rule and no secret (AS-54).
- **FR-049**: Shutdown MUST finish or roll back the current shop whole and stop the run for later resumption (AS-55).
- **FR-050**: Each scheduled job (run, resolver, audit) MUST execute once per schedule across replicas and be idempotent (AS-03, AS-14, AS-49).
- **FR-051**: Failures MUST be logged as structured lines carrying a correlation ID, `payoutId` and `shopId`; logs MUST NOT contain destination account IDs, provider keys or request bodies (AS-51).
- **FR-052**: Metrics: `payout_created_total`, `payout_skipped_total{reason}`, `payout_transfer_total{outcome}` (`paid`, `rejected`, `transient`, `unknown`), `payout_in_doubt_age_seconds`, `payout_provider_mismatch_total{kind}`, `payout_conflicting_outcome_total`, `payout_discrepancy_detected_total{kind}`, `payout_run_duration_seconds` and `payout_run_total{status}` (AS-51).

### Key Entities *(include if feature involves data)*

- **Payout**: `{id, shopId, periodStart, currency, amountMinor, reserveHeldMinor, status, destinationSnapshot, transferRef?, failureCode?, failureReason?, attempts, payoutVersion, createdAt, submittedAt?, paidAt?, cancelledAt?}`; unique (shop, period); no link to `Shop` other than the ID.
- **PayoutHistory**: append-only `{payoutId, from, to, at, actor (system or admin ID), reason?}`; one row per transition.
- **PayoutRun**: `{periodStart (unique), status, created, existing, skipped per reason, failureCode?, startedAt, finishedAt?}`.
- **PayoutDestination**: `{shopId (unique), providerAccountId (stored once, never returned in full), effectiveFrom, changedAt, changedBy, version}`; history of changes kept.
- **PayoutReserve**: `{shopId (unique), reserveBps, reason, updatedBy, updatedAt}`; absent means the platform default.
- **Payout status**: the six states above; public mapping `SENDING`, `UNKNOWN` → `IN_TRANSIT`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With 1,000 eligible shops and the run repeated, raced and interrupted, 100% of runs end with exactly one payout per shop and one payout journal per payout.
- **SC-002**: When the same payout's transfer is delivered 10 times at once, 100% of runs produce one transfer at the provider and one recorded payment.
- **SC-003**: After any mix of runs, sends, timeouts, rejections, cancellations and crashes, the sum of all journal lines is `0` and the amount in payout clearing equals the sum of payouts not yet final, in 100% of checked runs.
- **SC-004**: A payout whose provider call times out is never sent a second time under a different key, and is settled without human action whenever the provider answers within 24 h; one that cannot be settled raises an alert within 24 h.
- **SC-005**: A seller sees a new payout and its status changes within 10 seconds of the change, and the payouts page answers in under 300 ms at the 95th percentile with 5 years of weekly history.
- **SC-006**: 100% of shops that fail an eligibility gate keep their full balance and appear in the run summary with the reason.
- **SC-007**: A run over 1,000 shops completes in under 5 minutes and makes at most 20 tenancy and ledger calls in total for listing and eligibility.
- **SC-008**: An operator can set a reserve, change a destination, or stop a pending payout with one request each, and the change is visible in the history with who and why; a replayed request changes nothing.
- **SC-009**: Every seeded payout discrepancy (amount, currency, destination, missing transfer, later reversal) appears exactly once in the daily audit; a clean day yields none.
- **SC-010**: Zero cross-domain table reads, associations or foreign keys remain in the payout code (ownership check clean for these files), and no destination account ID or provider secret appears in any log, event or seller response.

## Assumptions

- Defaults are recorded in `questions.md`; those that shape behaviour are repeated here.
- One currency, `EUR`; one payout per shop per ISO week; a failed or cancelled payout is not retried in the same week, the shop is paid by the next run.
- Reserve is a percentage of the available balance held back at each run (platform default 10%, per-shop override 0–50%); it is never released separately, it simply stays in the seller's balance until a later run's payout leaves it behind again or an operator lowers it.
- Minimum payout `10.00`; cap `50,000.00` per payout; cooling period 48 h after a destination change; run schedule Monday 06:00 `Europe/Warsaw`; period = Monday (UTC date) of the run's week.
- Provider transfers are synchronous: the provider answers success, definite rejection, or nothing; asynchronous provider events (a transfer reversed later) are only detected by the daily audit and left to operators.
- Only a platform admin sets destinations, reserves and cancels; sellers cannot change where they are paid. A seller-facing connect-account flow, if added later, calls an exported service of this capability.
- The payment-provider account ID is the only destination detail S15 needs; S15 never reads KYC documents or bank details (closes S04's open contract).
- `payouts.read` is the permission for seller routes (owner and admin roles per S03); there is no seller write permission.
- Admin means `AuthenticatedUser.role === "admin"`; no MFA step-up is assumed.
- The idempotency retention window is 24 h (S54); the rate-limit policies are `finance.payouts.read` 120/min, `finance.admin.read` 120/min, `finance.admin.write` 30/min.
- Payout records are financial records: never deleted on shop deletion; retention follows the finance rules of S16.
- The provider call timeout is 10 s, the resolver's first look is 5 minutes after the last claim, retries 5, resolver re-sends 3, in-doubt alert 24 h.

## Cross-capability contracts

**Provides** (names exact; later specs read this section):

- **Modules** (public entry point `@app/domains/payments`; nothing else from this capability is exported, no model, no repository, no provider port): `PayoutsModule` (core: seller and operator HTTP), `PayoutsWorkerModule` (worker: weekly run, transfer job, resolver, audit).
- **HTTP** (schemas in `packages/contracts`):
  - `GET /shops/:shopId/payouts?limit&cursor` → `200 payoutPageSchema {items: payoutSchema[], nextCursor: string | null}`; `payoutSchema {id, shopId, periodStart, amountMinor, reserveHeldMinor, currency, status: "PENDING" | "IN_TRANSIT" | "PAID" | "FAILED" | "CANCELLED", transferRef: string | null, failureCode: string | null, createdAt, paidAt: string | null}`; `ShopScoped('payouts.read')`; problems `validation_failed` 400, `invalid_cursor` 400, `shop_not_found` 404, `permission_denied` 403, `rate_limited` 429. Policy `finance.payouts.read`. **Takes over the route removed from S14.**
  - `GET /shops/:shopId/payouts/:payoutId` → `200 payoutDetailSchema = payoutSchema + {timeline: {status, at}[]}`; problem `payout_not_found` 404.
  - `GET /shops/:shopId/payouts/upcoming` → `200 upcomingPayoutSchema {shopId, currency, availableMinor, reserveMinor, estimatedPayoutMinor, nextRunAt, blockedReason: null | "payouts_disabled" | "destination_missing" | "destination_cooling" | "below_minimum"}`.
  - `GET /finance/payouts?status&shopId&periodStart&limit&cursor` → `200 adminPayoutPageSchema {items: (payoutSchema + {status: internal six, attempts, failureReason: string | null, destination: masked string | null})[], nextCursor}`; admin only; policy `finance.admin.read`.
  - `GET /finance/payouts/runs?limit&cursor` → `200 payoutRunPageSchema {items: {periodStart, status: "RUNNING" | "COMPLETED" | "FAILED", created, existing, skipped: Record<string, number>, failureCode: string | null, startedAt, finishedAt: string | null}[], nextCursor}`; admin only.
  - `PUT /finance/shops/:shopId/payout-destination` (`Idempotency-Key` required) body `{providerAccountId}` → `200 {shopId, providerAccountId: masked, status: "ACTIVE", effectiveFrom, changedAt}`; problems `destination_invalid` 422, `shop_not_found` 404, `idempotency_key_required | idempotency_key_reuse` 422, `idempotency_in_flight` 409, `permission_denied` 403. Policy `finance.admin.write`.
  - `PUT /finance/shops/:shopId/payout-reserve` (`Idempotency-Key` required) body `{reserveBps: 0–5000, reason: 1–200}` → `200 {shopId, reserveBps, reason, updatedBy, updatedAt}`.
  - `POST /finance/payouts/:payoutId/cancel` (`Idempotency-Key` required) body `{reason: 1–200}` → `200 adminPayoutSchema`; problems `payout_not_found` 404, `payout_state_conflict` 409 `details {status}`.
- **Events** (outbox → topic `payouts.events`, key = `payoutId`; envelope `{eventId, type, version: 1, occurredAt, aggregateId}`; every payload carries `payoutVersion`; money in `…Minor`; **no destination, no provider account ID**):
  - `payout.created` `{payoutId, shopId, periodStart, amountMinor, reserveHeldMinor, currency, payoutVersion}`
  - `payout.paid` `{payoutId, shopId, periodStart, amountMinor, currency, transferRef, paidAt, payoutVersion}`
  - `payout.failed` `{payoutId, shopId, periodStart, amountMinor, currency, failureCode, payoutVersion}`
  - `payout.cancelled` `{payoutId, shopId, periodStart, amountMinor, currency, cancelledBy, reason, payoutVersion}`
  - `payout.in_doubt` `{payoutId, shopId, periodStart, amountMinor, currency, inDoubtSince, payoutVersion}`
  - `payout.discrepancy_detected` `{payoutId, shopId, kind: "amount" | "currency" | "destination" | "missing_transfer" | "reversed_at_provider" | "conflicting_outcome", payoutVersion}`
  - **Consumers: S28 (notify the seller on `payout.paid` and `payout.failed`; finance alert on `payout.in_doubt`, `payout.discrepancy_detected`), S16 (statements: paid payouts per shop and month, R3), J01.** Consumers dedupe by `eventId` or discard by `payoutVersion`.
- **Jobs** (registered with S49): `payouts.run-weekly {periodStart?}`, `payouts.send {payoutId}`, `payouts.resolve-in-doubt`, `payouts.audit-daily {day?}`.
- **Metrics**: names in FR-052.

**Requires**:

- **S14** (`payments`, same domain; R1 `LedgerService`, the only door to the books):
  - `postJournal(input: { kind: 'PAYOUT' | 'PAYOUT_REVERSAL'; reference: string; currency: string; lines: { accountId: string; amountMinor: number }[] }, tx): Promise<{ journalId: string; created: boolean }>`; once per `(kind, reference)`; errors `InsufficientBalance`, `LedgerBusy`, `JournalConflict`, `JournalInvalid`, `TransactionRequired`; a `PAYOUT` debit of a seller account is refused when it would overdraw (atomic); `PAYOUT_CLEARING` never below zero. S15 also posts a `PAYOUT` journal that debits `PAYOUT_CLEARING` and credits `PAYOUTS_SENT` with reference `<payoutId>:sent` and a `PAYOUT_REVERSAL` that debits `PAYOUT_CLEARING` and credits the seller account.
  - `getBalances({ accountIds, currency }, tx?): Promise<Map<string, { balanceMinor, asOf }>>` (authoritative, ≤ 500 IDs).
  - `listSellerBalances({ currency, minMinor, limit ≤ 200, after? }): Promise<{ items: { shopId, balanceMinor }[]; next: string | null }>` (keyset by shop ID).
  - `LEDGER_ACCOUNTS.PAYOUT_CLEARING`, `LEDGER_ACCOUNTS.PAYOUTS_SENT`, `shopAccount(shopId)`.
  - Removal of `GET /shops/:shopId/payouts` and of the `Payout` model from S14's surface.
- **S03** (`tenancy`): `ShopQueryService.getShopsByIds(ids: ShopId[]): Promise<Map<ShopId, ShopSummaryDto>>` (≤ 500) with `status` (value `ACTIVE` meaning payable) and `payoutsEnabled`; `ShopScoped('payouts.read')` answering non-members `404 shop_not_found`; the permission matrix of S03 (owner and admin hold `payouts.read`); after S15's migration, tenancy drops `Shop.stripeAccountId`.
- **S04** (`seller-onboarding`): nothing is required; S15 needs no bank details. `payoutsEnabled` reaches S15 only through S03.
- **S01** (`identity`): `Firewall()`, `@User()`, `AuthenticatedUser = { id, role, sessionId, amr }` with `role === 'admin'` for platform operators.
- **S49** (`infrastructure/jobs`): a recurring, timezone-aware schedule with a single-run lease across replicas; `enqueue(type, payload, { idempotencyKey, runAt? })` returning `{ id, created }`, callable inside the caller's transaction (job table is an allowlisted technical table, IX.6); retries with backoff and jitter exposing the attempt number and a maximum; handler concurrency limits; cooperative stop on shutdown.
- **S53** (events): `outbox.append(event)` inside the caller's transaction (IX.6) and the relay to topic `payouts.events`.
- **S54** (platform toolkit): problem+json with `code` and `requestId`; the `Idempotency-Key` facility (mandatory header, stored replay, in-flight `409`, different body `422`, per-principal scope, 24 h retention, `Idempotency-Replayed` header); injected clock; configuration validation; metrics registry; graceful shutdown.
- **S50** (rate limiter): policies `finance.payouts.read` 120/min per user (fail open), `finance.admin.read` 120/min (fail open), `finance.admin.write` 30/min (fail closed), with `Retry-After`.
- **The payment provider** (external; reached only through a domain port with one adapter that validates every answer; its client lives in `infrastructure/stripe`): create a transfer `{ amountMinor, currency, destination, idempotencyKey, reference }` answering `{ transferRef, amountMinor, currency, destination }`, a definite rejection with a code, or a transient or unknown outcome; look up a transfer by our reference (found with its amount, currency, destination and whether it was reversed, or not found); 10 s per call; replays of one idempotency key return the original transfer.
