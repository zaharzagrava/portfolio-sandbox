# Feature Specification: S14 — Double-Entry Ledger, Balanced Journals, Hot-Account Sharding, Balance Read Model, Daily PSP Reconciliation (domain `payments`)

**Feature Branch**: `S14-ledger-reconciliation` (spec directory `specs/domains/S14-ledger-reconciliation`)

**Created**: 2026-10-05

**Status**: Draft

**Input**: User description: "Double-entry ledger, balanced journals, hot-account sharding, balance read model, daily PSP reconciliation (domain `payments`)". Sources: `docs/showcase/sections/SD-20-payments-ledger-reconciliation.md`, Interview-Prep `10-System-Design/02-worked-examples.md` (Example 1), `03-Databases/02-transactions-isolation-locking.md` (§4, §7, §8), pattern-map rows P0102, P0313, P0315, P0318, P0614, constitution v3.1.0 (III.6–III.8, IV.4–IV.6, V.6, VII, IX, X).

## Scope

The platform holds other people's money. Every movement of that money (a buyer's payment arriving, the platform's fee, a seller's share, a refund, an ad charge, a payout) is written as a **journal**: a set of lines that add up to exactly zero, written once, never edited. From the journals the platform knows what each account holds, shows a seller their balance instantly, and proves every day that its books agree with the payment provider's statement.

In scope:

- **Balanced, immutable journals**: one posting API for all money movements; a journal is accepted only if its lines sum to zero, are whole minor units in one currency, and satisfy the limits below; entries are append-only; each (kind, reference) is posted at most once; a posting joins the caller's transaction and fails with it.
- **Chart of accounts**: the system accounts and seller accounts, their sign convention and which may go negative.
- **Payment capture and refund postings**: the two exported calls S13 makes inside its own transaction, with the platform fee rule inside the ledger.
- **Settlement**: when an order is paid, the net amount of its sale is split among the shops of the order, to the cent, exactly once, tolerant of duplicates, late arrival and a refund racing it.
- **Hot-account sharding and deadlock-free ordering**: the accounts every sale touches are split into shards, summed on read and consolidated by a sweep; every transaction takes its account locks in one sorted order; a posting never waits forever.
- **Running balances and the balance read model**: authoritative balances kept with the journals, a fast read model fed by events (idempotent, order-tolerant, replayable), the seller's balance endpoint, and the batch reads other capabilities use. No balance is ever computed by summing history.
- **Daily reconciliation against the payment provider**: the provider's statement for a closed UTC day is read page by page and compared with the journals by provider reference; every difference becomes an issue; runs are idempotent per (provider, day); issues are worked by finance operators through an admin API.
- **Housekeeping**: monthly partitions created ahead, a daily invariant checker, a hot-account sweep, and the backfill that moves existing data to the new shape (expand/contract).

Out of scope (owners named):

- Payment intents, the provider charge, unknown outcomes, payment states, the order copy → **S13**. This capability only receives its two calls.
- Seller payouts: the `Payout` records and states, the weekly run, reserves, the provider transfer and `GET /shops/:shopId/payouts` → **S15**. S15 uses this capability's exports.
- Commission rates over time, monthly statements, period close for statements, as-of reports, CSV export → **S16**. Ad-billing rules and campaigns → **S36**. Subscription charges → **S17**.
- Checkout, orders and their states, the provider's signed webhooks → **S10**. Shops and roles → **S03**. Authentication → **S01**.
- Outbox, consumers, projector framework → **S53**; jobs and schedules → **S49**; rate limiter → **S50**; problem+json, idempotency facility, clock, config, metrics, shutdown → **S54**.
- Screens: the seller's balance card and the finance issues board → **W04** and a finance console not yet assigned; journey **J01** (buy to payout) proves the chain end to end. This capability provides the API.
- Currency conversion, partial refunds, the provider's own processing fees, cold-storage archive of old partitions, free-form manual journals.

Cross-domain data used (IX.7): order facts arrive by the **R3** event `order.paid` (S10); shop access is checked by **R1** (`ShopScoped` from S03); other capabilities read balances and post journals through **R1** exports of this capability; statements and dashboards read ledger facts by **R3** (event `ledger.journal_posted`). The balance read model is this domain's own store fed from its own events. The payment provider is an external system behind a domain port.

## User Scenarios & Testing *(mandatory)*

Notation: amounts are integer minor units (`2500` = 25.00 EUR); the currency is `EUR` unless stated. `PROVIDER_CLEARING`, `CLEARING`, `PLATFORM_FEES`, `PAYOUT_CLEARING`, `PAYOUTS_SENT` are system accounts and `SHOP_<id>` is a seller account (the exact IDs are under "Provides"). In a line, a **negative** amount is a debit and a **positive** amount a credit. `F` is the platform fee, `50`. `s(X)` is the shard chosen for reference `X`. `P` is a payment, `O` its order, `U` its buyer, `pi_1` the provider's reference for the charge, `re_1` for its refund. "At `T`" means the injected clock reads `T`.

### User Story 1 — Every money movement is one balanced, immutable journal, posted once (Priority: P1)

Whatever produces a money movement, the books receive it as a journal whose lines sum to zero. A bug can crash a posting but cannot unbalance the books, edit history, or post the same thing twice.

**Why this priority**: money created or lost by a bug, a retry or a race is the failure this capability exists to prevent (notes 10/02 Ex1, 03/02 §8; III.6, III.8).

**Independent Test**: call the posting service from a test with hand-made journals, retries and races, against the real store; assert entries, running balances and outbox rows.

**Acceptance Scenarios**:

1. **AS-01** (accepted, full effect) — **Given** an open transaction and journal `{kind: ADJUSTMENT, reference: "t-1", currency: EUR, lines: [A −1000, B +600, C +400]}` at `T`, **When** it is posted, **Then** `{journalId, created: true}` is returned; three entries exist with the same `journalId` and the same `postedAt = T`; the running balance of each account moved by its line; exactly one `ledger.journal_posted` v2 is in the outbox (same transaction) carrying each line's `accountId`, `shard`, `amountMinor`, `balanceAfterMinor`, `balanceVersion`; after commit the sum of all entries of the journal is `0`.
2. **AS-02** (unbalanced is refused by the service) — **Given** lines `[A −1000, B +600, C +399]`, **When** posted, **Then** `JournalUnbalanced` is raised with the sum `−1`, `ledger_post_rejected_total{reason="journal_unbalanced"}` increments, and no entry, no balance change and no outbox row exists.
3. **AS-03** (the store is the last line of defence) — **Given** a privileged test inserts `[A +100, B −99]` for one journal directly into the entries, **When** the transaction commits, **Then** the commit fails with an "unbalanced journal" error and nothing is persisted; an interleaved insert of the missing line in the same transaction commits.
4. **AS-04** (invalid journals) — **Given** each of: one line; a line of `0`; a line of `12.5`; a line of `2^53`; 201 lines; two currencies in one journal; currency `eur` or `EURO`; an account `SHOP_not-a-uuid`; an unknown account `FOO`; a kind not allowed for callers (`SALE` through `postJournal`); a line naming a shard (`PLATFORM_FEES#07`); an empty `reference`, **When** each is posted, **Then** each is refused with its own reason (`journal_too_few_lines`, `line_amount_zero`, `line_amount_invalid`, `line_amount_invalid`, `journal_too_large`, `journal_currency_mismatch`, `currency_invalid`, `account_unknown`, `account_unknown`, `kind_not_allowed`, `account_unknown`, `reference_invalid`), counted per reason, and nothing is persisted.
5. **AS-05** (money is exact) — **Given** a journal `[A −9007199254740000, B +9007199254740000]`, **When** posted and read back through `getBalances`, **Then** the balances are exactly `−9007199254740000` and `9007199254740000`; **Given** a posting that would push a running balance beyond the safe integer range, **Then** it is refused with `balance_overflow` and nothing is persisted.
6. **AS-06** (append-only) — **Given** posted entries, **When** an `UPDATE` or a `DELETE` is issued against them (by a privileged test, as the application's own role), **Then** the store rejects each statement; entries and balances are unchanged; a correction is only possible by posting a reversing journal (AS-14).
7. **AS-07** (once per (kind, reference)) — **Given** AS-01 completed, **When** the same kind and reference are posted again with identical lines, **Then** `{journalId: <same>, created: false}`, no new entry, no balance change, no event; **When** the same kind and reference are posted with different lines or amounts, **Then** `JournalConflict` is raised, `ledger_post_rejected_total{reason="journal_conflict"}` increments, and nothing changes.
8. **AS-08** (concurrent duplicates) — **Given** one (kind, reference), **When** 50 identical postings run at once (`Promise.all`, each in its own transaction, repeated 20 times), **Then** exactly one returns `created: true`, 49 return `created: false` with the same `journalId`, one set of entries, one event, and each balance moved once.
9. **AS-09** (joins the caller's transaction) — **Given** a posting inside a caller transaction that is then rolled back, **Then** no entry, balance change or outbox row exists; **Given** a call without a transaction, **Then** `transaction_required` is raised and nothing is written; the posting never opens, commits or nests a transaction of its own and does no network call.
10. **AS-10** (non-negative guard, atomic) — **Given** seller account `SHOP_a` at `+100`, **When** two `PAYOUT` journals each debiting `SHOP_a` by `80` run at once (`Promise.all`, repeated 50 times), **Then** exactly one succeeds, the other raises `insufficient_balance`, the balance ends at `+20` and never below `0` at any moment; **When** a `PAYOUT` debit of `101` is posted, **Then** `insufficient_balance` and nothing changes; **When** an `AD_CHARGE` or `ADJUSTMENT` debits `SHOP_a` below zero, **Then** it succeeds and the balance is negative; `PAYOUT_CLEARING` can never be driven below `0` by any kind.

---

### User Story 2 — Sales, refunds and settlements post themselves correctly (Priority: P1)

A paid order puts the buyer's money into the clearing account, the fee into the platform's revenue, and — once the order is paid — each shop's share into its own account. A refund undoes exactly what happened, whether or not the shops had been credited.

**Why this priority**: this is the money trail of every purchase (journey J01); an error here is a seller paid wrongly or a buyer refunded from the wrong pocket.

**Independent Test**: call the two exported capture and refund methods from a test transaction, and deliver `order.paid` messages to the settlement consumer; assert journals, balances, outbox rows and the consumer's reactions.

**Acceptance Scenarios**:

1. **AS-11** (capture) — **Given** at `T` payment `P` of order `O` by buyer `U`, `2500` EUR, provider reference `pi_1`, **When** `recordPaymentCaptured({paymentId: P, orderId: O, paymentRef: "pi_1", userId: U, amountMinor: 2500, currency: "EUR"}, tx)` runs, **Then** it returns `{journalId, created: true}` and a `SALE` journal exists with lines `PROVIDER_CLEARING −2500`, `CLEARING +2450`, `PLATFORM_FEES +50`, all on shard `s(P)`; the journal records `paymentId`, `orderId`, `paymentRef` and `userId` as plain references; no account named after the buyer exists; one `ledger.journal_posted` v2 is outboxed.
2. **AS-12** (capture is idempotent per payment) — **Given** AS-11, **When** the same call is repeated (also 20 at once), **Then** `{journalId: <same>, created: false}` and nothing else changes; **When** it is repeated with `amountMinor: 2600`, **Then** `JournalConflict` fails the caller's transaction.
3. **AS-13** (capture refused) — **Given** `amountMinor` of `50`, `49`, `0`, `−1`, a currency `USD`, or a missing `orderId`/`paymentRef`, **When** capture is called, **Then** it is refused (`amount_not_above_fee`, `amount_not_above_fee`, `amount_not_above_fee`, `line_amount_invalid`, `currency_unsupported`, `reference_invalid`), nothing is written, and the caller's transaction fails.
4. **AS-14** (refund of an unsettled sale) — **Given** AS-11 and no settlement yet, **When** `recordPaymentRefunded({paymentId: P, refundRef: "re_1", amountMinor: 2500, currency: "EUR"}, tx)` runs, **Then** a `REFUND` journal exists with `PROVIDER_CLEARING +2500`, `CLEARING −2450`, `PLATFORM_FEES −50` on the sale's shards; for `P` the three accounts net to `0`; the fee is returned in full; the sale journal is unchanged; one event is outboxed.
5. **AS-15** (refund of a settled sale) — **Given** AS-11 and a settlement that credited `SHOP_a +1225` and `SHOP_b +1225` (clearing back to `0`), **When** the refund runs, **Then** the `REFUND` journal is `PROVIDER_CLEARING +2500`, `PLATFORM_FEES −50`, `SHOP_a −1225`, `SHOP_b −1225`; `CLEARING` stays `0`; the shops' balances may become negative (the seller owes the platform) and the journal records which settlement it reversed.
6. **AS-16** (refund guards) — **Given** no sale journal for `P`, **Then** `sale_not_found`; **Given** `amountMinor: 1000` (not the captured amount), **Then** `refund_amount_mismatch`; **Given** a currency different from the sale's, **Then** `journal_currency_mismatch`; **Given** the refund already posted, **When** called again (also 20 at once), **Then** `{journalId: <same>, created: false}`; in every refusal nothing is written and the caller's transaction fails.
7. **AS-17** (settlement) — **Given** a sale for `O` of `1050` (clearing credit `1000`) and the event `order.paid {orderId: O, totalMinor: 1050, currency: "EUR", paymentRef: "pi_1", shopOrders: [{shopId: a, subtotalMinor: 350}, {shopId: b, subtotalMinor: 350}, {shopId: c, subtotalMinor: 350}], orderVersion: 3}` with `a < b < c`, **When** the consumer processes it, **Then** one `SETTLEMENT` journal exists: `CLEARING −1000`, `SHOP_a +334`, `SHOP_b +333`, `SHOP_c +333` (largest remainder, ties to the lowest shop ID), its ID deterministic from `O`, `CLEARING` returns to `0`, one `ledger.journal_posted` is outboxed; shares always sum to the net and are never negative.
8. **AS-18** (settlement duplicates) — **Given** AS-17 delivered five times at once (`Promise.all`) and again later, **Then** one journal, one event, shares unchanged; the later deliveries are acknowledged with no effect.
9. **AS-19** (settlement payload validation) — **Given** `order.paid` messages with: no `shopOrders`; an empty `shopOrders`; a negative or non-integer `subtotalMinor`; all subtotals `0`; a non-UUID `shopId`; a duplicate `shopId`; a `currency` different from the sale's; a wrong `type`; a missing `orderId`, **When** each is delivered, **Then** each is dead-lettered with its own reason (`invalid_payload` or `currency_mismatch`), counted in `ledger_consumer_dead_lettered_total{reason}`, no journal is written, and the next message is processed.
10. **AS-20** (settlement before the sale exists) — **Given** `order.paid` for `O` and no sale journal yet, **When** it is delivered, **Then** nothing is posted, `ledger_settlement_deferred_total` increments and the message is retried with backoff (6 attempts within about 10 minutes); **When** the sale is captured before the next attempt, **Then** the next attempt settles with AS-17's result; **When** no sale appears after the 6th attempt, **Then** the message is dead-lettered with reason `sale_not_found` and `ledger_settlement_dead_lettered_total` increments.
11. **AS-21** (settlement and refund agree in any order) — **Given** a captured sale and (a) a refund already posted, **When** `order.paid` arrives, **Then** no shop is credited, a skipped settlement is recorded (`ledger_settlement_skipped_total{reason="refunded"}`), the message is acknowledged; **Given** (b) settlement posted and then a refund, **Then** AS-15; **Given** (c) the settlement and the refund racing (`Promise.all`, repeated 50 times), **Then** every run ends as (a) or (b), never with a shop credited for a refunded payment, and after each run `SHOP_*`, `CLEARING`, `PROVIDER_CLEARING` and `PLATFORM_FEES` net to `0` for this payment.

---

### User Story 3 — The accounts every sale touches do not serialize the platform (Priority: P1)

Every sale touches the fee account, the clearing account and the provider account. If each were one row, a thousand simultaneous sales would queue behind each other. They are split into shards, read as one account, tidied by a sweep, and every transaction locks in one agreed order so none can deadlock.

**Why this priority**: it is the first bottleneck named in SD-20 (10k payments/s) and the classic deadlock source in note 03/02 §7; correctness must hold under contention, not only in a quiet test.

**Independent Test**: fire hundreds of postings with `Promise.all` and assert balances, shard spread, absence of deadlocks and timeouts, and the contention metric.

**Acceptance Scenarios**:

1. **AS-22** (sharded under load) — **Given** 200 distinct payments captured at once (`Promise.all`, 250 minor each, repeated 5 times), **Then** all succeed with no deadlock or lock-timeout error, the logical `PLATFORM_FEES` balance is `200 × 50 = 10000`, `PROVIDER_CLEARING` is `−50000`, `CLEARING` is `+40000`, more than 8 distinct shards of each were used, each shard's `balanceVersion` equals the number of journals that touched it, and `ledger_lock_wait_seconds{accountClass}` has observations.
2. **AS-23** (shard choice) — **Given** any reference `X`, **Then** `s(X)` is the same on every call and process, lies in `[0, N−1]`, and over 10 000 random references each of the 32 shards receives between 75% and 125% of the mean; the three hot accounts of one journal always use the same shard index; **Given** `N` changed from 32 to 64 while balances exist, **Then** logical balances are unchanged.
3. **AS-24** (sweep) — **Given** shards of `PLATFORM_FEES` holding `[120, 0, −30, 80, …]`, **When** the sweep runs for window `W`, **Then** one `SWEEP` journal per account moves the balance of every non-empty shard `1…N−1` into shard `0` (balanced, deterministic ID from account and window, outboxed); empty shards are not touched; the logical balance is the same before and after; **When** the sweep runs again for `W`, **Then** `created: false` and nothing changes; **When** 100 captures are in flight during the sweep (`Promise.all`), **Then** no posting is lost or doubled, no deadlock occurs, and the final logical balance equals the exact total.
4. **AS-25** (sorted lock order) — **Given** two journals that name the same two accounts in opposite order (`[A −10, B +10]` and `[B −10, A +10]`), **When** 100 pairs run at once (`Promise.all`), **Then** every posting succeeds, no deadlock error occurs, and balances equal the exact sums; **And** the order in which balance rows are locked is by account then shard, ascending, independent of the order of the lines.
5. **AS-26** (a posting never waits forever) — **Given** a test transaction holding the lock on a balance row for 5 s, **When** a posting needs that row, **Then** it fails after the 2 s lock limit with `ledger_busy` (retryable, no partial write, `ledger_post_rejected_total{reason="ledger_busy"}`), and succeeds when repeated after the lock is released; no network call is ever made while a posting holds locks.
6. **AS-27** (one logical account) — **Given** balances spread over shards, **When** `getBalances` is read for `PLATFORM_FEES`, **Then** it returns the sum over shards as one number; no read API, error or log exposes shard numbers except the lines of `ledger.journal_posted` (which statements need).

---

### User Story 4 — Balances are exact, instant, and never a sum over history (Priority: P1)

A seller opens the dashboard and sees what they are owed in milliseconds. Other capabilities ask for balances in batches. If the fast store is cold or down, the answer is still right.

**Why this priority**: a wrong balance is a wrong payout; a slow one makes the page unusable at 100M entries a month (SD-20 Scale).

**Independent Test**: post journals, project them, call the HTTP endpoint and the exported reads; force each store down; count the queries.

**Acceptance Scenarios**:

1. **AS-28** (authoritative batch read) — **Given** balances for 3 accounts, **When** `getBalances({accountIds, currency: "EUR"})` is called, **Then** it returns each account's exact balance and `asOf` from the running balances (no sum over entries: the query count over the entries table is `0`); an unknown account returns `0`; more than 500 IDs raise `too_many_accounts`; duplicates are collapsed; a read inside the caller's transaction sees its own uncommitted postings.
2. **AS-29** (list sellers with a balance) — **Given** 45 seller accounts with balances, **When** `listSellerBalances({currency, minMinor: 1000, limit: 20, after})` is called three times, **Then** it returns pages of 20, 20 and the rest, ordered by account ID with no repeat or skip while new postings arrive, only accounts with a balance of at least `1000`, `next: null` at the end; `limit` above 200 or a tampered `after` is refused.
3. **AS-30** (read model projection) — **Given** `ledger.journal_posted` v2 events, **When** one is delivered twice, **Then** the read model is the same as after one delivery; **When** an event with an older `balanceVersion` for an account shard arrives after a newer one, **Then** it is ignored and counted (`ledger_projection_stale_total`); **When** all events are replayed from the beginning of the topic into an empty read model, **Then** the result equals the authoritative balances for every account; two shards of one account project independently and the account's value is their sum.
4. **AS-31** (projection payload validation) — **Given** an event with a missing `journalId`, a negative `balanceVersion`, a non-integer `balanceAfterMinor`, an unknown `version` or an unknown `type`, **When** delivered, **Then** it is dead-lettered with its reason, the read model is unchanged and the next message is processed.
5. **AS-32** (the seller's balance) — **Given** shop `a` with `SHOP_a = +1400` projected and user `m` a member of `a` with `payouts.read`, **When** `m` calls `GET /shops/a/balance`, **Then** `200 {shopId: a, currency: "EUR", availableMinor: 1400, asOf: <ISO time>, source: "read_model"}` parsing with `balanceSchema`; a shop with no postings answers `availableMinor: 0`; no query sums the entries; the answer needs one hot-store read.
6. **AS-33** (degradation chain) — **Given** the hot store is down, **Then** the durable copy answers (`source: "read_model"`); **Given** both are down or both have no entry, **Then** the running balance answers (`source: "ledger"`) with the same number; **Given** the read model holds a value that differs from the running balance by an in-flight event, **Then** the response is still a value the account really had (never a mix of shards from different moments beyond one version); each forced fault leaves the endpoint at `200`.
7. **AS-34** (access) — **Given** no session, **Then** `401`; **Given** a user who is not a member of shop `a`, **Then** `404 shop_not_found` identical byte for byte to the answer for a shop that does not exist; **Given** a member whose role lacks `payouts.read`, **Then** `403 permission_denied`; **Given** a shop ID that is not a UUID or `?currency=euro`, **Then** `400 validation_failed`; **Given** a member of shop `b` asking for shop `a`'s balance with every parameter combination, **Then** no value of `a` is ever returned.
8. **AS-35** (read limit) — **Given** the policy `finance.balance.read` of 120 per minute per user, **When** a user makes the 121st read within a minute, **Then** `429 rate_limited` with `Retry-After`; **When** the limiter's store is down, **Then** reads are answered (fail open).
9. **AS-36** (a negative balance is shown as it is) — **Given** an ad charge took `SHOP_a` to `−1000`, **When** the endpoint is read, **Then** `availableMinor: −1000`.
10. **AS-37** (freshness) — **Given** a committed journal at `T`, **When** the projector is running, **Then** the read model shows the new balance within 5 s at the 99th percentile, `asOf` is never earlier than the projected version's commit, and `ledger_balance_projection_lag_seconds` reports the lag; **When** the projector is stopped, **Then** the metric grows and the endpoint keeps answering from the last projection or the running balance.

---

### User Story 5 — Every day the books are proven against the payment provider's statement (Priority: P1)

Each morning the platform reads the provider's statement for yesterday, page by page, and checks every charge, refund and dispute against its own journals. Anything that does not agree becomes an issue for finance. Running the check twice never changes the answer, and a provider outage never leaves half a result.

**Why this priority**: this is how the numbers are *proven* correct (note 03/02 §8, pattern P0614); the provider can refund, dispute or double-charge without telling us.

**Independent Test**: a scriptable provider double (pages, delays, failures, malformed lines, call log) and journals seeded through the ledger's own service; run the job handler; assert runs, issues, events, provider calls.

**Acceptance Scenarios**:

1. **AS-38** (a clean day) — **Given** UTC day `D` (closed), provider statement lines for 3 charges and 1 refund, and matching `SALE` and `REFUND` journals (same references, amounts, currency), **When** `payments.reconcile-daily {day: D}` runs, **Then** the run is `COMPLETED` with `providerLines: 4`, `ledgerJournals: 4`, `matched: 4`, `issueCount: 0`, one `ledger.reconciliation_completed` event, `reconciliation_runs_total{status="completed"}` incremented, and no issue exists.
2. **AS-39** (differences in charges) — **Given** day `D` with: a provider charge `pi_a` (100) and no journal; a `SALE` journal for `pi_b` (100) and no provider line, where the provider has no such charge on lookup; `pi_c` ours 100, provider 150; `pi_d` ours `EUR`, provider `USD`, **When** the run executes, **Then** the issues are `MISSING_IN_LEDGER pi_a {providerAmount: 100}`, `MISSING_AT_PROVIDER pi_b {ledgerAmount: 100}`, `AMOUNT_MISMATCH pi_c {ledger: 100, provider: 150}`, `CURRENCY_MISMATCH pi_d`, each `OPEN`, each with one `ledger.reconciliation_issue_opened`; `matched` counts only the exact matches; `reconciliation_issues_open{kind}` equals the open counts.
3. **AS-40** (refunds, disputes, duplicates) — **Given** day `D` with: a provider refund `re_x` for a payment we never refunded; a provider dispute `dp_1` of 2500; two succeeded provider charges carrying the same payment reference `P`; a refund we posted (`re_1`) that the provider does not list, **Then** the issues are `MISSING_IN_LEDGER {type: "refund"}`, `MISSING_IN_LEDGER {type: "dispute"}`, `DUPLICATE_AT_PROVIDER {references: [..]}` and `MISSING_AT_PROVIDER {type: "refund"}`; the ledger is not changed by the run (reconciliation never posts).
4. **AS-41** (idempotent per provider and day) — **Given** a `COMPLETED` run for (`stripe`, `D`), **When** the job runs again for `D` (also twice at once), **Then** no provider call is made, the run and its issues are unchanged, there is still one run for (`stripe`, `D`), and the job returns "already completed".
5. **AS-42** (one runner) — **Given** two workers start the job for `D` at the same moment (`Promise.all`), **Then** exactly one reads the statement, the other returns "already running" without calling the provider, and one run exists.
6. **AS-43** (a crashed run restarts cleanly) — **Given** a run left `RUNNING` with an expired lease and 3 issues already stored for a previous partial attempt, **When** the job runs, **Then** the day restarts, the final set of issues is exactly the correct set with no duplicates (unique per run, kind and reference), and the run ends `COMPLETED`.
7. **AS-44** (paged and streamed, with backpressure) — **Given** a statement of 25 000 lines in 250 pages of 100, **When** the run executes, **Then** the next page is requested only after the previous one is fully processed, at most one page is held in memory, the job's lease is renewed while it works (heartbeat at least every 1 000 lines), and the run completes with the right counts; a page that repeats lines of an earlier page counts each line once.
8. **AS-45** (provider trouble leaves nothing half-done) — **Given** the provider times out (10 s), answers `429` or `503` on page 3, **When** the run executes, **Then** it ends `FAILED` with `failureCode: "provider_unavailable"`, no issue of this attempt is stored, `reconciliation_runs_total{status="failed"}` increments, earlier `COMPLETED` days are untouched, the adapter made no retry of its own, and the job layer retries (at most 3 attempts with exponential backoff and full jitter); **When** the provider recovers on attempt 2, **Then** the run ends `COMPLETED`.
9. **AS-46** (the provider's answers are not trusted) — **Given** statement lines with a missing ID, a non-integer amount, an unknown currency code, an unknown line type (`adjustment_x`), and a type owned by payouts (`transfer`), **When** the run executes, **Then** the first three each produce `INVALID_PROVIDER_RECORD` (with the line's position, never the raw body), the unknown type is counted as `skipped` (metric `reconciliation_lines_skipped_total{type}`), the `transfer` is counted as skipped for S15, and the run still completes.
10. **AS-47** (day boundaries) — **Given** a provider charge created at `D 23:59:58 UTC` and its journal posted at `D+1 00:00:03`, **When** the runs for `D` and `D+1` execute, **Then** neither run reports an issue for it (matched by reference across the boundary); **Given** the journal never posted, **Then** run `D` reports `MISSING_IN_LEDGER`; **Given** a journal posted at `D 23:59:59` for a provider charge created at `D+1 00:00:02`, **Then** neither run reports it as missing at the provider.
11. **AS-48** (which days may be run) — **Given** `day` equal to today, a future day, `2026-02-30`, `2026-13-01`, a malformed string, or a day older than 90 days, **When** the job is invoked, **Then** each is refused (`day_not_closed`, `day_not_closed`, `day_invalid`, `day_invalid`, `day_invalid`, `day_out_of_range`) with no run created; **Given** no `day` at `2026-10-05T02:30Z`, **Then** the run is for `2026-10-04`; **Given** the last 7 days include 2 days without a `COMPLETED` run, **Then** the same invocation also runs those 2 days, oldest first.
12. **AS-49** (issues that were only timing close themselves) — **Given** an `OPEN` `MISSING_IN_LEDGER` from run `D−1` for `pi_a` and, since then, the journal for `pi_a` has been posted, **When** the next run executes, **Then** the issue becomes `RESOLVED` with `resolution: "auto_matched"` and `resolvedBy: "system"`, one history entry, and `reconciliation_issues_open{kind}` drops; an issue still unmatched stays `OPEN`; only issues of the previous 3 days are re-checked.
13. **AS-50** (run states) — **Given** a run, **Then** only `RUNNING → COMPLETED`, `RUNNING → FAILED` and `FAILED → RUNNING` are legal; `COMPLETED` is final; every other pair is refused (table-driven over all states), and a `COMPLETED` run's counts and issues are never rewritten.

---

### User Story 6 — Finance operators work the issue queue (Priority: P2)

A finance operator opens the board, sees what is wrong, and either explains it or corrects the books with a balanced adjustment, once, with a record of who and why.

**Why this priority**: a finding nobody can act on proves nothing; adjustments are money movements and need the same protections as any other.

**Independent Test**: seed runs and issues through the job; call the three endpoints as an admin, a seller and an anonymous caller.

**Acceptance Scenarios**:

1. **AS-51** (lists) — **Given** 3 runs and 45 open issues, **When** an admin calls `GET /finance/reconciliation/runs?limit=2` and `GET /finance/reconciliation/issues?status=OPEN&limit=20`, **Then** runs come newest first with `nextCursor`, issues in pages of 20, 20, 5 with no repeat or skip while new issues arrive, `nextCursor: null` at the end, filters `kind` and `day` narrow the list, bodies parse with `reconciliationRunPageSchema` and `reconciliationIssuePageSchema`; `limit=0`, `limit=201`, an unknown `status` or `kind`, or a tampered cursor give `400 validation_failed` or `400 invalid_cursor`.
2. **AS-52** (access) — **Given** no session, **Then** `401` on all three endpoints; **Given** an authenticated seller (shop owner, not admin), **Then** `403 permission_denied` on all three and nothing about runs or issues in the body.
3. **AS-53** (resolve: explained) — **Given** an `OPEN` issue `I` and an admin, **When** `POST /finance/reconciliation/issues/I/resolve` with `Idempotency-Key: k1` and `{resolution: "explained", note: "Provider fee rounding, ticket 4411"}`, **Then** `200` with the issue `RESOLVED`, `resolution: "explained"`, `resolvedBy` the admin's ID, `resolvedAt`, the note; no journal is posted; the issue's open count drops.
4. **AS-54** (resolve: adjusted) — **Given** an `OPEN` `MISSING_IN_LEDGER` issue of run day `D` and an admin, **When** the request carries `{resolution: "adjusted", note, adjustment: {currency: "EUR", lines: [{accountId: "PROVIDER_CLEARING", amountMinor: -100}, {accountId: "CLEARING", amountMinor: 100}]}}`, **Then** `200` and one `ADJUSTMENT` journal with a deterministic ID from the issue exists, posted at the current time (never backdated), referencing day `D` as the period it corrects, linked as `adjustmentJournalId`, in the same transaction as the issue's change and its event; all entries posted on day `D` before the adjustment are byte-for-byte unchanged and the closed run's counts are unchanged.
5. **AS-55** (resolve: validation) — **Given** an `OPEN` issue, **When** the body has: `adjusted` without `adjustment`; `explained` with `adjustment`; a note of 0 or 501 characters; an unknown `resolution`; an unknown property; an adjustment that does not sum to zero (`422 adjustment_unbalanced`); an account outside the chart (`422 adjustment_account_invalid`); more than 10 lines (`422 adjustment_too_large`); a currency other than `EUR`; a non-UUID `issueId`, **Then** each returns its status (`400 validation_failed` or the named `422`), and the issue, the books and the outbox are unchanged.
6. **AS-56** (illegal transition) — **Given** a `RESOLVED` issue, **When** an admin resolves it again with a new key, **Then** `409 issue_already_resolved` and nothing changes; **Given** an unknown issue ID, **Then** `404 reconciliation_issue_not_found`; **Given** an issue auto-resolved by AS-49, **Then** the same `409`.
7. **AS-57** (idempotency) — **Given** AS-54 completed with key `k1`, **When** the same key and body are sent again, **Then** the stored `200` with `Idempotency-Replayed: true`, still one journal; **When** a second request with the same key arrives while the first is in flight (a test gate), **Then** `409 idempotency_in_flight` with `Retry-After`; **When** key `k1` is reused with a different body, **Then** `422 idempotency_key_reuse`; **When** the header is missing or empty, **Then** `422 idempotency_key_required`.
8. **AS-58** (competing resolutions) — **Given** one `OPEN` issue, **When** two admins resolve it at once with different keys (`Promise.all`, repeated 50 times), **Then** exactly one `200` and one `409 issue_already_resolved`, at most one adjustment journal, one history entry, one event.
9. **AS-59** (write limit) — **Given** the policy `finance.admin.write` of 30 per minute per user, **When** the 31st resolve request arrives within a minute, **Then** `429 rate_limited` with `Retry-After`; **When** the limiter's store is down, **Then** the request is refused (fail closed) and no journal is posted.

---

### User Story 7 — The ledger stays healthy by itself, and existing data moves safely (Priority: P2)

Partitions exist before they are needed, a nightly check shouts when anything drifts, jobs run once however many workers there are, and old data is migrated without a pause in service.

**Why this priority**: a ledger that works today and fails at midnight on the first of the month, or that cannot be migrated, is not production-grade (P0315, P0318).

**Independent Test**: invoke each job handler against the real store with a frozen clock; inject faults with privileged test SQL.

**Acceptance Scenarios**:

1. **AS-60** (partitions ahead) — **Given** partitions only up to the current month, **When** `ledger.ensure-partitions` runs, **Then** monthly partitions exist for the current month and the next 3, each protected exactly like the others (balance check at commit, append-only); running it again changes nothing and raises no error; a partition that already exists is skipped.
2. **AS-61** (a missing month, and the month boundary) — **Given** no partition for the month of `T`, **When** a journal is posted at `T`, **Then** it succeeds (stored in the catch-all partition), `ledger_default_partition_rows` becomes greater than `0` and an alert fires; **When** `ledger.ensure-partitions` runs afterwards, **Then** those entries are moved into the proper monthly partition, entry counts, sums and balances are unchanged, and the gauge returns to `0`; **Given** a journal posted at `2026-10-31T23:59:59.999Z`, **Then** all its lines carry the same `postedAt` and sit in the same partition.
3. **AS-62** (the invariant checker) — **Given** a healthy book, **When** `ledger.verify-invariants` runs, **Then** all checks pass and `ledger_invariant_violations_total` does not change; **Given** a privileged test (a) inserts an unbalanced journal with the commit-time check disabled, (b) edits a running balance, (c) edits one read model value, **When** the job runs, **Then** the counter increments for exactly `check="journal_balanced"`, `check="balance_matches_entries"` or `check="read_model_matches"` respectively, the error log names the journal or account (IDs only), the read model value of (c) is rewritten from the running balance, nothing of (a) or (b) is changed by the job (it never edits the ledger), and the job ends successfully; each run checks only the entries of the last two closed days plus accounts touched in them (bounded work).
4. **AS-63** (single run, repeatable) — **Given** two workers invoke each scheduled job at the same moment (`Promise.all`), **Then** exactly one does the work (`ledger.sweep-hot-accounts`, `ledger.verify-invariants`, `ledger.ensure-partitions`, `payments.reconcile-daily`), the other returns "already running", and running a job twice in a row has the effect of running it once.
5. **AS-64** (expand and contract migration) — **Given** existing entries in the old shape (including lines on `MERCHANT_<uuid>` buyer accounts and legacy rows with no journal grouping), **When** `ledger.backfill-balances` runs in batches of 5 000 while new postings continue, **Then** every journal has a header, every account shard has a running balance equal to the sum of its entries, an interrupted run resumes from its last batch, re-running changes nothing, the invariant checker is green, old buyer-account lines remain as history, and the legacy table is dropped only by a separate later deploy after a count and checksum comparison reports equality; no step takes a lock longer than 3 s.

---

### User Story 8 — The domain is safe, observable and well-bounded (Priority: P3)

Operators can see postings, rejections, lock waits, projection lag and reconciliation health. Nothing sensitive leaks. Other capabilities rely on a small public surface and no one reads the ledger's tables.

**Why this priority**: it keeps the money path operable and the architecture checkable.

**Independent Test**: run the flows above and inspect metrics, logs, events, the ownership check and the boundary check.

**Acceptance Scenarios**:

1. **AS-65** (observability) — **Given** the flows of AS-01, AS-02, AS-22, AS-30, AS-38 and AS-45, **Then** these exist and move as described: `ledger_journals_posted_total{kind}`, `ledger_post_rejected_total{reason}`, `ledger_lock_wait_seconds{accountClass}`, `ledger_balance_projection_lag_seconds`, `ledger_projection_stale_total`, `ledger_settlement_deferred_total`, `ledger_settlement_skipped_total{reason}`, `ledger_consumer_dead_lettered_total{reason}`, `ledger_invariant_violations_total{check}`, `ledger_default_partition_rows`, `reconciliation_runs_total{status}`, `reconciliation_issues_open{kind}`, `reconciliation_lines_skipped_total{type}`, `reconciliation_oldest_open_issue_age_seconds`; every log line carries `requestId` or `traceId`, and ledger lines carry `journalId` or `runId`; one trace spans the posting call, its outbox row and the projector's work.
2. **AS-66** (no secrets, no personal data) — **Given** every flow above run with a sentinel provider secret and a sentinel buyer email, **When** logs, events, outbox payloads, issue `details` and error responses are searched, **Then** the secret and the email appear nowhere; events and issues carry only IDs, references and amounts; raw provider bodies are never stored or logged; `5xx` responses carry a generic `detail`.
3. **AS-67** (boundaries, static) — **Given** the finished implementation, **Then** the ledger and reconciliation code reads and writes only tables owned by `payments` (the ownership check reports no finding for these files; today the code associates `User` and `Payment` models, registers `BisOrderModel`, and reads `Shop`), no ledger model has an association or foreign key to another model, the public entry point exports no model, `pnpm check:boundaries` is green, and every new table is in the ownership registry under `domain:payments`.
4. **AS-68** (configuration is validated at startup) — **Given** a fee of `0` or negative, a shard count outside `1–256`, a non-positive lock or statement timeout, a missing provider key, a page size outside `1–100`, a catch-up window outside `1–30` days, **When** the process starts, **Then** it fails with a message naming the setting and does not serve.
5. **AS-69** (graceful shutdown and timeouts) — **Given** a reconciliation run is paging the provider, **When** the process receives the stop signal, **Then** it stops requesting pages, ends the run `FAILED` with `failureCode: "interrupted"` (or leaves the lease to expire), and the next attempt follows AS-43; the settlement consumer finishes its message and stops taking new ones; every database statement and provider call in this capability has an explicit timeout (AS-26, AS-45).

---

### Edge Cases

- Two postings for one (kind, reference) at once, with equal or different lines: AS-07, AS-08, AS-12.
- A posting that fails after others in the caller's transaction succeeded: the whole transaction fails (AS-09); a failed posting never leaves entries, balances or events.
- A journal posted just before midnight or at a month boundary: one `postedAt` for all lines (AS-61); a reconciliation day boundary (AS-47).
- A refund before, after and during settlement (AS-21); a refund of a sale that does not exist or with another amount (AS-16); a late `order.paid` after a refund (AS-21).
- `order.paid` delivered before the sale exists, twice, or malformed (AS-18, AS-19, AS-20).
- A balance row held by another transaction (AS-26); opposite lock orders (AS-25); a hot account under 200 concurrent writers (AS-22).
- A seller account that must not overdraw (AS-10) versus one that may (ad charge, clawback).
- The balance read model behind, ahead, duplicated, replayed, or down (AS-30, AS-33, AS-37).
- Cross-tenant balance read (AS-34); a non-admin on finance endpoints (AS-52).
- The provider paging, repeating lines, timing out, answering garbage, or listing things we do not own (AS-44–AS-47).
- A run repeated, concurrent, crashed, interrupted or failed (AS-41–AS-45, AS-69); a day that is not closed or too old (AS-48).
- A discrepancy that was only timing (AS-49); an operator resolving twice or at once (AS-56, AS-58); the same request replayed (AS-57).
- A missing partition (AS-61); a drifted balance or read model (AS-62); two workers running one job (AS-63); migration of old data under load (AS-64).
- A shop that no longer exists: the ledger keeps its account and balance (money is never deleted); the shop ID in an event is trusted and not checked.

## Requirements *(mandatory)*

### Functional Requirements

**Journals**

- **FR-001**: Every money movement MUST be recorded as a journal of 2–200 non-zero whole-minor-unit lines in one currency whose amounts sum to exactly zero (negative = debit, positive = credit); the service MUST refuse any other journal with a named reason (AS-02, AS-04).
- **FR-002**: The store MUST independently refuse, at commit, any journal whose lines do not sum to zero, whatever wrote it (AS-03).
- **FR-003**: Entries MUST be append-only: the store MUST reject updates and deletes of entries; corrections MUST be new reversing journals (AS-06, AS-14).
- **FR-004**: Money MUST be integer minor units, exact up to the safe-integer range, with a currency on every journal and account; floating-point money MUST NOT exist; a running balance MUST NOT exceed the safe range (AS-05).
- **FR-005**: A journal MUST be uniquely identified by (kind, reference); the identifier MUST be deterministic from them; a second posting returns the existing journal and has no effect; a conflicting second posting MUST raise `JournalConflict`; uniqueness MUST be enforced by the store, not by a check before a write (AS-07, AS-08).
- **FR-006**: A posting MUST join the caller's transaction, MUST NOT open or commit its own, MUST NOT do network I/O, and MUST write the entries, the running balances and the outbox event atomically (AS-01, AS-09).
- **FR-007**: All lines of a journal MUST carry one `postedAt` taken from the injected clock (AS-01, AS-61).
- **FR-008**: Callers MUST be able to post only the kinds `PAYOUT`, `PAYOUT_REVERSAL`, `AD_CHARGE`, `ADJUSTMENT` through the exported `postJournal`; `SALE`, `REFUND`, `SETTLEMENT`, `SWEEP` are posted only by this capability (AS-04).
- **FR-009**: A `PAYOUT` journal that debits a seller account MUST be refused with `insufficient_balance` when it would take the balance below zero, decided atomically with the balance update; `PAYOUT_CLEARING` MUST never go below zero; other kinds MAY take a seller account negative (AS-10).

**Chart of accounts and fee**

- **FR-010**: The accounts are `PROVIDER_CLEARING`, `CLEARING` (`MARKETPLACE_CLEARING`), `PLATFORM_FEES`, `PAYOUT_CLEARING`, `PAYOUTS_SENT` and `SHOP_<uuid>`; any other account ID MUST be refused (`account_unknown`); callers MUST NOT name shards (AS-04).
- **FR-011**: There MUST be one fee rule, inside the ledger: a flat `50` minor units per captured payment, a validated setting; no caller passes a fee; capture of an amount not above the fee MUST be refused (AS-11, AS-13).
- **FR-012**: The buyer MUST NOT be a ledger account; the payer's ID MUST be stored only as a plain reference on the journal (AS-11).

**Capture, refund, settlement**

- **FR-013**: `recordPaymentCaptured` MUST post one `SALE` journal per payment inside the caller's transaction: `PROVIDER_CLEARING −amount`, `CLEARING +(amount − F)`, `PLATFORM_FEES +F`, recording `paymentId`, `orderId`, `paymentRef`, `userId`; a repeat returns the existing journal (AS-11, AS-12, AS-13).
- **FR-014**: `recordPaymentRefunded` MUST post one `REFUND` journal per payment that exactly reverses the sale and, if a settlement exists for the order, also reverses the shops' shares (AS-14, AS-15); it MUST refuse a missing sale, a different amount or currency, and be idempotent per payment (AS-16).
- **FR-015**: The settlement consumer MUST, on `order.paid`, post one `SETTLEMENT` journal per order: debit `CLEARING` by the sale's clearing credit and credit each shop of `shopOrders` with its share, computed by largest remainder over `subtotalMinor`, ties to the lowest shop ID, shares summing exactly to the net (AS-17).
- **FR-016**: The consumer MUST be idempotent per order and tolerate duplicates, concurrency and out-of-order delivery (AS-18, AS-20); it MUST validate every payload and dead-letter invalid ones without effect (AS-19).
- **FR-017**: Settlement and refund of one payment MUST be serialized so that a refunded payment is never settled and a settled-then-refunded payment is fully clawed back (AS-21).

**Sharding and concurrency**

- **FR-018**: The accounts `PLATFORM_FEES`, `PROVIDER_CLEARING` and `CLEARING` MUST be split into `N` shards (default 32, setting 1–256); the shard is a stable hash of the journal's reference; the hot accounts of one journal use the same shard index; reads MUST present the logical account as the sum of its shards (AS-22, AS-23, AS-27).
- **FR-019**: A sweep MUST periodically consolidate non-empty shards into shard 0 with one balanced, deterministic `SWEEP` journal per account per window, without losing or doubling concurrent postings (AS-24).
- **FR-020**: Every transaction MUST lock the balance rows it touches in ascending (account, shard) order, regardless of line order (AS-25).
- **FR-021**: A posting MUST bound its waits (lock limit 2 s, statement limit 5 s) and fail with the retryable `ledger_busy` without partial effects (AS-26).

**Balances and read model**

- **FR-022**: The ledger MUST keep a running balance and a version per (account, shard), updated by atomic increments in the same transaction as the journal; no balance MUST be computed by summing entries (AS-28).
- **FR-023**: `getBalances` MUST return authoritative balances for up to 500 accounts in one call, honouring the caller's transaction; `listSellerBalances` MUST page seller accounts with at least a minimum balance by keyset (AS-28, AS-29).
- **FR-024**: Each journal MUST emit one `ledger.journal_posted` v2 event through the outbox carrying, per line, the account, shard, amount, resulting balance and balance version (AS-01).
- **FR-025**: The balance read model MUST apply an event line only if its balance version is newer than the stored one; it MUST be idempotent, order-tolerant and rebuildable from the topic; invalid events MUST be dead-lettered without effect (AS-30, AS-31).
- **FR-026**: The balance read model MUST have a hot copy with an expiry and a durable copy; a read MUST fall back hot → durable → running balance; staleness MUST be at most 5 s at the 99th percentile and visible through `asOf` and a lag metric (AS-33, AS-37).
- **FR-027**: `GET /shops/:shopId/balance` MUST return the shop's `availableMinor` (negative allowed), `currency`, `asOf` and `source`, for members with `payouts.read` only; non-members MUST get the same `404` as for an unknown shop; role-lacking members `403`; invalid input `400`; unauthenticated `401`; rate limited per user (AS-32, AS-34, AS-35, AS-36).

**Reconciliation**

- **FR-028**: Reconciliation MUST read the provider's statement of a closed UTC day through a domain port, validating every line before use (AS-46).
- **FR-029**: It MUST consume the statement as a paged, lazily-advanced stream with backpressure, at most one page buffered, with job heartbeats (AS-44).
- **FR-030**: It MUST match statement lines to `SALE` and `REFUND` journals by provider reference, and produce issues of kind `MISSING_IN_LEDGER`, `MISSING_AT_PROVIDER`, `AMOUNT_MISMATCH`, `CURRENCY_MISMATCH`, `DUPLICATE_AT_PROVIDER`, `INVALID_PROVIDER_RECORD`; disputes and refunds we did not make are `MISSING_IN_LEDGER` with their type; a journal without a line in the window MUST be looked up at the provider by reference before it is reported (AS-39, AS-40, AS-46, AS-47).
- **FR-031**: Reconciliation MUST NOT post journals; it only reports (AS-40).
- **FR-032**: A run MUST be unique per (provider, day); a `COMPLETED` run is final and a repeat is a no-op without provider calls; concurrent attempts run once; a crashed run restarts the day with unique issues per (run, kind, reference); a failed run stores no issues (AS-41, AS-42, AS-43, AS-45, AS-50).
- **FR-033**: `day` MUST be a closed UTC day within 90 days; the schedule MUST run the previous UTC day and catch up days without a `COMPLETED` run in the last 7 (AS-48).
- **FR-034**: Provider failures MUST end the run `FAILED(provider_unavailable)` with a per-call timeout of 10 s, no retry inside the provider adapter and at most 3 job-level attempts with exponential backoff and full jitter (AS-45).
- **FR-035**: Open `MISSING_*` issues of the previous 3 days MUST be re-checked on each run and auto-resolved when they now match (AS-49).
- **FR-036**: A reconciled day's entries MUST never change; corrections are new journals in the current period referencing the day (AS-54).
- **FR-037**: Runs MUST emit `ledger.reconciliation_completed`, and each new issue `ledger.reconciliation_issue_opened`, through the outbox (AS-38, AS-39).

**Operators**

- **FR-038**: `GET /finance/reconciliation/runs` and `GET /finance/reconciliation/issues` MUST list by keyset (newest first, unique tiebreaker), with filters, for the platform `admin` role only (AS-51, AS-52).
- **FR-039**: `POST /finance/reconciliation/issues/:issueId/resolve` MUST require `Idempotency-Key`, be admin-only, and move an `OPEN` issue to `RESOLVED` with the actor, time and note; `adjusted` MUST post one balanced `ADJUSTMENT` journal (≤ 10 lines, accounts of the chart, `EUR`) in the same transaction (AS-53, AS-54, AS-55).
- **FR-040**: Resolving a resolved issue MUST return `409 issue_already_resolved`; competing resolutions MUST have exactly one winner; the endpoint MUST be rate limited and fail closed (AS-56, AS-58, AS-59).
- **FR-041**: Idempotency of the resolve request MUST follow V.6: replay returns the stored response with `Idempotency-Replayed: true`, in-flight `409`, different body `422` (AS-57).

**Housekeeping**

- **FR-042**: Entries MUST be partitioned by month on `postedAt`; partitions for the current month and the next 3 MUST be created by an idempotent weekly job; a catch-all partition MUST accept postings for a missing month, raise an alert, and be emptied by the next maintenance run without changing any total (AS-60, AS-61).
- **FR-043**: A daily checker MUST verify, for the last two closed days and the accounts touched in them, that journals balance, the day's entries sum to zero, running balances equal the sums of entries, and the read model equals the running balances; it MUST count each violation by check, log IDs, repair only the read model, and never edit the ledger (AS-62).
- **FR-044**: Every scheduled job MUST run once per schedule across replicas and be idempotent (AS-63).
- **FR-045**: Existing entries MUST be migrated by expand/contract with a batched, resumable, idempotent backfill and a verified contract step (AS-64).

**Boundaries and operability**

- **FR-046**: The capability MUST read and write only tables owned by `payments`; no association, foreign key or foreign model registration; no read of `User`, `Shop`, `BisOrder`, `Product`; cross-domain facts arrive only by the mechanisms named under "Scope" (AS-67).
- **FR-047**: No model leaves the domain's public entry point; the exports are exactly those listed under "Provides" (AS-67).
- **FR-048**: Metrics, logs and traces MUST be as in AS-65; secrets and personal data MUST NOT appear in logs, events, issues or errors (AS-65, AS-66).
- **FR-049**: Configuration MUST be validated at startup (AS-68); shutdown MUST be graceful and every outbound call and statement MUST have a timeout (AS-69).
- **FR-050**: Every HTTP error MUST be `application/problem+json` with the codes named in this spec (AS-34, AS-51–AS-59).

### Key Entities *(include if feature involves data)*

- **Journal**: one balanced money movement: identifier (deterministic), kind, reference, currency, `postedAt`, plain references (`paymentId`, `orderId`, `paymentRef`, `refundRef`, `userId`, `correctsDay`). Unique per (kind, reference).
- **Entry**: one line of a journal: journal, logical account, shard, signed amount (minor units), `postedAt`. Append-only, partitioned by month.
- **Account balance**: per (account, shard, currency): running balance and version, changed only with a journal.
- **Account**: logical account ID (system or `SHOP_<uuid>`), class (provider clearing, clearing, revenue, seller, payout clearing, payouts sent), whether sharded, whether it may go negative.
- **Balance read model value**: per (account, shard): balance and version, with a hot copy and a durable copy; derived, rebuildable.
- **Reconciliation run**: (provider, day) with status, counts, failure code, timestamps. Unique per (provider, day).
- **Reconciliation issue**: run, kind, reference, details, status `OPEN | RESOLVED`, resolution, note, resolver, adjustment journal.
- **Provider statement line** (external, validated copy): provider line ID, type, provider reference, signed amount, currency, created time.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After any mix of postings, retries, races, crashes and aborted transactions, the sum of all journal lines is exactly `0`, every journal sums to `0`, and every running balance equals the sum of its entries (checked after every concurrency scenario and by the nightly checker).
- **SC-002**: When the same posting, capture, refund, settlement message or resolution is sent 50 times at once, 100% of runs produce exactly one journal.
- **SC-003**: With 200 payments captured at once, 100% succeed with zero deadlocks, and the three hot accounts are exact to the minor unit.
- **SC-004**: A seller's balance page answers in under 100 ms at the 99th percentile with 100 million entries stored, and no request sums history.
- **SC-005**: A balance change is visible to the seller within 5 seconds at the 99th percentile; the page stays correct when the fast store is down.
- **SC-006**: Every refund of a settled or unsettled payment returns the books for that payment to exactly zero, in 100% of 50 racing runs.
- **SC-007**: A 25 000-line provider statement is reconciled with one page held in memory at a time, and the same day run twice produces the same run and issues.
- **SC-008**: Every seeded difference (missing, extra, wrong amount, wrong currency, duplicate charge, unrecorded refund, dispute) appears as exactly one issue; a clean day produces none.
- **SC-009**: A provider outage during reconciliation leaves zero partial issues and the day completes on a later attempt without manual action.
- **SC-010**: A finance operator resolves an issue with a documented reason in one request, and the correction is a single balanced journal that does not alter any closed day.
- **SC-011**: Zero cross-domain table reads, associations or foreign keys remain in the ledger and reconciliation code (ownership check clean for these files).

## Assumptions

- Defaults are recorded in `questions.md`; those that shape behaviour are repeated here.
- The fee is a flat 50 minor units per captured payment until S16 introduces commission rates; the platform has one currency, `EUR`.
- The buyer is not an account; the ledger needs no user data. Shop IDs in events are trusted; their existence is not checked inside postings.
- The balance read model's accepted staleness is 5 s at the 99th percentile, with a hot copy expiring after 24 h (refreshed on write) and a durable copy that does not expire, in the stores the domain map names for it.
- Sweeps run hourly into shard 0; shards are 32; `lock_timeout` 2 s and `statement_timeout` 5 s on postings.
- The provider's statement is available for 90 days and is complete for a UTC day by 02:30 UTC the next day; the provider's own processing fees are not booked; `transfer`, `payout` and `payout_reversal` lines are S15's and are skipped.
- Reconciliation reports, it never posts; the only automated state change is closing timing-only issues (AS-49).
- Admin means `AuthenticatedUser.role === "admin"`; no MFA step-up is assumed for resolving issues.
- Partial refunds are not supported; a refund is the full captured amount.
- Archiving old partitions to cold storage is not part of this capability.
- Ledger records are financial records: never deleted on user or shop deletion; retention and anonymisation follow the finance rules of S16.

## Cross-capability contracts

**Provides** (names exact; later specs read this section):

- **Modules** (public entry point `@app/domains/payments`, nothing else from this capability is exported): `LedgerModule` (core, worker, payment-processor: exports `LedgerService`; HTTP controllers for the balance and the finance endpoints), `LedgerWorkerModule` (worker: settlement consumer, sweep, invariant checker, partition maintenance, reconciliation, backfill), `LedgerProjectorModule` (projector: balance read model projector).
- **`LedgerService`** (R1; every method returns DTOs and plain values, never models; batch where a list is meant):
  - `recordPaymentCaptured(input: { paymentId: string; orderId: string; paymentRef: string; userId: string; amountMinor: number; currency: string }, tx: Transaction): Promise<{ journalId: string; created: boolean }>` — S13.
  - `recordPaymentRefunded(input: { paymentId: string; refundRef: string; amountMinor: number; currency: string }, tx: Transaction): Promise<{ journalId: string; created: boolean }>` — S13.
  - `postJournal(input: { kind: 'PAYOUT' | 'PAYOUT_REVERSAL' | 'AD_CHARGE' | 'ADJUSTMENT'; reference: string; currency: string; lines: { accountId: string; amountMinor: number }[] }, tx: Transaction): Promise<{ journalId: string; created: boolean }>` — S15 (`PAYOUT`, `PAYOUT_REVERSAL`), S36 (`AD_CHARGE`, `ADJUSTMENT`). Errors: `JournalUnbalanced`, `JournalConflict`, `InsufficientBalance`, `LedgerBusy` (retryable), `JournalInvalid{reason}`, `TransactionRequired`. Guarantees: balanced, once per (kind, reference), joins `tx`, no network I/O, event outboxed.
  - `getBalances(input: { accountIds: string[]; currency: string }, tx?: Transaction): Promise<Map<string, { balanceMinor: number; asOf: Date }>>` — authoritative; ≤ 500 IDs; unknown account → `0` — S15, S36, S16, S40.
  - `listSellerBalances(input: { currency: string; minMinor: number; limit: number; after?: string }): Promise<{ items: { shopId: string; balanceMinor: number }[]; next: string | null }>` — keyset by shop ID, `limit ≤ 200` — S15.
- **Constants and types**: `LEDGER_ACCOUNTS = { CLEARING: 'MARKETPLACE_CLEARING', PROVIDER_CLEARING: 'PROVIDER_CLEARING', PLATFORM_FEES: 'PLATFORM_FEES', PAYOUT_CLEARING: 'PAYOUT_CLEARING', PAYOUTS_SENT: 'PAYOUTS_SENT' }`, `shopAccount(shopId): string` (`SHOP_<shopId>`), `LedgerJournalKind`, the event contract `JournalPosted`.
- **HTTP** (schemas in `packages/contracts`):
  - `GET /shops/:shopId/balance?currency=EUR` → `200 balanceSchema {shopId, currency, availableMinor, asOf, source: "read_model" | "ledger"}`; `ShopScoped('payouts.read')`; problems `validation_failed` 400, `shop_not_found` 404, `permission_denied` 403, `rate_limited` 429. Policy `finance.balance.read`.
  - `GET /finance/reconciliation/runs?limit&cursor` → `reconciliationRunPageSchema {items: {id, provider, day, status: "RUNNING" | "COMPLETED" | "FAILED", providerLines, ledgerJournals, matched, issueCount, skipped, failureCode: string | null, startedAt, finishedAt: string | null}[], nextCursor: string | null}`.
  - `GET /finance/reconciliation/issues?status&kind&day&limit&cursor` → `reconciliationIssuePageSchema {items: {id, runId, day, kind, reference, status: "OPEN" | "RESOLVED", details: object, resolution: "explained" | "adjusted" | "auto_matched" | null, note: string | null, adjustmentJournalId: string | null, resolvedBy: string | null, resolvedAt: string | null, createdAt}[], nextCursor: string | null}`; admin only; `invalid_cursor` 400, `permission_denied` 403. Policy `finance.admin.read`.
  - `POST /finance/reconciliation/issues/:issueId/resolve` (`Idempotency-Key` required) body `resolveReconciliationIssueRequestSchema {resolution: "explained" | "adjusted", note: string 1–500, adjustment?: {currency: "EUR", lines: {accountId, amountMinor}[2–10]}}` → `200 reconciliationIssueSchema`; problems `reconciliation_issue_not_found` 404, `issue_already_resolved` 409, `idempotency_in_flight` 409, `idempotency_key_required | idempotency_key_reuse | adjustment_unbalanced | adjustment_account_invalid | adjustment_too_large` 422. Policy `finance.admin.write`.
  - Removed from this capability: `GET /shops/:shopId/payouts` (moves to S15).
- **Events** (outbox → topic `ledger.events`, key = aggregate ID; envelope `{eventId, type, version, occurredAt, aggregateId}`; money in `…Minor`):
  - `ledger.journal_posted` v2, aggregate `journalId`: `{journalId, kind, currency, postedAt, lines: [{accountId, shard, amountMinor, balanceAfterMinor, balanceVersion}], paymentId?: string, orderId?: string}`. **Consumers: S14's own balance projector; S16 and S40 (R3, projector or CDC); J01.**
  - `ledger.reconciliation_completed` v1, aggregate `runId`: `{runId, provider, day, status, matched, issueCount}`; `ledger.reconciliation_issue_opened` v1, aggregate `issueId`: `{issueId, runId, day, kind, reference}`. **Consumers: S28 (optional, finance alerts).**
- **Jobs** (registered with S49): `payments.reconcile-daily {day?}`, `ledger.sweep-hot-accounts`, `ledger.verify-invariants`, `ledger.ensure-partitions`, `ledger.backfill-balances`.
- **Consumers this capability runs**: `orders.events` `order.paid` (own consumer group `ledger-settlement`; dedupe by deterministic journal ID; deferral and dead-letter as in AS-19, AS-20); `ledger.events` `ledger.journal_posted` (balance projector; dedupe by balance version).
- **Metrics**: names in AS-65.

**Requires**:

- **S13** (`payments`, same domain): calls `recordPaymentCaptured` and `recordPaymentRefunded` with the shapes above inside its status transaction (`paymentId`, `orderId`, `paymentRef`, `userId`, `amountMinor`, `currency`; `refundRef`). **Differs from S13's spec**: S13 lists `{paymentId, userId, amountMinor, currency}` for capture and `{paymentId, amountMinor, currency}` for refund and a return of `{journalId}`; this capability additionally needs `orderId`, `paymentRef`, `refundRef` and returns `created` (additive); see `questions.md`. S13 reports `payments_conflicting_provider_state_total` and `payments_provider_mismatch_total`; this capability's reconciliation is where those become issues.
- **S10** (`orders`): event `order.paid` `{orderId, totalMinor, currency, paymentRef, paidAt, shopOrders: [{shopOrderId, shopId, subtotalMinor}], orderVersion}` (the fields S10's spec lists) on topic `orders.events`, key `orderId`, envelope `{eventId, type, version, occurredAt, aggregateId}`; `shopOrders[].subtotalMinor` of an order sum to the amount the shops are owed before the platform fee.
- **S03** (`tenancy`): `ShopScoped(permission)` guard, permission `payouts.read` (owner and admin roles), non-members answered `404 shop_not_found`.
- **S01** (`identity`): `Firewall()`, `@User()`, `AuthenticatedUser = { id, role, sessionId, amr }` with `role` value `admin` for platform operators.
- **S53** (events): `outbox.append(event)` inside the caller's transaction (IX.6); the relay to topic `ledger.events`; the consumer and projector framework (envelope check, schema validation, per-consumer idempotency, retry with backoff, dead-letter) for `orders.events` and `ledger.events`.
- **S49** (jobs): periodic jobs with single-run leases and heartbeats, retries with backoff (≤ 3 attempts for reconciliation), one-off batched jobs.
- **S50** (rate limiter): policies `finance.balance.read` 120/min per user (fail open), `finance.admin.read` 120/min per user (fail open), `finance.admin.write` 30/min per user (fail closed), with `Retry-After`.
- **S54** (platform toolkit): problem+json filter with `code` and `requestId`; the `Idempotency-Key` facility (mandatory header, stored replay, in-flight `409`, different body `422`, per-principal scope, `Idempotency-Replayed` header); injected clock; configuration validation; metrics registry; graceful shutdown.
- **The payment provider** (external, reached only through a domain port and one adapter that validates every answer): list balance-transaction statement lines created within a UTC window, paged by cursor, up to 100 per page, each with `{id, type: "charge" | "refund" | "dispute" | "transfer" | "payout" | "payout_reversal" | other, reference: string | null, amountMinor: signed integer, currency, createdAt}`; look up one line by provider reference; 10 s per call.
- **Stores the domain map names for the read model**: a hot key-value store with expiry and a durable key-value store, reached through the infrastructure libraries.
