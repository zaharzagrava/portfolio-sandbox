# Feature Specification: S18 — Usage Metering (late events, adjustments) and Entitlement Checks (domain `billing`)

**Feature Branch**: `S18-usage-entitlements` (spec directory `specs/domains/S18-usage-entitlements`)

**Created**: 2026-10-05

**Status**: Draft

**Input**: User description: "Usage metering (late events, adjustments) and entitlement checks used by other domains (domain `billing`)". Sources: Interview-Prep `10-System-Design/07-commerce-and-transactions.md` design 24 (entitlements derived from the live subscription, cached, never plan names; usage events ingested idempotently by event ID, aggregated per period, period locked at invoice time, late events as adjustments in the next invoice; out-of-order-safe events) and `06-Distributed-Systems/02-consistency-sagas-and-data-sync.md` §5 (period close: later corrections are adjustment entries that reference the original period, a closed period is never mutated; invariant `sum(advances) + adjustments == computed total` checked automatically). The showcase section `docs/showcase/sections/SD-24-subscriptions-billing.md` named in the capability catalog is not present in this checkout (S17 recorded the same); design 24 and the existing code were used instead. Pattern-map row for S18: **P0614** (reconciliation and period close; billing: late usage → adjustment lines). Domain map: `billing` owns plans, prices, subscriptions, invoices, usage metering and entitlements, exports `hasEntitlement` (R1), keeps usage in an analytical store and entitlements in a cache, and consumes `usage.recorded`. Constitution v3.1.0 (III, IV, V, VII, VIII, IX, X).

## Scope

Other capabilities need two things from billing. First, to **ask what a customer's plan allows** (may this shop run auctions, how many products may it list, how many API calls does this month allow) without ever naming a plan. Second, to **report what a customer consumed** (API calls, assistant tokens) so that usage above the plan's included amount is billed fairly, even when the report arrives days late. Nothing in this flow may bill the same usage twice, lose usage that arrived late, rewrite an invoice already issued, or let a stale cache hand out features a customer no longer pays for.

In scope:

- **Entitlement checks** for other domains: the entitlements of a subject (shop or buyer) derived from its live subscription or the free tier; a boolean feature check, a batch read, a count-limit check (products, seats), a monthly-quota check (API calls, assistant tokens); a route guard that denies a shop route when the shop's plan lacks a feature.
- **Entitlement cache**: cache-aside, invalidated by subscription changes through events and by the direct call S17 makes after commit; version-guarded against out-of-order events and against a slow load overwriting a newer state; stale-on-error; stampede-safe.
- **Usage ingestion**: consuming usage events published by other domains, idempotently, with validation, a late-arrival window, dead-lettering, durability.
- **Usage for invoices**: the usage and adjustment lines S17's renewal needs, computed from exact de-duplicated totals, with a settlement ledger that makes each unit billable exactly once, late events priced as adjustments in the next invoice that references the original period, a closed period never mutated, and an automatic reconciliation check.
- **Usage read**: a subject reads its monthly usage against its limits (shop and buyer routes).

Out of scope (owners named):

- Plans, prices, subscriptions, invoices, the renewal run, dunning, proration, the subscription state machine, the payment provider → **S17** (same domain). This capability reads S17's committed state and is called by S17's renewal.
- Producing usage events: seller public API request metering → the **developer-platform** capability that emits `usage.recorded`; LLM call metering → **S46** (emits `llm.call_completed`); KYC extraction metering → **S04** through S46. Rate limiting of the public API and of the assistant by request count → **S50** and the assistant capability (a protective limit, not a billed quota).
- Enforcing a quota or limit inside another domain's request path (what to do when the shop is over its product limit) → the calling capability; this capability only answers the question.
- Shops, roles and the `shop.read` permission → **S03**. Authentication → **S01**. Jobs → **S49**. Outbox, inbox, consumers, DLQ → **S53**. problem+json, clock, config, metrics, shutdown → **S54**.
- A usage or billing screen (no web capability owns one), usage dashboards and forecasts, tax, refunds, negative adjustments (usage reversals), invoicing the usage of a subscription's last period when it is cancelled (see Assumptions), usage-based charges for subjects with no subscription (free tier has quotas, no overage billing).

Cross-domain data used (IX.7): the live subscription basis by an **R1** exported service of the same domain (`SubscriptionBasisService`, S17; no cross-domain access); shop access on the usage route by **R1** (`ShopScoped`, S03); usage events from developer-platform and LLM metering by **R3** (domain event → consumer → store owned by billing); billing's own events (`billing.subscription_status_changed`) by the same R3 pattern. **R2 is not used.** Usage storage and the settlement ledger are this domain's own data; no other domain reads them, and billing never reads another domain's tables.

## User Scenarios & Testing *(mandatory)*

Notation: money is integer minor units (`150` = 1.50 EUR) in `…Minor` fields; currency `EUR`. "At `T`" means the injected clock reads `T`. All instants and period boundaries are UTC; a period is the half-open interval `[start, end)`. The default clock for examples is `2026-04-10T12:00:00Z`. "Basis" is S17's answer for a subject's live subscription.

**Dataset DS-1** (used throughout). Plan entitlements: `starter` = `{maxProducts: 100, seats: 3, auctions: false, apiCallsPerMonth: 10000, assistantTokensPerMonth: 0}`; `pro` = `{maxProducts: 10000, seats: 25, auctions: true, apiCallsPerMonth: 1000000, assistantTokensPerMonth: 5000000}`; buyer plan `plus` = `{freeShipping: true, earlyAccessDrops: true, assistantTokensPerMonth: 2000000}`. **Free tier** (owned by this capability): shop `{maxProducts: 10, seats: 1, auctions: false, apiCallsPerMonth: 1000, assistantTokensPerMonth: 0}`; buyer `{}`. Price `starter` monthly: included usage `api.calls` 10,000, overage `50` per 1,000. Subjects: shop `a` on `pro`, `ACTIVE`, basis version 3, owner Ann (`shop.read`), viewer Vic (`shop.read`); shop `b`, owner Bo; shop `c` on `starter`, `PAST_DUE`, version 5; shop `d` `UNPAID` (no live basis); shop `e` no subscription; shop `f` on `starter`, `ACTIVE`, period `2026-04-01 → 2026-05-01`, subscription `sf`; user `u` on `plus`, `ACTIVE`; user `w` no subscription. Metrics: `api.calls`, `llm.assistant.tokens`, `llm.kyc_extraction.tokens`.

### User Story 1 — Other domains ask what a plan allows, and the answer is right (Priority: P1)

A seller opens an auction screen, a shop lists its 101st product, a buyer asks the assistant for a long answer. Each domain asks billing one question about the subject and gets one answer derived from the live subscription, or from the free tier when there is none.

**Why this priority**: every paid feature in the product is gated here. A wrong answer either gives away paid features or blocks paying customers (note: "the app checks features/limits derived from the active subscription, not the plan name").

**Independent Test**: seed subscriptions with a fake basis source; call each export and the guard over HTTP; assert answers and absence of side effects.

**Acceptance Scenarios**:

1. **AS-01** (entitlements of a live subscription) — **Given** DS-1, **When** `get('SHOP', a)`, **Then** exactly `pro`'s entitlements; `get('USER', u)` returns exactly `plus`'s; `get('SHOP', c)` (`PAST_DUE`) returns `starter`'s (the grace period keeps access).
2. **AS-02** (free tier) — **Given** shops `d` (`UNPAID`) and `e` (none) and a subscription that is `CANCELED`, **When** `get('SHOP', …)`, **Then** the free-tier shop entitlements; **When** `get('USER', w)`, **Then** `{}`. A `TRIALING` subscription returns its plan's entitlements.
3. **AS-03** (boolean check) — **When** `hasEntitlement('SHOP', a, 'auctions')`, **Then** `true`; for `c`, `d`, `e` `false`; `hasEntitlement('USER', u, 'freeShipping')` is `true`, for `w` `false`.
4. **AS-04** (numeric keys count as present when positive) — **When** `hasEntitlement('SHOP', e, 'seats')`, **Then** `true` (free tier `seats: 1`); `hasEntitlement('SHOP', e, 'assistantTokensPerMonth')` is `false` (`0`); a key absent from the subject's entitlements is `false`.
5. **AS-05** (unknown feature) — **When** `hasEntitlement('SHOP', a, 'teleport')`, **Then** it rejects with `unknown_entitlement`, reads nothing and a fail-closed `false` is never returned silently; the same for `checkLimit` and `checkQuota`.
6. **AS-06** (batch read) — **When** `getMany('SHOP', [a, c, d, e, a])`, **Then** a map of 4 entries (`a`, `c`, `d`, `e`) equal to the single reads, and the basis source received **one** batch call (no per-id calls); an empty list returns an empty map with no call; 501 distinct ids reject with `too_many_ids` and nothing is read.
7. **AS-07** (count limit) — **When** `checkLimit('SHOP', a, 'maxProducts', 9999)`, **Then** `{allowed: true, limit: 10000, remaining: 1}`; with `10000` → `{allowed: false, limit: 10000, remaining: 0}`; `checkLimit('SHOP', e, 'maxProducts', 10)` → `{allowed: false, limit: 10, remaining: 0}`; a key the subject lacks (`checkLimit('USER', w, 'maxProducts', 0)`) → `{allowed: false, limit: 0, remaining: 0}`; a non-limit key (`auctions`) rejects `not_a_limit`; a negative or non-integer current value rejects `invalid_current_value`. `allowed` means "one more is permitted" (`current < limit`).
8. **AS-08** (monthly quota check) — **Given** shop `a` has `12,500` `api.calls` in April, **When** `checkQuota('SHOP', a, 'apiCallsPerMonth')` at the default clock, **Then** `{allowed: true, used: 12500, limit: 1000000, resetsAt: "2026-05-01T00:00:00.000Z"}`; shop `e` with `1,000` calls → `{allowed: false, used: 1000, limit: 1000, resetsAt: …}`; `assistantTokensPerMonth` maps to metric `llm.assistant.tokens`; a non-quota key rejects `not_a_quota`; when the usage store fails the call rejects `usage_unavailable` (the caller decides to fail open or closed).
9. **AS-09** (the route guard) — **Given** a route guarded with `RequiresShopEntitlement('auctions')` under `ShopScoped('shop.read')`, **When** Ann calls it for shop `a`, **Then** the handler runs (`200`); **When** a member of shop `c` or `e` calls it, **Then** `403 entitlement_required` problem+json with `feature: "auctions"` and the handler did not run (no side effect); **When** a non-member of `a` calls it for `a`, **Then** `404` (membership first, no entitlement information leaks); **When** there are no credentials, **Then** `401`.
10. **AS-10** (a misconfigured route cannot start) — **Given** a controller method with the guard but without shop scoping, or with a feature key outside the allowlist, **When** the application module initialises, **Then** startup fails with an error naming the route; no request is ever served by a guard that cannot see a shop.
11. **AS-11** (source down fails closed) — **Given** nothing cached for shop `a` and the basis source failing, **When** the guard or `get` runs, **Then** `503 entitlements_unavailable` (guard) or a rejection `entitlements_unavailable` (service) with a generic detail; the handler did not run; it never answers "free tier" because it does not know.

---

### User Story 2 — The cache is fast, and never wrong for long or in the wrong direction (Priority: P1)

Checks happen on hot paths, so answers are cached. A plan change, a failed payment or a cancellation must reach every check quickly, in order, and a slow or duplicated message must not resurrect an old plan.

**Why this priority**: a stale "yes" gives paid features away; a stale "no" blocks a customer who just paid (S17's J02 promises the plan within 5 seconds of subscribing).

**Independent Test**: a controllable basis source (count calls, delay, fail) and a real cache; deliver events through the real consumer.

**Acceptance Scenarios**:

1. **AS-12** (cache-aside with a TTL) — **When** `get('SHOP', a)` is called twice within 300 s, **Then** the basis source received one call; at `+301 s` the next `get` calls it again; the cached value is the full entitlement object plus the basis `subscriptionId` and `subscriptionVersion` (both `null` for the free tier).
2. **AS-13** (stampede) — **Given** a cold entry, **When** 50 `get('SHOP', a)` calls run concurrently, **Then** the basis source received exactly **one** call and all 50 got the same answer.
3. **AS-14** (direct invalidation after a change) — **Given** shop `e` cached as free tier, **When** S17 commits a subscription to `pro` and calls `invalidate('SHOP', e)`, **Then** the next `get` returns `pro`'s entitlements (one basis call); `GET /shops/e/subscription` (S17) shows them within 5 s of the commit.
4. **AS-15** (event invalidation, idempotent) — **Given** `billing.subscription_status_changed {subscriptionId, subjectType: 'SHOP', subjectId: e, status: 'ACTIVE', from: 'TRIALING', planCode: 'pro', subscriptionVersion: 4}` with envelope `eventId`, **When** it is processed, **Then** the entry for `e` is dropped and the next `get` reloads; **When** the same `eventId` is delivered again, **Then** nothing changes and `entitlement_invalidations_total{outcome="applied"}` stays `1`.
5. **AS-16** (out-of-order events) — **Given** the cache holds `e` at `subscriptionVersion 7`, **When** an event with `subscriptionVersion 5` arrives, **Then** it is ignored (entry kept, no basis call, `outcome="stale_event"`); **When** one with `8` arrives, **Then** the entry is dropped; **When** an event for a *different* `subscriptionId` of the same subject arrives (a re-subscription), **Then** the entry is dropped whatever its version; **When** one for a subject with no entry arrives, **Then** nothing is stored and a later `get` loads fresh.
6. **AS-17** (a slow load never overwrites a newer state) — **Given** a `get` for `a` whose basis call is in flight and returns version `7`, **When** an event with `subscriptionVersion 8` is processed before that call returns, **Then** the in-flight caller receives the version-7 answer but it is **not stored**; the next `get` loads the version-8 basis (`pro` → free after cancellation, for example).
7. **AS-18** (invalid event payload) — **When** an event lacks `subjectId`, has `subjectType` `'TEAM'`, a non-integer or negative `subscriptionVersion`, or is not valid JSON, **Then** it is dead-lettered with its reason, the cache is untouched and no basis call happens; the next valid message is processed.
8. **AS-19** (stale on error) — **Given** an entry for `a` cached `6 min` ago (past the TTL) and the basis source failing, **When** `get` runs, **Then** the stale entry is returned and `entitlements_stale_served_total` increments; **When** the entry is `61 min` old, **Then** `get` rejects `entitlements_unavailable` (AS-11).
9. **AS-20** (cache store down) — **Given** the cache store is unreachable, **When** `get` runs, **Then** it loads from the basis source and answers correctly (`entitlements_cache_errors_total` increments, no error to the caller); **When** `invalidate` or the event consumer cannot reach the store, **Then** the failure is **not** swallowed: `invalidate` rejects and the event is not acknowledged and is redelivered, reaching the DLQ only after the configured attempts.
10. **AS-21** (subjects are isolated) — **Given** `get('SHOP', a)` and `get('USER', a)` (the same id used as both types), **Then** two independent entries; invalidating one leaves the other.

---

### User Story 3 — Usage reported by other domains is counted once, even when late, repeated or out of order (Priority: P1)

The public API and the LLM layer report what each subject consumed. Reports are retried, replayed, delayed and reordered; the totals must still be exact.

**Why this priority**: usage drives overage invoices. Double counting overcharges; losing events undercharges; (note: "ingest usage events idempotently (event IDs)").

**Independent Test**: publish messages through the real consumer; read totals through the usage read API and the store.

**Acceptance Scenarios**:

1. **AS-22** (accepted event) — **Given** `usage.recorded {metric: "api.calls", quantity: 120, ts: "2026-04-10T11:59:00Z"}` with `aggregateId a` and `eventId E1`, **When** it is processed, **Then** shop `a`'s April `api.calls` total rises by `120`, `usage_events_ingested_total{metric_class="api"}` is `1`, and the stored row carries the subject, metric, quantity, `ts`, event id and the ingestion instant.
2. **AS-23** (duplicate delivery counts once) — **When** `E1` is delivered twice (and a third time after a consumer restart), **Then** the total rose by `120` once; **When** a different `eventId` `E2` carries the same payload, **Then** it counts (two real events); the dedup identity is the event id.
3. **AS-24** (order independence) — **Given** three events with distinct ids and `ts` in the order `T3, T1, T2`, **When** delivered in that order or any permutation, **Then** the totals per period are identical.
4. **AS-25** (period boundary) — **Given** events at `2026-04-30T23:59:59.999Z` and `2026-05-01T00:00:00.000Z`, **Then** the first counts in April and the second in May (`[start, end)`).
5. **AS-26** (late arrival accepted) — **Given** an event with `ts 2026-04-28T10:00:00Z` processed at `2026-05-03T09:00:00Z`, **Then** it is accepted and counted in April's total (its ingestion instant is May 3, which is what makes it "late" for invoicing, User Story 4).
6. **AS-27** (LLM calls) — **Given** `llm.call_completed` (S46) with envelope `aggregateId c1` (the call id) and payload `{subjectId: u, metric: "llm.assistant.tokens", billableTokens: 1830, …}`, **When** processed, **Then** `u`'s `llm.assistant.tokens` rises by `1830`; **When** the same call arrives in a *new* envelope (a producer retry, same `aggregateId c1`), **Then** it still counts once (identity `llm:c1`); `billableTokens: 0` records nothing and `usage_events_ignored_total{reason="zero_quantity"}` is `1`; a call with `metric: "llm.kyc_extraction.tokens"` and `subjectId` a shop id records that metric for the shop.
7. **AS-28** (validation, one class each) — **When** a message has: a metric not matching `^(api\.calls|llm\.[a-z][a-z_]{0,31}\.tokens)$`; `quantity` `0`, `-5`, `1.5`, `"10"` or above `1,000,000,000`; a malformed `ts`; a `ts` more than 5 minutes after now; a `ts` older than 90 days before now; a missing or empty `subjectId`; or is not valid JSON, **Then** it is dead-lettered with the reason (`invalid_payload`, `unknown_metric`, `ts_in_future`, `too_old`) in `usage_events_rejected_total{reason}`, no row is written, and the totals are unchanged. Unknown extra fields are ignored.
8. **AS-29** (poison does not block) — **Given** a poison message between two valid ones on the same partition, **Then** both valid messages are counted and the poison message is dead-lettered.
9. **AS-30** (a failed write is not a lost event) — **Given** the usage store rejects writes, **When** a valid event is processed, **Then** it is not acknowledged and is redelivered, nothing is counted yet; **When** the store recovers, **Then** it is counted exactly once.
10. **AS-31** (a batch with duplicates inside it) — **Given** one delivered batch of 100 events containing 10 duplicates of earlier ids, **Then** the total reflects 90 new events.

---

### User Story 4 — Invoices bill usage above the plan once, and late usage becomes an adjustment (Priority: P1)

When a subscription renews, S17 asks for the usage lines of the period that just ended. Usage above the included amount is billed per started 1,000 units; usage that shows up later is billed in the next invoice as an adjustment that names the original period; invoices already issued are never touched.

**Why this priority**: it is the money. The note's rule: "lock the period at invoice time, and handle late events as adjustments in the next invoice"; P0614: "corrections go in as adjustments referencing the original period (never mutate closed periods)".

**Independent Test**: seed usage events and a settlement ledger; call the lines provider and the settlement; assert lines, ledger rows and invariants; run two renewals concurrently.

**Acceptance Scenarios**:

1. **AS-32** (overage line) — **Given** subscription `sf` (price `starter`) and `12,500` `api.calls` with `ts` in `[2026-04-01, 2026-05-01)`, **When** S17 calls `linesFor({subscriptionId: sf, subjectId: f, priceId, periodStart: 2026-04-01, periodEnd: 2026-05-01, measuredAt: 2026-05-01T00:00:00Z})`, **Then** `lines = [{kind: "USAGE", description: "api.calls: 2500 units over 10000 included", quantity: 2500, amountMinor: 150}]` and a settlement plan `{entries: [{metric: "api.calls", periodStart, periodEnd, fromQuantity: 0, toQuantity: 12500, includedQuantity: 10000, overagePer1000Minor: 50}]}`; nothing is written by `linesFor`.
2. **AS-33** (no overage) — **Given** `10,000` calls exactly, or none, **Then** `lines: []` and the settlement plan still carries the entry (`toQuantity 10000` or `0`).
3. **AS-34** (block rounding) — **Then** over-included units `0 → 0`, `1 → 50`, `1000 → 50`, `1001 → 100`, `2500 → 150` (rate 50): a started block of 1,000 units is billed in full; integer arithmetic only, safe above 2^53 inputs rejected with `amount_out_of_range`.
4. **AS-35** (several metrics, stable order) — **Given** a price with included usage for `api.calls` and `llm.assistant.tokens`, **Then** lines are ordered by metric ascending, `USAGE` before `ADJUSTMENT`, each metric's adjustments by period start ascending; the same inputs always produce byte-identical lines.
5. **AS-36** (subjects without included usage) — **Given** a buyer subscription whose price has no included usage, **Then** `lines: []` with no query to the usage store.
6. **AS-37** (settlement is recorded with the invoice, exactly once) — **Given** the plan of AS-32, **When** S17 calls `settle({invoiceId: I1, subscriptionId: sf, settlement})` inside its invoice transaction, **Then** one ledger row `(sf, 2026-04-01, api.calls)` holds `settledQuantity 12500`, `settledAmountMinor 150`, the snapshot `included 10000 / rate 50`, `lastInvoiceId I1`; **When** `settle` repeats with `I1`, **Then** it is a no-op returning the same result; **When** it is called with a different invoice `I2` and the same `fromQuantity 0`, **Then** it rejects `settlement_conflict` and the ledger is unchanged.
7. **AS-38** (late events become an adjustment) — **Given** AS-37 and then 800 further April events (ingested after the measurement), **When** the June renewal calls `linesFor` for period `2026-05-01 → 2026-06-01`, **Then** `lines` contains the May `USAGE` line (if any) and `{kind: "ADJUSTMENT", description: "api.calls: 800 late overage units for 2026-04-01..2026-05-01", quantity: 800, amountMinor: 50}` (13,300 used: 3,300 over = 4 blocks = 200; settled 150; delta 50); after `settle` the April row holds `settledQuantity 13300`, `settledAmountMinor 200`; the next `linesFor` produces no April adjustment.
9. **AS-39** (late events under the allowance) — **Given** April settled at `9,000` (no line, row `settledAmountMinor 0`), **When** 1,500 late events arrive, **Then** the next invoice has `{kind: "ADJUSTMENT", description: "api.calls: 500 late overage units for 2026-04-01..2026-05-01", quantity: 500, amountMinor: 50}` (10,500 → 500 over → 1 block); with only 500 late events (9,500) there is **no** line and the row moves to `settledQuantity 9500`.
10. **AS-40** (late events inside an already-billed block) — **Given** April settled at `12,500` (`150`), **When** 200 late events arrive (12,700: 2,700 over = 3 blocks = 150), **Then** no line (delta `0`) and the row moves to `12700`; **When** later 300 more (13,000, still 3 blocks), **Then** no line; **When** 1 more (13,001: 3,001 over = 4 blocks), **Then** an adjustment `quantity 1, amountMinor 50`; across the steps `sum(USAGE + ADJUSTMENT amounts) = 200 = price(13,001 used)` (the P0614 invariant).
11. **AS-41** (adjustments use the terms of the period, not today's price) — **Given** April settled under included `10000 / 50` and the subscriber's price later changed to `10000 / 60`, **When** 800 late April events arrive, **Then** the adjustment is `50` (rate 50, from the ledger snapshot).
12. **AS-42** (a closed period is never mutated) — **Given** the invoice `I1` and its lines (S17) and the adjustment of AS-38, **Then** `I1` and its lines are byte-for-byte unchanged; the adjustment exists only on the later invoice and names the original period in its description; no ledger row is deleted or rewritten except the forward `settled…` fields.
13. **AS-43** (two renewals racing) — **Given** two concurrent renewals of the same subscription compute plans from `fromQuantity 12500` and both call `settle` with different invoices (`Promise.all`), **Then** exactly one succeeds, the other rejects `settlement_conflict`, and the ledger reflects exactly one settlement (no double billing).
14. **AS-44** (usage store down or slow) — **Given** the usage store fails or takes longer than 5 s, **When** `linesFor` runs, **Then** it rejects `usage_unavailable` at or before 5 s, writes nothing and returns no partial lines (S17 defers the renewal, S17 AS-36).
15. **AS-45** (invalid input) — **When** `linesFor` is called with `periodEnd <= periodStart`, a `priceId` that is not the subscription's, or a subject that is not the subscription's, **Then** it rejects `invalid_input`, reads no usage and writes nothing.
16. **AS-46** (a period is final once no late event can exist) — **Given** April's row and `measuredAt = 2026-08-05T00:00:00Z` (more than 91 days after `2026-05-01`), **When** `linesFor` then `settle` run, **Then** the final delta (if any) is settled and the row is marked closed; a later `linesFor` does not query April again (no adjustment is ever produced for a closed period).
17. **AS-47** (reconciliation check) — **Given** the daily reconciliation over ledger rows, **When** every open row satisfies `settledAmountMinor == price(settledQuantity under its snapshot)` and `settledQuantity <= current exact total`, **Then** `usage_ledger_drift` is `0`; **When** a row is corrupted (`settledAmountMinor` altered, or `settledQuantity` above the current total), **Then** the gauge is `1` per bad row, an error is logged with the subscription, period and metric (no amounts of other tenants), and nothing is modified; running twice gives the same result and two replicas run it once per slot.
18. **AS-48** (data from before this release) — **Given** invoices issued by the previous implementation within the last 90 days, **When** the migration has run, **Then** each such `(subscription, period, metric)` has a ledger row whose `settledQuantity` equals the usage that existed at that invoice's `usageMeasuredAt`; a late April event after the migration is adjusted exactly once; the migration is repeatable (a second run changes nothing).

---

### User Story 5 — A customer sees what they used against what they get (Priority: P2)

A seller or buyer reads this month's usage next to the plan limits, and other domains read the same numbers to decide whether to let a request through.

**Why this priority**: trust and support load; also the read path other capabilities need. No screen exists, so this is an API.

**Independent Test**: seed events and subscriptions; call the routes as members, non-members, anonymous; exceed the rate limit.

**Acceptance Scenarios**:

1. **AS-49** (shop usage) — **Given** shop `a` with `12,500` `api.calls` and `300,000` `llm.assistant.tokens` in April, **When** Ann `GET /shops/a/usage`, **Then** `200 {month: "2026-04", periodStart: "2026-04-01T00:00:00.000Z", periodEnd: "2026-05-01T00:00:00.000Z", asOf, metrics: [{metric: "api.calls", used: 12500, limit: 1000000, remaining: 987500}, {metric: "llm.assistant.tokens", used: 300000, limit: 5000000, remaining: 4700000}]}` (parses with the contracts schema `usageSummarySchema`); metrics are sorted by name; every quota-mapped metric is present even with `0` usage; any other metric with usage appears with `limit: null, remaining: null`; the subject's usage of other subjects is never included.
2. **AS-50** (months) — **When** `?month=2026-03`, **Then** March's totals; `?month=2026-05` (future), `?month=2025-03` (older than 12 months back), `?month=2026-4` and `?month=abc` → `400 validation_failed`, nothing read.
3. **AS-51** (who may read) — **When** Vic (`shop.read`) calls it, **Then** `200`; **When** Bo (shop `b`) calls `/shops/a/usage`, **Then** `404` with the same body as for an unknown shop; **When** there are no credentials, **Then** `401`.
4. **AS-52** (buyer usage) — **When** user `u` `GET /me/usage`, **Then** the same shape for `u`'s subject only (`llm.assistant.tokens` limit `2000000`); the route takes no subject parameter, and another user's data cannot be named.
5. **AS-53** (rate limit) — **When** a subject calls the route a 61st time within a minute, **Then** `429` problem+json with `Retry-After`; the limiter fails closed.
6. **AS-54** (usage store down) — **Then** `503 usage_unavailable` with a generic detail, no partial body and no stack, SQL or store message in the response or logs.
7. **AS-55** (freshness) — **Given** an event processed at `T`, **When** the route is read at `T + 30 s`, **Then** it is included (the read is exact: duplicates are collapsed at read time).

---

### User Story 6 — Operators can see and trust the machinery (Priority: P3)

**Why this priority**: invariants and boundaries are only real if they can be observed and checked.

**Acceptance Scenarios**:

1. **AS-56** (boundaries) — **Then** the ownership check reports 0 cross-domain accesses for billing and every new table is in the ownership registry as `domain:billing`; the entry point exports only the contracted services and types (no model, projector or consumer class); no other domain provides billing's services itself.
2. **AS-57** (observability) — **Given** a run with 3 valid events, 1 duplicate, 1 poison message, 2 entitlement checks and 1 settlement conflict, **Then** `usage_events_ingested_total` is `3`, `usage_events_rejected_total{reason="invalid_payload"}` is `1`, the duplicate changes no total, `entitlement_checks_total` is `2` and `usage_settlement_conflicts_total` is `1`, and every log line carries a request or job id and no payment data.

---

### Edge Cases

- A usage event for a subject that has no subscription (free tier): it is stored and readable (AS-49), counted against quotas (AS-08), never invoiced (no subscription to renew).
- A subscription changes plan mid-period: the period's included amount and rate are the ones in the settlement plan at first measurement (the price of the subscription when the period closes); later adjustments use that snapshot (AS-41).
- A subscription is cancelled: its last period gets no renewal invoice and therefore no usage line; this is a stated limit (see Assumptions), not an error.
- A zero-amount adjustment (inside an already-billed block) moves the ledger forward without a line (AS-40) so the same units are not examined twice.
- Two ids that differ only in case are two subjects; ids are compared exactly.
- A clock moved backwards between measurement and settlement: the plan is bound to `fromQuantity`, not to time, so a stale plan is rejected (AS-37, AS-43).
- A basis source that answers `null` for a subject with a `TRIALING` subscription: not possible by contract (trialing is live); a `null` is the free tier.
- A very large quantity sum (above 2^53): rejected with `amount_out_of_range`, never wrapped (AS-34).

## Requirements *(mandatory)*

### Functional Requirements

**Entitlement answers**

- **FR-001**: An entitlement answer for a subject is the live subscription's plan entitlements (statuses `TRIALING`, `ACTIVE`, `PAST_DUE`), otherwise the free tier of the subject type (AS-01, AS-02).
- **FR-002**: The free-tier entitlements are owned and defined by this capability exactly as in DS-1; a plan's entitlement keys are the allowlist `freeShipping`, `earlyAccessDrops`, `maxProducts`, `seats`, `auctions`, `apiCallsPerMonth`, `assistantTokensPerMonth`; any other key is rejected (AS-05).
- **FR-003**: `hasEntitlement` is `true` for a boolean key whose value is `true` and for a numeric key whose value is greater than `0`; a missing key is `false` (AS-03, AS-04).
- **FR-004**: `getMany` answers up to 500 distinct ids with one batch call to the basis source, collapses duplicates, and never loops per id (AS-06).
- **FR-005**: `checkLimit` answers `{allowed, limit, remaining}` for the count keys `maxProducts` and `seats` with `allowed = current < limit`; a missing limit is `0` (AS-07).
- **FR-006**: `checkQuota` answers `{allowed, used, limit, resetsAt}` for `apiCallsPerMonth` (metric `api.calls`) and `assistantTokensPerMonth` (metric `llm.assistant.tokens`) over the current UTC calendar month from exact usage; it rejects rather than guessing when usage cannot be read (AS-08).
- **FR-007**: Entitlements are derived only from the committed state of the subscription through the basis service of S17; this capability holds no copy of plans, prices or subscriptions (AS-01, AS-14).
- **FR-008**: A route guard denies a shop route with `403 entitlement_required` (problem+json, `feature` member) when the shop lacks the feature, runs only after shop membership is established, and answers `503 entitlements_unavailable` when the answer cannot be determined; a guard that cannot see a shop or names an unknown feature prevents application startup (AS-09, AS-10, AS-11).

**Entitlement cache**

- **FR-009**: Answers are cached per `(subjectType, subjectId)` with a 300 s TTL; the cache is never the source of truth, and a cache failure never changes an answer (AS-12, AS-20).
- **FR-010**: Concurrent cold reads of one subject cause one load per process (AS-13).
- **FR-011**: `invalidate` drops the entry after S17 commits; the consumer of `billing.subscription_status_changed` drops it for events newer than the cached `subscriptionVersion`, ignores older or equal ones of the same subscription (an event for a different subscription always drops it), and is idempotent by event id (AS-14, AS-15, AS-16).
- **FR-012**: A load that started before an invalidation of a newer `subscriptionVersion` never stores its result (AS-17).
- **FR-013**: When a load fails, an entry up to 60 minutes old is served and counted; older or absent entries make the call reject `entitlements_unavailable` (AS-11, AS-19).
- **FR-014**: An invalidation that cannot be performed is reported to its caller and, in the consumer, redelivered; never swallowed (AS-20).
- **FR-015**: The consumer validates the event payload with a schema before acting, deduplicates on `eventId`, and dead-letters invalid messages without effect (AS-15, AS-18).

**Usage ingestion**

- **FR-016**: Usage is accepted only from events: `usage.recorded` (public API metering) and `llm.call_completed` (LLM metering). No exported function lets another domain write usage directly (AS-22, AS-27, AS-56).
- **FR-017**: Each usage event has an identity (its `eventId`, or `llm:<aggregateId>` for LLM calls, the aggregate being the call id); the same identity counts once however many times, in whatever order or batch, it is delivered (AS-23, AS-24, AS-27, AS-31).
- **FR-018**: A usage record is valid when its metric matches the allowlist pattern, its quantity is an integer from `1` to `1,000,000,000`, its `ts` is an ISO instant between `now − 90 days` and `now + 5 minutes`, and its subject id is non-empty; each failure class is dead-lettered with a distinct reason (AS-28).
- **FR-019**: Usage is attributed to a period by its `ts` in the half-open interval `[periodStart, periodEnd)`; the ingestion instant is stored but never used to attribute usage (AS-25, AS-26).
- **FR-020**: Events within the 90-day window are accepted however late; a write failure is retried through redelivery, never dropped (AS-26, AS-30).
- **FR-021**: A poison message is dead-lettered without blocking the partition (AS-29).
- **FR-022**: Zero-token LLM calls record nothing; the metric is the one named in the event and must pass FR-018 (AS-27).

**Usage lines, settlement and adjustments (P0614)**

- **FR-023**: `linesFor` is read-only, answers within 5 s or rejects `usage_unavailable`, and rejects invalid input (AS-44, AS-45).
- **FR-024**: For each metric with included usage in the subscription's price it computes the period's exact de-duplicated total and the overage `blocks = ceil(max(0, used − included) / 1000)`, `amountMinor = blocks × overagePer1000Minor`, using integer arithmetic and rejecting results above the safe integer range (AS-32 to AS-34).
- **FR-025**: The usage store is queried exactly (duplicates collapsed) so totals do not depend on background merges (AS-23, AS-55).
- **FR-026**: A settlement ledger holds, per `(subscription, periodStart, metric)`: the period end, the settled quantity and amount, the allowance and rate snapshot taken at first settlement, the last invoice, a closed flag; settled values only move forward (AS-37, AS-42).
- **FR-027**: For every open ledger row of the subscription, `linesFor` computes the current exact total of that period; when it exceeds the settled quantity, it produces an `ADJUSTMENT` line for the increase in overage amount computed with the row's snapshot, with `quantity` = the increase in overage units and a description naming the original period; no line when the amount delta is `0`, and the plan still advances the quantity (AS-38 to AS-41).
- **FR-028**: `settle` runs in S17's invoice transaction, applies the plan with a conditional update bound to `fromQuantity` for each entry, is idempotent by invoice id, and rejects a stale plan with `settlement_conflict`; of two concurrent settlements of one row exactly one wins (AS-37, AS-43).
- **FR-029**: An issued invoice and its lines are never modified by this capability; corrections appear only as lines of a later invoice (AS-42).
- **FR-030**: A ledger row is closed when a measurement at or after `periodEnd + 91 days` has settled it; closed rows are never queried or adjusted again (AS-46).
- **FR-031**: The invariants `settledAmountMinor = price(settledQuantity)` under the row's snapshot and `settledQuantity <= exact total` are checked daily; violations are counted and logged and never auto-corrected (AS-47).
- **FR-032**: The migration creates ledger rows for invoices issued by the previous implementation within the last 90 days, repeatably, and is expand-only (AS-48).
- **FR-033**: Lines are deterministic: same inputs, same bytes, in the order of AS-35 (AS-35).

**Usage read**

- **FR-034**: `GET /shops/:shopId/usage` (`shop.read`) and `GET /me/usage` return the monthly summary with `used`, `limit`, `remaining` as in AS-49; `month` is `YYYY-MM` between 12 months ago and the current month (AS-49, AS-50).
- **FR-035**: Shop usage is scoped by the shop in the predicate and shop access is established first; foreign or unknown shops answer `404` with an identical body; buyer usage uses only the session's user id (AS-51, AS-52).
- **FR-036**: The routes are rate limited to 60 per minute per subject and fail closed (AS-53).
- **FR-037**: When usage cannot be read the routes answer `503 usage_unavailable` with a generic detail (AS-54).

**Cross-cutting**

- **FR-038**: Money is integer minor units everywhere (ledger, lines, DTOs); no floating point (AS-34).
- **FR-039**: The domain reads time only through the injected clock; all stored instants are UTC (AS-12, AS-25, AS-46).
- **FR-040**: Metrics: `usage_events_ingested_total{metric_class}`, `usage_events_rejected_total{reason}`, `usage_events_ignored_total{reason}`, `entitlement_checks_total{kind,outcome}`, `entitlement_invalidations_total{outcome}`, `entitlements_stale_served_total`, `entitlements_cache_errors_total`, `usage_settlement_conflicts_total`, `usage_ledger_drift` (gauge); logs are structured with request or job ids and contain no payment data (AS-57).
- **FR-041**: Errors are RFC 9457 problem+json with a stable `code`; 5xx details are generic (AS-09, AS-11, AS-54).
- **FR-042**: The domain complies with IX.4 (0 cross-domain accesses), I.2 layering and X.4 entry points, and registers each new table in the ownership registry (AS-56).
- **FR-043**: On shutdown consumers stop taking messages, finish the current batch, then exit; unacknowledged messages are redelivered (AS-30).

### Key Entities

- **Entitlements**: `{freeShipping?, earlyAccessDrops?, maxProducts?, seats?, auctions?, apiCallsPerMonth?, assistantTokensPerMonth?}`; derived, never stored as truth.
- **Cached entitlement entry**: `{entitlements, subscriptionId | null, subscriptionVersion | null, loadedAt}` (`null` = free tier) keyed by `(subjectType, subjectId)`.
- **Usage event** (store row): `{eventIdentity, subjectId, metric, quantity, ts, ingestedAt}`; append-only, de-duplicated by identity.
- **Settlement ledger row**: `{subscriptionId, periodStart, periodEnd, metric, settledQuantity, settledAmountMinor, includedQuantity, overagePer1000Minor, lastInvoiceId, closed, createdAt, updatedAt}`; unique `(subscriptionId, periodStart, metric)`; fields only move forward.
- **Settlement plan**: `{entries: [{metric, periodStart, periodEnd, fromQuantity, toQuantity, includedQuantity, overagePer1000Minor}]}`; produced by `linesFor`, consumed by `settle`.
- **Usage summary**: `{month, periodStart, periodEnd, asOf, metrics: [{metric, used, limit | null, remaining | null}]}`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Across 10,000 simulated events with random duplicates, replays, reordering and consumer crashes, every subject's total equals the number of distinct events, exactly (0 lost, 0 double counted).
- **SC-002**: Across 1,000 generated invoice sequences with late events arriving at random times and two concurrent renewals, for every `(subscription, period, metric)` the sum of `USAGE` and `ADJUSTMENT` amounts equals the price of the final exact total, to the minor unit, and no unit is billed in two invoices (property-tested).
- **SC-003**: 100% of issued invoices and their lines are byte-for-byte unchanged after any later adjustment.
- **SC-004**: A usage event is visible to the usage read within 30 seconds of being published in 99% of cases.
- **SC-005**: After a subscription change commits, a feature check reflects it within 5 seconds in 100% of cases and never returns a state older than one already observed for that subject by the same process.
- **SC-006**: A cached feature check adds no perceptible delay: 99% of checks complete in under 20 ms; with the cache and the subscription source both down, 100% of checks without a usable stale answer fail closed (none returns "allowed").
- **SC-007**: In a matrix over every usage route, 100% of cross-tenant attempts answer "not found" with an identical body and read nothing.
- **SC-008**: Reconciliation reports `usage_ledger_drift = 0` outside an incident, and 100% of injected corruptions are detected within one daily run.
- **SC-009**: The domain has 0 cross-domain table accesses in the ownership check and its migration applies to a populated database without blocking writes longer than the configured lock timeout.

## Assumptions

Each default is also a line in `questions.md`.

- **Event-sourced intake (R3)**: other domains report usage only by publishing events; billing's direct "record usage" function is removed. The usage store (analytical) and the settlement ledger are billing's own.
- **Late window**: 90 days (events older than that at ingestion are dead-lettered `too_old`); a period is final 91 days after its end. A replay of a dead letter after the window cannot be billed.
- **Pricing of adjustments**: overage blocks of 1,000 units with the allowance and rate snapshot of the period's first settlement; no negative adjustments (usage is append-only, reversals are out of scope).
- **Cancelled subscriptions**: the last period's usage is not invoiced because S17 issues no invoice on cancellation; it stays unbilled in this release. A later change may add a final invoice.
- **Free tier has quotas, not overage billing**: usage above a free quota is a decision for the calling domain (via `checkQuota`).
- **Quota window** is the UTC calendar month, independent of billing periods; billing periods drive invoices, the calendar month drives `apiCallsPerMonth` and `assistantTokensPerMonth`.
- **Stale entitlements** are served up to 60 minutes when the source fails (a degraded but bounded answer); after that, deny.
- **Plans are never named**: callers ask for features and limits; plan codes never leave this capability.
- **Single currency** `EUR`; a metric's price is part of the S17 price (`includedUsage`, `overagePer1000Minor`).

## Cross-capability contracts

Specs already written that mention S18: **S17** (the lines provider, `EntitlementsService.get/invalidate`, consumption of `billing.subscription_status_changed`, `SubscriptionBasisService`, free-tier ownership, entitlement keys), **S05** (an R1 limit check `ProductCommandService.create` may call; not enforced there now), **S07** (plan limits do not gate imports in this release; nothing required), **S04** (LLM usage is reported through S46's metering path; nothing required of S18 directly).

**Provides** (exported from the domain entry point `@app/domains/billing`; DTO and type names exact):

- **R1, `EntitlementsService`**:
  - `get(subjectType: 'USER' | 'SHOP', subjectId: string): Promise<Entitlements>`; never rejects for "no subscription" (free tier); rejects `entitlements_unavailable`.
  - `getMany(subjectType, subjectIds: string[]): Promise<Map<string, Entitlements>>` (≤ 500 distinct; `too_many_ids`).
  - `hasEntitlement(subjectType, subjectId, feature: EntitlementKey): Promise<boolean>` (unknown key rejects `unknown_entitlement`). The domain map names `hasEntitlement(subjectId, feature)`; this adds `subjectType` (see `questions.md`).
  - `checkLimit(subjectType, subjectId, key: 'maxProducts' | 'seats', current: number): Promise<{allowed: boolean, limit: number, remaining: number}>`.
  - `checkQuota(subjectType, subjectId, key: 'apiCallsPerMonth' | 'assistantTokensPerMonth'): Promise<{allowed: boolean, used: number, limit: number, resetsAt: string}>` (rejects `usage_unavailable`).
  - `invalidate(subjectType, subjectId): Promise<void>` (rejects when it cannot drop the entry).
  - Types `Entitlements`, `EntitlementKey`. Consumers: **S17** (`get`, `invalidate`), the auctions capability (guard), the assistant capability (`get('USER', id).assistantTokensPerMonth`), **S05** (`checkLimit('SHOP', shopId, 'maxProducts', count)`), developer-platform (`checkQuota` for `apiCallsPerMonth`), shop-functions and assistant quota (`hasEntitlement`).
- **Route guard**: `RequiresShopEntitlement(feature: EntitlementKey)` placed above `ShopScoped(...)`; denies with `403 entitlement_required {feature}`.
- **Same domain, for S17's renewal** (not exported outside billing):
  - `UsageInvoiceLinesProvider.linesFor({subscriptionId, subjectId, priceId, periodStart, periodEnd, measuredAt}): Promise<{lines: {kind: 'USAGE' | 'ADJUSTMENT', description: string, quantity: number, amountMinor: number}[], settlement: SettlementPlan}>`; read-only, ≤ 5 s, rejects `usage_unavailable` / `invalid_input`. This is S17's contract plus the `settlement` field (additive).
  - `UsageSettlementService.settle({invoiceId, subscriptionId, settlement}): Promise<void>`; called inside the invoice-creating transaction; idempotent by `invoiceId`; rejects `settlement_conflict`.
- **HTTP** (problem+json; bodies parse with the contracts schema named): `GET /shops/:shopId/usage?month=YYYY-MM` (`shop.read`) and `GET /me/usage` → `usageSummarySchema`.
- **Jobs (S49)**: `billing.usage-reconcile` (daily, `15 3 * * *` UTC, single-run, idempotent).
- **Rate-limit policy (S50 registry)**: `billing.usage-read.subject` 60/min, fail closed.
- **Events emitted**: none.
- **Consumers it hosts (S53 inbox, schema validation, DLQ)**: `usage.recorded`, `llm.call_completed`, `billing.subscription_status_changed`.

**Requires**:

- **S17** (same domain): `SubscriptionBasisService.getLiveBasis(subjectType, subjectId): Promise<{subscriptionId, status, planCode, entitlements, subscriptionVersion} | null>` and `getLiveBasisBySubjectIds(subjectType, ids ≤ 500): Promise<Map<string, Basis>>` (committed state only); event `billing.subscription_status_changed` v1 `{subscriptionId, subjectType, subjectId, status, from, planCode, subscriptionVersion}`; the renewal calls `linesFor` before its transaction and `settle` inside it, passing the `settlement` unchanged, and stores `usageMeasuredAt = measuredAt` on the invoice; S17 calls `invalidate` after commit.
- **Developer-platform capability** (not yet specified): event `usage.recorded` v1 `{metric: string, quantity: integer ≥ 1, ts: ISO instant}`, envelope `eventId`, `aggregateId = subjectId` (shop or user), delivered at-least-once.
- **S46** (not yet specified): event `llm.call_completed` v1 (exists today with `userId`, `purpose`, token counts and `aggregateId = callId`) extended **additively** with `subjectId: string` (the billed user or shop) and `metric: string` and `billableTokens: integer ≥ 0`; envelope `eventId`; published through the outbox; replaces the direct metering call.
- **S03**: `ShopScoped(permission)` giving `shopId`, `404` for non-members; permission `shop.read`. **S01**: `Firewall`, `@User()` giving `{id}`.
- **S49**: single-run scheduled jobs. **S50**: the policy above. **S53**: consumer runtime with inbox, schema validation and DLQ. **S54**: problem+json filter with `code`, clock, config validation, metrics, graceful shutdown.
- **Infrastructure usage-store client**: exact (de-duplicating) queries with parameters and a timeout, and durable inserts that report failure.
