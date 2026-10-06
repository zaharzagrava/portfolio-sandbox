# Feature Specification: S17 — Subscriptions: Plans, Versioned Prices, Subscription State Machine, Billing Run, Proration, Dunning (domain `billing`)

**Feature Branch**: `S17-subscriptions` (spec directory `specs/domains/S17-subscriptions`)

**Created**: 2026-10-05

**Status**: Draft

**Input**: User description: "Plans, versioned prices, subscription state machine, billing run, proration, dunning (domain `billing`)". Sources: Interview-Prep `10-System-Design/07-commerce-and-transactions.md` design 24 (subscription billing: entities, state machine `TRIALING → ACTIVE → PAST_DUE → (ACTIVE | CANCELED | UNPAID)`, idempotent billing run, dunning on day 1/3/7, proration, anchors, out-of-order-safe events). The showcase section `docs/showcase/sections/SD-24-subscriptions-billing.md` named in the capability catalog is not present in this checkout; the design-24 note and the existing code were used instead. Pattern-map rows for S17: P0103 (money in integer minor units, explicit rounding), P0104 (UTC dates, month-end anchors), P0110 (discriminated unions and `assertNever` state machines), P1110 (largest-remainder allocation). Constitution v3.1.0 (III, IV, V, VII, VIII, IX, X).

## Scope

The marketplace sells two kinds of recurring products: **Marketplace Plus** (a buyer subscription) and **shop plans** (`starter`, `pro`, `enterprise` for a shop). A customer subscribes once, is charged automatically at the end of every period, can change plan or seat count in the middle of a period and pays or receives credit for exactly the part of the period affected, and, when a card fails, is chased on a fixed schedule before access is withdrawn. Nothing in this flow may ever charge a customer twice, skip a period, lose a credit, or let an edited price rewrite the past.

In scope:

- **Plans and versioned prices**: a public catalog; an operator API that creates plans and *new price versions*; a price is never edited in place (the store refuses it); retiring a price hides it from new customers while existing subscribers keep it.
- **Subscribe** for a shop (`billing.manage`) or a buyer: eligibility, trial taken from the price, payment-method reference, one live subscription per subject, first invoice and first charge request created atomically.
- **Subscription state machine**: `TRIALING`, `ACTIVE`, `PAST_DUE`, `UNPAID`, `CANCELED` with an explicit transition table, conditional-update transitions, a history row for each, and events.
- **Billing run**: a scheduled, single-run, idempotent job that finds subscriptions whose period ended, creates the renewal invoice exactly once per (subscription, period), advances the period with month-end anchors, converts finished trials, ends cancelled subscriptions, and isolates failures per subscription.
- **Charging and dunning**: one charge attempt at a time per invoice with a provider-side idempotency key per attempt, unknown outcomes settled by lookup (never re-sent as a new charge), retries on day 1, 3 and 7 after the first failure, then `UNPAID`; recovery by payment; one extra attempt when the customer changes the payment method.
- **Changes and proration**: preview and change of plan or seats mid-period, credit for the unused time of the old price and charge for the remaining time of the new one on UTC day boundaries, rounded once, previewed exactly as invoiced; net credits go to a credit balance applied to later renewals.
- **Cancel, resume, offboarding**: cancel at period end or immediately, resume before the end; reaction to a shop's offboarding and deletion.
- **Invoices and reads**: the subscription and its invoices for the owning subject, keyset pagination, cross-tenant safe.
- **Events** other capabilities consume: status changes, plan tier changes (the contract S03 waits for), payment failures, payments.

Out of scope (owners named):

- Usage metering, overage lines, late-usage adjustments, entitlement checks, entitlement caching and `hasEntitlement` → **S18** (same domain). This capability only asks S18 for the usage lines of a renewal and tells S18's cache to forget a subject after a change.
- Card collection and 3-D Secure UI: card data never reaches the platform; the customer's browser tokenizes with the provider and sends a payment-method reference. Payment intents for orders, the order-bound charge command, order webhooks → **S13** / **S10**.
- Posting subscription revenue to the ledger → **S14** (not done in this version, see `questions.md`). Seller commission statements → **S16**.
- Shops, roles, the `billing.manage` permission → **S03**. Authentication and the admin role → **S01**. Jobs → **S49**, rate limiter → **S50**, outbox, inbox and consumers → **S53**, problem+json, idempotency facility, clock, config, metrics, shutdown → **S54**. Mails about failed payments and receipts → **S28**.
- Tax, VAT, invoice numbering for tax purposes, multi-currency (one currency, `EUR`), coupons and discounts, refunds, switching billing interval mid-period (takes effect only by cancelling and subscribing again), migrating subscribers to a successor price, editing a plan's entitlements in place, a billing screen (no web capability owns one; see `questions.md`).

Cross-domain data used (IX.7): shop access by **R1** (`ShopScoped`, S03); shop sandbox flag by **R1** (`ShopQueryService.getShopsByIds`, S03); usage lines for a renewal by an exported service of the same domain (S18); shop lifecycle by **R3-style event reactions** (`tenancy.shop_offboarding_started`, `…_cancelled`, `…_deleted`, S03, consumed with an inbox). **R2 is not used.** Plans, prices, subscriptions, invoices, lines, histories and plan-tier state are this domain's own data. This domain never reads another domain's tables, and no other domain reads these tables.

## User Scenarios & Testing *(mandatory)*

Notation: money is integer minor units (`1900` = 19.00 EUR) in `…Minor` fields; currency `EUR`. "At `T`" means the injected clock reads `T`. All instants and period boundaries are UTC; a "UTC day boundary" is `00:00:00Z`. The default clock for examples is `2026-04-10T12:00:00Z`.

**Dataset DS-1** (used throughout). Catalog seeded by the migration: plan `plus` (BUYER) with prices monthly `499` and yearly `4990`; plan `starter` (SHOP) monthly `1900` per seat including `api.calls` 10,000 with overage `50` per 1,000; plan `pro` (SHOP) monthly `9900` per seat including 1,000,000 `api.calls`, overage `20` per 1,000. Fixture prices created through the operator API where a scenario names them: `T14` (= `starter` monthly `1900` per seat, `trialDays 14`), `F1000` (flat `1000` monthly) and `F2000` (flat `2000` monthly). Shop `a` has owner Ann (`billing.manage`) and viewer Vic (no `billing.manage`); shop `b` has owner Bo; user `u` is a buyer. The payment provider double answers by payment-method reference: `pm_ok` succeeds; `pm_declined` declines definitely (`card_declined`); `pm_auth` needs customer authentication; `pm_timeout` never answers; `pm_late` never answers but holds a succeeded charge for our reference. **Fixture subscription FS**: shop `a`, `starter`, quantity 1, `ACTIVE`, period `2026-04-01T00:00:00Z → 2026-05-01T00:00:00Z` (30 days), paid with `pm_ok`, version 0.

### User Story 1 — Plans are a catalog and a price is never edited (Priority: P1)

Customers see what they can buy and what it costs. Operators change a price by publishing a new version; people who already subscribed keep what they agreed to until they leave.

**Why this priority**: every invoice depends on a price. A price that can be edited in place makes every past and future invoice unprovable (note 10/07 design 24: "versioned; never edit a price in place").

**Independent Test**: read the catalog; create a plan and price versions as an operator; try to edit and over-limit; read the persisted rows.

**Acceptance Scenarios**:

1. **AS-01** (catalog read) — **Given** DS-1 plus price `T14` and a retired price `X`, **When** anyone calls `GET /plans` without credentials, **Then** `200` with `Cache-Control: public, s-maxage=300` and `{plans: [{code, name, audience, entitlements, prices: [{id, version, interval, unitAmountMinor, currency, perSeat, trialDays, includedUsage, overagePer1000Minor}]}]}` (parses with the contracts schema `planCatalogSchema`), containing only active prices, ordered by plan `code` then `interval` then `unitAmountMinor` then `id`; `X` and every internal field are absent.
2. **AS-02** (create a plan) — **Given** an admin, **When** they `POST /admin/billing/plans {code: "enterprise", name: "Enterprise", audience: "SHOP", entitlements: {maxProducts: 100000, seats: 250, auctions: true, apiCallsPerMonth: 10000000, assistantTokensPerMonth: 20000000}}`, **Then** `201` with the plan; **When** the same `code` is posted again, **Then** `409 plan_code_taken` and nothing changes; **When** `audience` is `SHOP` and `code` is not one of `starter`, `pro`, `enterprise`, or `code` does not match `^[a-z][a-z0-9-]{1,31}$`, or `entitlements` contains an unknown key or a negative number, or the body has an unknown field, **Then** `400 validation_failed` and nothing is written.
3. **AS-03** (publish a new price version) — **Given** plan `starter` with its seeded monthly price at version 1, **When** an admin `POST /admin/billing/plans/{starterId}/prices {interval: "MONTH", unitAmountMinor: 2400, perSeat: true, trialDays: 0, includedUsage: {"api.calls": 10000}, overagePer1000Minor: {"api.calls": 60}}`, **Then** `201` with a **new** price `{id, version: 2, active: true, …}`; the seeded price row is byte-for-byte unchanged and still active; both appear in `GET /plans`.
4. **AS-04** (existing subscribers keep their price) — **Given** FS on the seeded `starter` price (1900) and an admin who publishes price version 2 (2400) and retires version 1, **When** the renewal at `2026-05-01T00:00:00Z` runs, **Then** the renewal invoice charges `1900` (the subscriber's own price); **When** a new customer subscribes to the retired price, **Then** `404 price_not_found` and nothing is created.
5. **AS-05** (the store refuses to edit a price) — **Given** any price, **When** a privileged statement changes its `unitAmount`, `interval`, `currency`, `perSeat`, `trialDays`, `includedUsage`, `overagePer1000`, `planId` or `version`, or sets `active` from `false` back to `true`, **Then** the store rejects it with an error and the row is unchanged; **When** the statement only sets `active` from `true` to `false`, **Then** it is accepted. No application check is involved.
6. **AS-06** (price validation) — **When** an admin posts a price with `interval` other than `MONTH` or `YEAR`; `unitAmountMinor` of `-1`, `100000001`, `19.5` or `"1900"`; `currency` other than `EUR`; `trialDays` of `-1`, `91` or `1.5`; negative or non-integer `includedUsage` or `overagePer1000Minor` values; or an unknown field, **Then** `400 validation_failed` and nothing is written; **When** the plan does not exist, **Then** `404 plan_not_found`.
7. **AS-07** (retire a price) — **Given** an active price, **When** an admin `POST /admin/billing/prices/{id}/retire`, **Then** `200 {id, active: false}`, the price leaves `GET /plans`, and subscribers are untouched; **When** it is retired again, **Then** `409 price_already_retired` and nothing changes.
8. **AS-08** (who may write the catalog) — **When** there are no credentials, **Then** `401`; **When** a shop owner or a buyer calls any `POST /admin/billing/…`, **Then** `403 permission_denied` and nothing changes; **When** an admin does, **Then** the success status of AS-02, AS-03, AS-07.

### User Story 2 — A customer subscribes, safely and once (Priority: P1)

A shop owner picks `pro` for three seats, or a buyer picks Plus. They get a subscription and a first invoice, and the first charge is requested without ever running a card charge inside the request's transaction.

**Why this priority**: it is the entry to every recurring charge; mistakes here double-charge or leave subscriptions without an invoice.

**Independent Test**: subscribe through the HTTP API with the provider double and read subscriptions, invoices, jobs and outbox rows.

**Acceptance Scenarios**:

1. **AS-09** (a shop subscribes) — **Given** shop `a` with no subscription and the clock at `2026-04-10T12:00:00Z`, **When** Ann `POST /shops/a/subscription` with `Idempotency-Key: k1` and `{priceId: pro, quantity: 3, paymentMethodRef: "pm_ok"}`, **Then** `201` with `{id, status: "ACTIVE", plan: {code: "pro", name: "Pro"}, priceId, interval: "MONTH", unitAmountMinor: 9900, currency: "EUR", perSeat: true, quantity: 3, currentPeriodStart: "2026-04-10T12:00:00Z", currentPeriodEnd: "2026-05-10T12:00:00Z", trialEndsAt: null, cancelAtPeriodEnd: false, hasPaymentMethod: true, creditBalanceMinor: 0, version: 0, latestInvoice: {id, kind: "RENEWAL", status: "OPEN", totalMinor: 29700, lines: [{kind: "PLAN", description: "Pro", quantity: 3, amountMinor: 29700}]}}` (parses with `subscriptionSchema`; no `paymentMethodRef` anywhere); persisted: one subscription with `billingAnchorDay 10`, one history row `null → ACTIVE (subscribed)`, one invoice with its line, one charge request for that invoice, outbox rows `billing.subscription_status_changed` and `billing.subscription_plan_changed {shopId: a, plan: "PRO", version: 1}`; the provider double has 0 calls (the charge happens later, after commit).
2. **AS-10** (a buyer subscribes) — **Given** user `u`, **When** `POST /me/subscription` with a key and `{priceId: plus-monthly, paymentMethodRef: "pm_ok"}`, **Then** `201` `ACTIVE`, one invoice `499`, `billing.subscription_status_changed` in the outbox and **no** `billing.subscription_plan_changed` (shops only); a second `POST /me/subscription` for `u` answers per AS-16.
3. **AS-11** (trial) — **Given** price `T14` and the clock at `2026-04-10T12:00:00Z`, **When** Ann subscribes with `quantity: 2` and `pm_ok`, **Then** `201` `TRIALING`, `trialEndsAt: "2026-04-24T12:00:00Z"`, `currentPeriodEnd` equal to it, `billingAnchorDay 24` (the day the first paid period starts), `latestInvoice: null`, no charge request, and a `billing.subscription_plan_changed {plan: "STARTER", version: 1}`; **When** no `paymentMethodRef` is given for a trial, **Then** `422 payment_method_required` and nothing is created.
4. **AS-12** (a trial is taken once per subject) — **Given** shop `a` once had a subscription (any plan, any status, now `CANCELED`), **When** it subscribes to `T14`, **Then** `422 trial_not_available` and nothing is created; **When** it subscribes to a price without a trial, **Then** `201`.
5. **AS-13** (the client cannot pick a trial length) — **When** the body carries `trialDays`, **Then** `400 validation_failed` naming the field and nothing is created.
6. **AS-14** (a payment method is required when money is due) — **When** a subscribe of a price with `unitAmountMinor > 0` has no `paymentMethodRef`, **Then** `422 payment_method_required` and nothing is created; **Given** a price of `0` (operator-created), **When** no reference is given, **Then** `201` `ACTIVE`, the invoice total is `0`, its status is `PAID`, and no charge request exists.
7. **AS-15** (eligibility) — **When** shop `a` subscribes to `plus` (BUYER) or user `u` to `pro` (SHOP), **Then** `422 plan_not_available_for_subject`; **When** shop `a` is a sandbox shop (`isSandbox` from `ShopQueryService.getShopsByIds`), **Then** `422 sandbox_shop_not_billable`; **When** the price is unknown or retired, **Then** `404 price_not_found`; in every case nothing is created.
8. **AS-16** (one live subscription per subject, concurrent) — **Given** shop `a` without a subscription, **When** two subscribes (different keys, `starter` and `pro`) run at once (`Promise.all`, repeated 50 times), **Then** each run has exactly one `201` and one `409 already_subscribed`, exactly one live subscription, one invoice and one charge request; **When** the shop already has a subscription in `UNPAID`, **Then** a new subscribe is `409 already_subscribed` (the customer pays or cancels first).
9. **AS-17** (validation) — **When** `priceId` is not a UUID; `quantity` is `0`, `1001`, `1.5` or `"3"`; `paymentMethodRef` is empty, longer than 255 characters or does not match `^pm_[A-Za-z0-9_]+$`; the body has an unknown field, **Then** `400 validation_failed` and nothing is created; **When** `quantity` is not `1` for a price that is not per seat, **Then** `422 quantity_not_applicable`.
10. **AS-18** (credentials and tenancy) — **When** there are no credentials, **Then** `401` on every route of this story; **When** Ann calls the route of shop `b`, **Then** `404` with a body identical to the one for a shop that does not exist; **When** Vic (no `billing.manage`) calls it, **Then** `403 permission_denied`; nothing is created in any case.
11. **AS-19** (idempotency) — **Given** AS-09's request, **When** it is replayed with the same key and body, **Then** the stored `201` and body return with `Idempotency-Replayed: true` and one subscription exists; **When** the key is used while the first request is still running, **Then** `409 idempotency_in_flight`; **When** the key is reused with a different body, **Then** `422 idempotency_key_reuse`; **When** the header is missing, **Then** `422 idempotency_key_required`.
12. **AS-20** (rate limit) — **Given** shop `a` made 10 subscribe attempts within one hour, **When** it makes an 11th, **Then** `429` problem+json with `Retry-After` and nothing is created; **Given** the limiter's store is down, **Then** the request is refused (fail-closed, `503`) and nothing is created.

### User Story 3 — A subscription can only be in one status and move along legal arrows (Priority: P1)

Support, finance and other capabilities rely on five statuses and a fixed set of moves between them. Every move is recorded, and a move that is not allowed is refused instead of silently applied.

**Why this priority**: entitlements, dunning and revenue all branch on the status; a hidden illegal state (a cancelled subscription that turns `PAST_DUE`) is a money bug.

**Independent Test**: drive each transition through its real trigger (HTTP, billing run, charge result, event) and read statuses, histories and the outbox.

Transition table (the only legal moves; self-loops are not transitions):

| From | Trigger | To |
|---|---|---|
| (none) | subscribe, price with trial | `TRIALING` |
| (none) | subscribe, no trial | `ACTIVE` |
| `TRIALING` | trial ended (billing run) | `ACTIVE` |
| `ACTIVE` | first failed charge of an invoice (attempt declined) | `PAST_DUE` |
| `PAST_DUE` | every invoice in dunning paid | `ACTIVE` |
| `PAST_DUE` | last scheduled attempt declined | `UNPAID` |
| `UNPAID` | outstanding invoice paid | `ACTIVE` |
| `TRIALING`, `ACTIVE`, `PAST_DUE`, `UNPAID` | period ended with cancellation scheduled | `CANCELED` |
| `TRIALING`, `ACTIVE`, `PAST_DUE`, `UNPAID` | cancelled immediately by the customer | `CANCELED` |
| `UNPAID` | 30 days in `UNPAID` | `CANCELED` |
| `TRIALING`, `ACTIVE`, `PAST_DUE`, `UNPAID` | shop deleted | `CANCELED` |

**Acceptance Scenarios**:

1. **AS-21** (the table is complete and closed) — **Given** the five statuses and every trigger above, **When** each (status, trigger) pair is applied, **Then** the legal pairs produce exactly the `To` status and every other pair is rejected with an "illegal transition" result, never a silent change; the status type is a discriminated union and every `switch` over it ends in `assertNever` (a status added without handling fails the static layer).
2. **AS-22** (illegal moves at the API are `409`) — **Given** FS in `PAST_DUE`, **When** Ann `POST /shops/a/subscription/change {priceId: pro}`, **Then** `409 subscription_not_changeable` and nothing changes; **Given** FS with cancellation already scheduled, **When** Ann cancels at period end again, **Then** `409 already_scheduled_for_cancellation`; **Given** FS without cancellation scheduled, **When** Ann `POST …/resume`, **Then** `409 not_scheduled_for_cancellation`; **Given** FS `CANCELED`, **When** Ann cancels, changes, resumes or updates the payment method, **Then** `404 no_active_subscription`.
3. **AS-23** (every move leaves one history row, atomically) — **Given** any transition of AS-21, **Then** in the same transaction as the status update exactly one history row exists `{subscriptionId, from, to, reason, actor, at, version}` with `actor` one of `user:<id>`, `system:billing-run`, `system:dunning`, `event:<eventId>` and `version` equal to the subscription's new version; **When** the transaction fails midway, **Then** neither the status nor the history row nor the outbox row exists; **When** a privileged statement updates or deletes a history row, **Then** the store rejects it.
4. **AS-24** (transitions are conditional updates) — **Given** FS `ACTIVE` with an open invoice, **When** a failing charge result (`ACTIVE → PAST_DUE`) and an immediate cancel (`ACTIVE → CANCELED`) run at once (`Promise.all`, repeated 50 times), **Then** each run ends consistent: the history is a chain in which every `from` equals the previous `to`, versions increase by exactly 1, the final status is `CANCELED`, and a `PAST_DUE` row never follows a `CANCELED` row; each status event is emitted once per history row.
5. **AS-25** (`CANCELED` is terminal) — **Given** a `CANCELED` subscription with an invoice whose charge job runs later, **When** the job, the billing run and a duplicate event arrive, **Then** no status changes, no PSP call is made, no invoice is created and nothing is emitted.

### User Story 4 — The billing run renews every subscription exactly once (Priority: P1)

Every ten minutes the platform finds subscriptions whose period ended, bills the next period, and moves on, even when two machines run it at once or a run dies in the middle.

**Why this priority**: it is the revenue engine; a skipped period loses money and a duplicated one double-charges (note 10/07 design 24: "idempotent per subscription + period").

**Independent Test**: set periods in the past, run the job (twice, concurrently, with faults injected) and count invoices, periods and charge requests.

**Acceptance Scenarios**:

1. **AS-26** (renewal) — **Given** a `pro` subscription, quantity 3, `ACTIVE`, version 0, period `2026-04-10T12:00:00Z → 2026-05-10T12:00:00Z`, and S18 returning no usage lines, **When** the billing run executes at `2026-05-10T12:00:00Z`, **Then** the period becomes `2026-05-10T12:00:00Z → 2026-06-10T12:00:00Z`, version `1`, one `RENEWAL` invoice with business key `renewal:2026-05-10T12:00:00.000Z`, total `29700`, status `OPEN`, one line `PLAN`, one charge request created in the same transaction; `billing_renewals_total{outcome="invoiced"}` is `1`; no status event (the status did not change).
2. **AS-27** (the due boundary) — **Given** a subscription with `currentPeriodEnd = 2026-05-10T12:00:00.000Z`, **When** the run executes at `11:59:59.999`, **Then** nothing changes; **When** it executes at `12:00:00.000`, **Then** it is renewed (due means `currentPeriodEnd ≤ now`).
3. **AS-28** (concurrent runs) — **Given** AS-26's subscription, **When** two runs execute at once (`Promise.all`, repeated 50 times), **Then** each repetition ends with exactly one renewal invoice for that period, the period advanced once, version `1` and one charge request; the second run reports it as already renewed.
4. **AS-29** (the run is scheduled once) — **Given** the worker module boots twice (two replicas), **Then** exactly one schedule `billing.run` exists with cron `*/10 * * * *` in UTC, one run per schedule slot executes (S49 claiming), and a job lease of 600 s.
5. **AS-30** (month-end anchors, UTC) — **Given** a monthly subscription started at `2026-01-31T09:00:00Z` (anchor 31), **Then** its successive period ends are `2026-02-28T09:00:00Z`, `2026-03-31T09:00:00Z`, `2026-04-30T09:00:00Z`, `2026-05-31T09:00:00Z`; **Given** a yearly subscription started `2028-02-29T00:00:00Z` (anchor 29), **Then** the ends are `2029-02-28`, `2030-02-28`, `2031-02-28`, `2032-02-29` (all at `00:00:00Z`); the same start in a different server time zone gives the same instants.
6. **AS-31** (a trial ends) — **Given** shop `a` `TRIALING` on `T14`, quantity 2, trial ending `2026-04-24T12:00:00Z`, **When** the run executes at that instant, **Then** the status becomes `ACTIVE` (history reason `trial_ended`, actor `system:billing-run`), the period `2026-04-24T12:00:00Z → 2026-05-24T12:00:00Z` (anchor 24), one `RENEWAL` invoice `3800` with one charge request, and `billing.subscription_status_changed {status: "ACTIVE", from: "TRIALING"}`; no plan tier event (tier unchanged).
7. **AS-32** (cancellation takes effect at the period end) — **Given** an `ACTIVE` shop subscription with `cancelAtPeriodEnd: true`, **When** the run executes at the period end, **Then** the status becomes `CANCELED` (reason `cancel_at_period_end`), `canceledAt` is set, no invoice and no charge request are created, `billing.subscription_status_changed` and, for a shop, `billing.subscription_plan_changed {plan: "STARTER", version: n+1}` are emitted; entitlements fall to the free tier (S18) after commit.
8. **AS-33** (delinquent subscriptions are not renewed) — **Given** a `PAST_DUE` and an `UNPAID` subscription whose period ended, **When** the run executes, **Then** no invoice is created and no period advances for either; **Given** the same with `cancelAtPeriodEnd: true`, **Then** both become `CANCELED`.
9. **AS-34** (unpaid for 30 days is cancelled) — **Given** a subscription that became `UNPAID` at `2026-04-17T12:00:10Z`, **When** the run executes at `2026-05-17T12:00:09Z`, **Then** nothing changes; **When** it executes at `2026-05-17T12:00:10Z`, **Then** it becomes `CANCELED` (reason `unpaid_expired`), its still-uncollected invoices stay `UNCOLLECTIBLE`.
10. **AS-35** (catch-up, one period per run) — **Given** a monthly subscription whose period ended three periods ago (the worker was down), **When** the run executes three times, **Then** three consecutive renewal invoices exist, one per period start, each exactly once, and the period end lands after `now`; a fourth run changes nothing.
11. **AS-36** (a degraded dependency defers, it does not fabricate) — **Given** S18's usage lines call times out (5 s) for subscription `s1` but works for `s2`, both due, **When** the run executes, **Then** `s1` is untouched (no invoice, no period change, no status change), `billing_renewal_deferred_total{reason="usage_unavailable"}` is `1`, `s2` is renewed, and the next run after S18 recovers renews `s1`.
12. **AS-37** (one bad subscription never blocks the others, a crash resumes) — **Given** 5 due subscriptions of which the third's price row is missing, **When** the run executes, **Then** the other four are renewed, the third is logged once with `subscriptionId` (no payment data) and counted in `billing_renewal_failed_total`; **Given** the process is killed after the second renewal commits, **When** the next run executes, **Then** the remaining are renewed and none twice.
13. **AS-38** (batches and fairness) — **Given** 1,200 due subscriptions, **When** the run executes three times, **Then** each run claims at most 500 (`FOR UPDATE SKIP LOCKED`), oldest `currentPeriodEnd` first then `id`, every subscription is renewed exactly once, and two overlapping runs never claim the same row.
14. **AS-39** (renewal is not editable and not lossy) — **Given** a renewal invoice, **When** a privileged statement changes its `total`, `periodStart`, `periodEnd`, `kind`, business key, or any line (`kind`, `description`, `quantity`, `amountMinor`), or deletes a line, **Then** the store rejects it; only `status` (along the invoice transitions), attempt fields and `paidAt` may change.

### User Story 5 — Charging is exactly-once per attempt and dunning follows the schedule (Priority: P1)

An open invoice is charged. A decline starts a countdown: retry one day, three days and seven days after the first failure, then access is withdrawn. A silent provider never causes a second charge.

**Why this priority**: recurring money; note design 24: "retries on day 1/3/7 with emails → eventually cancels or downgrades".

**Independent Test**: run the charge job with the provider double (success, decline, authentication, silence), advance the clock, and read invoices, subscriptions, jobs, outbox and double calls.

**Acceptance Scenarios**:

1. **AS-40** (a successful charge) — **Given** an `OPEN` invoice `29700` (version of AS-09) and `pm_ok`, **When** its charge job runs, **Then** the provider double receives exactly one create call `{amountMinor: 29700, currency: "EUR", idempotencyKey: "<invoiceId>:1", metadata: {kind: "subscription_invoice", invoiceId, subscriptionId, attempt: 1}}` made with a timeout of 8 s and while **no** database transaction is open; the invoice becomes `PAID` (`paidAt` set, `attempts 1`), one invoice history row, one `billing.invoice_paid {invoiceId, subscriptionId, subjectType, subjectId, kind, totalMinor, currency, periodStart, periodEnd, paidAt}`; the subscription stays `ACTIVE`.
2. **AS-41** (a decline starts dunning) — **Given** an `OPEN` invoice and `pm_declined`, with the first attempt at `T0 = 2026-04-10T12:00:10Z`, **When** the charge job runs, **Then** the invoice stays `OPEN` with `attempts 1`, `firstFailedAt = T0`, `nextAttemptAt = 2026-04-11T12:00:10Z`; the subscription moves `ACTIVE → PAST_DUE` (actor `system:dunning`); `billing.invoice_payment_failed {invoiceId, subscriptionId, subjectType, subjectId, attempt: 1, nextAttemptAt: "2026-04-11T12:00:10Z", reason: "card_declined", totalMinor, currency}` and `billing.subscription_status_changed {status: "PAST_DUE", from: "ACTIVE"}` are in the outbox; the next charge job is scheduled at `nextAttemptAt` with idempotency key `invoice-charge:<invoiceId>:2`; entitlements stay as the plan's (grace, S18); the shop's plan tier does not change.
3. **AS-42** (the full dunning path) — **Given** AS-41 and a provider that declines every time, with attempt 2 executed 30 s late (`2026-04-11T12:00:40Z`), **Then** attempt 2's decline schedules attempt 3 at `2026-04-13T12:00:10Z` (`T0 + 3 days`, not 3 days after the late run), attempt 3's decline schedules attempt 4 at `2026-04-17T12:00:10Z` (`T0 + 7 days`), and attempt 4's decline at `2026-04-17T12:00:10Z` makes the invoice `UNCOLLECTIBLE` (`nextAttemptAt null`) and the subscription `PAST_DUE → UNPAID`, emits `billing.invoice_payment_failed {attempt: 4, nextAttemptAt: null}`, `billing.subscription_status_changed {status: "UNPAID"}` and, for a shop, `billing.subscription_plan_changed {plan: "STARTER", version: n+1}`; the provider received exactly 4 create calls with 4 distinct idempotency keys `<invoiceId>:1` … `:4`; a fifth delivery of the charge job makes no provider call.
4. **AS-43** (the schedule is a pure function) — **Given** `firstFailedAt` and attempt numbers 1, 2, 3, 4, **Then** `nextAttemptAt` is `firstFailedAt + 1 day`, `+ 3 days`, `+ 7 days` and `null`, regardless of when each attempt actually ran; the offsets are fixed (`[1, 3, 7]` days) and not configurable.
5. **AS-44** (a job that arrives early does nothing) — **Given** `nextAttemptAt` is in the future, **When** the charge job is delivered now, **Then** no provider call is made, `attempts` is unchanged and the job is re-scheduled for `nextAttemptAt`.
6. **AS-45** (duplicate and concurrent delivery) — **Given** an `OPEN` invoice due for attempt 1, **When** the same charge job is delivered twice at once (`Promise.all`, repeated 50 times), **Then** exactly one delivery claims the attempt, the provider double receives one create call, one result is applied, one event is emitted, and the other delivery returns without effect.
7. **AS-46** (paying while past due recovers) — **Given** FS `PAST_DUE` after attempt 1 and `pm_ok` now valid, **When** attempt 2 runs and succeeds, **Then** the invoice is `PAID`, the subscription `PAST_DUE → ACTIVE` (actor `system:dunning`), `billing.invoice_paid` and `billing.subscription_status_changed {status: "ACTIVE", from: "PAST_DUE"}` are emitted, and the already scheduled attempt jobs for that invoice do nothing.
8. **AS-47** (recovery waits for every invoice in dunning) — **Given** FS `PAST_DUE` with two failing invoices R (renewal) and P (proration), **When** R is paid, **Then** the subscription stays `PAST_DUE`; **When** P is then paid, **Then** it becomes `ACTIVE`.
9. **AS-48** (a silent provider: unknown outcome) — **Given** `pm_timeout`, **When** the charge job runs, **Then** the create call times out after 8 s; the invoice stays `OPEN`, the attempt stays claimed and marked unknown, the subscription is **not** moved to `PAST_DUE`, no `invoice_payment_failed` is emitted, the attempt number does not advance, the provider received 1 create call, and a resolution job is scheduled at `+30 s`.
10. **AS-49** (the lookup finds the charge) — **Given** AS-48 with `pm_late` (the provider holds a succeeded charge for key `<invoiceId>:1`), **When** the resolution runs, **Then** the lookup by our reference finds it and the result is applied through the same guarded step as AS-40 (invoice `PAID`, one `invoice_paid`), and the provider's create-call count is still 1; **Given** the lookup finds a failed charge, **Then** the decline path of AS-41 applies; **Given** it finds a charge awaiting customer authentication, **Then** the path of AS-52 applies.
11. **AS-50** (the lookup finds nothing: the 60-minute boundary) — **Given** an unknown attempt that began at `T0` and a lookup that finds nothing, **When** the resolution runs at `T0 + 59 min 59 s`, **Then** the attempt stays unknown and the next resolution is scheduled with exponential backoff and full jitter (cap 15 min); **When** it runs at `T0 + 60 min`, **Then** the attempt is a definite failure with reason `no_provider_record` and AS-41 applies, still 1 create call in total.
12. **AS-51** (the provider cannot be reached for the lookup) — **Given** an unknown attempt and a lookup that times out or answers `5xx`, **When** the resolution runs, **Then** the attempt stays unknown, nothing else changes, and the next resolution is scheduled; the invoice is never charged with a new key while the attempt is unknown.
13. **AS-52** (the card needs customer action) — **Given** `pm_auth`, **When** the charge job runs, **Then** it is a definite failure with reason `authentication_required`: the dunning path of AS-41 applies, `billing.invoice_payment_failed` carries that reason so S28 can ask the customer to update their payment method.
14. **AS-53** (no payment method) — **Given** an open invoice of a subscription whose payment-method reference is absent, **When** its charge job runs, **Then** the provider double has 0 calls, the attempt is a definite failure with reason `no_payment_method`, and AS-41 applies.
15. **AS-54** (nothing to collect is never charged) — **Given** an invoice whose total is `0` or negative, **Then** it is created `PAID`, no charge request is created, and no provider call is ever made for it.
16. **AS-55** (a new card gives one extra attempt now) — **Given** FS `PAST_DUE` with attempt 1 failed and attempt 2 due in 20 hours, **When** Ann `PUT /shops/a/subscription/payment-method {paymentMethodRef: "pm_ok"}`, **Then** `200` with the subscription (`hasPaymentMethod: true`); an immediate charge is attempted with key `<invoiceId>:manual:1` for the oldest invoice in dunning; it succeeds → the invoice `PAID` and the subscription `ACTIVE`; had it failed, nothing else would change (the numbered schedule and attempt count are untouched, the next numbered attempt is still due at its time).
17. **AS-56** (paying an unpaid subscription reactivates it) — **Given** FS `UNPAID` with its invoice `UNCOLLECTIBLE`, **When** Ann updates the payment method to `pm_ok`, **Then** the immediate attempt succeeds, the invoice goes `UNCOLLECTIBLE → PAID`, the subscription `UNPAID → ACTIVE`, and for a shop `billing.subscription_plan_changed` restores the tier; **Given** `ACTIVE` or `TRIALING` with no invoice owed, **Then** only the reference is stored and no charge is attempted.
18. **AS-57** (payment-method route: mandatory API cases) — **When** `paymentMethodRef` is missing, empty or does not match `^pm_[A-Za-z0-9_]+$`, or the body has an unknown field, **Then** `400 validation_failed`; **When** there are no credentials, **Then** `401`; **When** Ann calls shop `b`'s route, **Then** `404`; **When** Vic calls it, **Then** `403 permission_denied`; **When** the sixth update within an hour is made, **Then** `429` (card-testing defence) and the stored reference is unchanged; nothing changes in any refusal.
19. **AS-58** (a provider answer that cannot be classified) — **Given** the provider answers a charge with an unknown status string or an invalid body, **Then** the attempt is treated as unknown (AS-48), never as success and never as a decline, and the event is logged with the provider's request ID and no payment data.

### User Story 6 — Changing plan or seats charges exactly the part of the period affected (Priority: P1)

Mid-period, a shop moves from `starter` to `pro` or adds seats. It sees the cost first, then pays that cost and no more; a downgrade turns into credit that later renewals use up.

**Why this priority**: note design 24 deep dive "Proration: credit for unused time on the old price + charge for the remaining time on the new, on the same day boundary; rounding rules". Money must be exact and previews must equal invoices.

**Independent Test**: preview and change at fixed instants and compare lines, invoice, credit balance and later renewals; table-driven rounding in the unit layer.

All examples use FS (30-day period `2026-04-01 → 2026-05-01`) unless stated; the clock is `2026-04-16T00:00:00Z` (remaining 15 of 30 days).

**Acceptance Scenarios**:

1. **AS-59** (preview) — **When** Ann `POST /shops/a/subscription/preview {priceId: pro}`, **Then** `200 {lines: [{kind: "PRORATION_CREDIT", description: "Unused time on previous plan (15/30 days)", amountMinor: -950}, {kind: "PRORATION_CHARGE", description: "Remaining time on new plan (15/30 days)", amountMinor: 4950}], dueNowMinor: 4000, creditAppliedMinor: 0, effectiveAt: "2026-04-16T00:00:00Z"}` (parses with `changePreviewSchema`); no row is written, no job, no event.
2. **AS-60** (upgrade equals preview) — **When** Ann `POST …/change {priceId: pro}` with a key at the same instant, **Then** `200` with the same lines; the subscription's price is `pro`, version `1`; one `PRORATION` invoice with business key `proration:v1`, total `4000`, lines as previewed, `OPEN`, one charge request; `billing.subscription_plan_changed {plan: "PRO", version: n+1}`; the entitlement cache for the subject is invalidated after commit (not inside the transaction).
3. **AS-61** (downgrade becomes credit) — **Given** FS on `pro` (quantity 1, 9900), **When** Ann changes to `starter` at the same instant, **Then** lines `-4950` and `+950`, net `-4000`; the proration invoice has total `-4000` and is created `PAID`; `creditBalanceMinor` becomes `4000`; no charge request; **When** the renewal at `2026-05-01T00:00:00Z` runs, **Then** the renewal invoice has lines `PLAN 1900` and `CREDIT -1900` (credit applied up to the invoice's positive subtotal), total `0`, status `PAID`, no charge, and `creditBalanceMinor` is `2100`; the following renewal applies `1900` again and leaves `200`; the balance is never negative and never lost.
4. **AS-62** (seats) — **Given** FS on `pro` with quantity 3, **When** Ann changes `quantity` to `5`, **Then** lines `-14850` (`3 × 9900 × 15/30`) and `+24750` (`5 × 9900 × 15/30`), net `+9900`.
5. **AS-63** (the day boundary is a UTC date) — **Given** a subscription with period `2026-04-01T12:00:00Z → 2026-05-01T12:00:00Z`, **Then** total days are `30` (`date(end) − date(start)`), and the remaining days are `15` for any change from `2026-04-16T00:00:00Z` to `2026-04-16T23:59:59Z`, `14` from `2026-04-17T00:00:00Z`, and `0` at or after `2026-05-01T00:00:00Z`; when remaining days are `0` the change applies with no lines and no invoice.
6. **AS-64** (rounding: once, half away from zero, parts sum to the total) — **Given** period of 30 days with 10 days remaining and prices `F1000 → F2000`, **Then** the exact credit is `333.33…`, the exact charge `666.66…`, the exact net `333.33…` rounds to `333`, and the lines are `-333` and `+666` (total `333`, not `334`); **Given** 15 of 30 days with old `1` and new `2`, **Then** exact credit `0.5`, charge `1`, net `0.5` rounds half away from zero to `1`, lines: the zero-amount credit line is omitted and the charge is `1`; **Given** 31-day period, 7 remaining, `1900 → 9900`, **Then** `-429`, `+2235`, total `1806`; for any inputs the lines sum to the exact net rounded once, each line is the floor or ceiling of its exact value (the leftover unit goes to the line with the larger fractional remainder, ties to the credit line), and no floating-point arithmetic is involved.
7. **AS-65** (a change while trialing) — **Given** shop `a` `TRIALING` on `T14`, **When** it changes to `pro`, **Then** `200 {lines: []}`, no invoice, the price is `pro`, the trial end and period unchanged, version +1, one history row (reason `plan_changed`), and the plan tier event.
8. **AS-66** (changes that are refused) — **When** the new price is of another interval, **Then** `422 billing_interval_change_not_supported`; of another audience, `422 plan_not_available_for_subject`; the same price and quantity, `422 no_change_requested`; a retired or unknown price, `404 price_not_found`; `quantity` not `1` for a flat price, `422 quantity_not_applicable`; the subscription `PAST_DUE` or `UNPAID`, `409 subscription_not_changeable`; nothing changes in any case.
9. **AS-67** (concurrent changes) — **Given** FS, **When** two changes (different keys, to `pro` and to quantity 5) run at once (`Promise.all`, repeated 50 times), **Then** each run has exactly one `200` and one `409 subscription_changed_concurrently`, one proration invoice, version `1`, and the invoice equals the response of the winner.
10. **AS-68** (change versus renewal at the boundary) — **Given** FS due for renewal, **When** a change and the billing run execute at once at `2026-05-01T00:00:00Z` (`Promise.all`, repeated 50 times), **Then** each run ends with exactly one renewal invoice for the new period whose lines match the price the subscription had when it was created, and any proration invoice computed against the old period is either absent or consistent with it; the total charged equals a fresh recomputation from the final history; a change that lost the race answers `409 subscription_changed_concurrently`.
11. **AS-69** (change and preview: mandatory API cases) — **When** `priceId` is not a UUID, `quantity` is `0`, `1001`, `1.5`, or the body has an unknown field, **Then** `400 validation_failed`; **When** there are no credentials, **Then** `401`; **When** Ann targets shop `b`, **Then** `404`; **When** Vic calls, **Then** `403`; **When** `change` is replayed with the same key and body, **Then** the stored response returns with `Idempotency-Replayed: true` and one invoice exists; in flight → `409 idempotency_in_flight`; different body → `422 idempotency_key_reuse`; missing key → `422 idempotency_key_required` (preview needs no key); **When** the 31st change within an hour is attempted, **Then** `429`.
12. **AS-70** (a money split is exact) — **Given** any amount and a list of non-negative weights (at least one positive), **Then** its largest-remainder allocation returns parts that are integers, sum to the amount exactly, each within 1 minor unit of its exact share, with ties going to the earlier part; the proration rule of AS-64 is this rule applied to the credit and charge shares of the net.

### User Story 7 — Customers leave cleanly and shops that close stop being billed (Priority: P2)

A customer can cancel at the end of the period they paid for, cancel right now, or change their mind. When a shop is offboarded or deleted, billing stops with it, and its invoices remain.

**Why this priority**: it completes the lifecycle; a subscription that cannot be left or that bills a deleted shop is a trust and legal problem.

**Independent Test**: call the routes, deliver the tenancy events (duplicated, reordered, invalid) to the real consumer, and read subscriptions, invoices and the outbox.

**Acceptance Scenarios**:

1. **AS-71** (cancel at period end) — **When** Ann `POST /shops/a/subscription/cancel {}`, **Then** `200` with the subscription `cancelAtPeriodEnd: true`, status unchanged, access unchanged, one history row (reason `cancel_scheduled`, from = to), no invoice change; the billing run at the period end follows AS-32.
2. **AS-72** (cancel immediately) — **When** Ann `POST …/cancel {immediately: true}`, **Then** `200` `CANCELED` now (reason `cancelled_by_customer`), unpaid `OPEN` invoices become `UNCOLLECTIBLE` (history row each) and stay as records, no further attempt is made, pending charge jobs do nothing, the unused credit balance is kept and not refunded, `billing.subscription_status_changed` and, for a shop, `billing.subscription_plan_changed {plan: "STARTER"}` are emitted; a later subscribe is allowed.
3. **AS-73** (resume) — **Given** cancellation scheduled and the period not ended, **When** Ann `POST …/resume`, **Then** `200` with `cancelAtPeriodEnd: false` and one history row (`cancel_withdrawn`); the next run renews it.
4. **AS-74** (cancel and resume: mandatory API cases) — **When** the body has an unknown field or `immediately` is not a boolean, **Then** `400`; **When** there are no credentials, `401`; **When** Ann targets shop `b`, `404`; **When** Vic calls, `403`; the buyer routes `POST /me/subscription/cancel` and `…/resume` follow the same split; nothing changes in any refusal.
5. **AS-75** (offboarding stops billing) — **Given** shop `a` with a live subscription and `tenancy.shop_offboarding_started {shopId: a, purgeAt}` (envelope `eventId`, `occurredAt: t1`), **When** it is processed, **Then** the subscription has `cancelAtPeriodEnd: true` with `cancelReason: "shop_offboarding"` and one history row (actor `event:<eventId>`); processing it again changes nothing; **When** `tenancy.shop_offboarding_cancelled {shopId: a}` with `occurredAt` later than `t1` arrives, **Then** the flag is cleared (only because its reason is `shop_offboarding`); **When** the customer had scheduled the cancellation themselves, **Then** `offboarding_cancelled` leaves it; **When** an `offboarding_cancelled` with `occurredAt` earlier than the recorded `started` arrives, **Then** it is ignored.
6. **AS-76** (a deleted shop) — **Given** `tenancy.shop_deleted {shopId: a}`, **When** it is processed, **Then** a live subscription becomes `CANCELED` (reason `shop_deleted`), its stored payment-method reference is erased, its invoices, lines and histories remain unchanged; a duplicate or a shop with no subscription changes nothing.
7. **AS-77** (invalid and duplicate events) — **Given** each of these consumers, **When** the same message is delivered twice (once after the other, once at the same time), **Then** the effect is applied once (inbox on `eventId`); **When** a payload has a missing or non-UUID `shopId`, an unknown `type`, or a missing `eventId`, **Then** it is dead-lettered with no side effect and the next message is processed.

### User Story 8 — Customers read their subscription and invoices, and other capabilities learn what changed (Priority: P2)

A shop owner sees the plan, status, next charge date and invoice history; sees only their own. Other capabilities receive precise, versioned events.

**Why this priority**: trust and the integration points; S03, S18 and S28 depend on the event shapes.

**Independent Test**: read through the HTTP API as members and non-members; read the outbox rows.

**Acceptance Scenarios**:

1. **AS-78** (read the subscription) — **When** Ann or Vic (`shop.read`) `GET /shops/a/subscription`, **Then** `200 {subscription: <subscriptionSchema> | null, entitlements}` where `entitlements` is S18's answer for the subject (the free tier when no live subscription), `subscription` has no payment-method reference, `creditBalanceMinor` and `latestInvoice`; **When** user `u` `GET /me/subscription`, **Then** the same shape for the buyer; **When** there is none, **Then** `subscription: null`.
2. **AS-79** (invoice history, keyset pages, after cancellation) — **Given** a shop with 45 invoices across a cancelled and a live subscription, **When** Ann `GET /shops/a/invoices?limit=20&cursor=…`, **Then** pages of 20, 20 and 5 ordered by `createdAt` descending then `id` descending with `nextCursor: null` on the last (parses with `invoicePageSchema`, lines excluded from list items); `limit=101` → `400 validation_failed`; a tampered cursor → `400 invalid_cursor`; Vic → `403`; the buyer's `GET /me/invoices` behaves the same for the buyer's own invoices.
3. **AS-80** (invoice detail and cross-tenant access) — **When** Ann `GET /shops/a/invoices/{id}` for her invoice, **Then** `200` with lines `{kind, description, quantity, amountMinor}` and `status`, `attempts`, `nextAttemptAt`, `paidAt`; **When** she asks for an invoice of shop `b` through her shop's path, or an unknown ID, **Then** `404` with identical bodies; **When** user `u` asks `GET /me/invoices/{id}` for another buyer's invoice, **Then** `404`; the lookup puts the subject in the predicate, never loading by ID and checking afterwards.
4. **AS-81** (plan tier events are versioned per shop) — **Given** shop `a` subscribes to `pro`, later is cancelled, then subscribes to `pro` again, **Then** the outbox holds `billing.subscription_plan_changed` events `{shopId: a, plan: "PRO", version: 1}`, `{plan: "STARTER", version: 2}`, `{plan: "PRO", version: 3}`; no event when the effective tier does not change (`starter → starter`, `PAST_DUE` with the same plan, a price change within a plan); the counter belongs to the shop and never repeats or decreases across subscriptions, also under concurrent changes (versions are consecutive); all billing events are keyed by `subjectId`, carry `eventId`, `type`, `version`, `occurredAt`, `aggregateId`, and are written in the transaction of the change (outbox).

### User Story 9 — The domain is safe to run, move and keep (Priority: P3)

Operators can trust that the domain obeys the boundaries, leaks no card reference, upgrades without downtime and stops cleanly.

**Why this priority**: constitution IX, VIII and III.11; gates for merge.

**Acceptance Scenarios**:

1. **AS-82** (ownership and boundaries) — **Given** the domain's code and registry, **Then** `pnpm --dir packages/backend check:table-ownership --strict` reports 0 findings for `billing` (every query's tables ⊆ the domain's own tables, no model of another domain injected, no association across owners), the new tables (histories, plan-tier state) are in the ownership registry as `domain:billing`, the barrel exports no models, `apps/*` import only the module entry points, and `pnpm check:boundaries` is green for `billing`.
2. **AS-83** (no payment data in logs, responses, events) — **Given** a full lifecycle with `pm_ok`, `pm_declined` and `pm_timeout`, **Then** no log line, response body, outbox payload or metric label contains a payment-method reference or provider secret; every log line carries `requestId`/`traceId` and, where relevant, `subscriptionId` and `invoiceId`.
3. **AS-84** (expand-only migration on live data) — **Given** a database holding the previous schema with subscriptions, invoices and an open negative `PRORATION` invoice, **When** the migration runs (with a `lock_timeout`, as its own deploy step), **Then** it only adds columns, tables, constraints and triggers; every existing subscription gets `creditBalanceMinor` (open negative proration invoices converted into credit balance and closed), every invoice gets its business key (`renewal:<periodStart>` / `proration:<id>`), every price gets `version` and `trialDays 0`, the old reads still work during the rollout, and re-running it changes nothing.
4. **AS-85** (graceful shutdown) — **Given** the worker holds a billing run mid-batch and a charge job with a provider call in flight, **When** it receives the stop signal, **Then** it stops claiming new subscriptions, finishes the current subscription's transaction, lets the provider call finish within its 8 s limit and records the result, then exits; the unclaimed subscriptions are still due and are renewed by the next run exactly once; **When** it is killed before recording a provider answer, **Then** the attempt is unknown and resolved by AS-49.

### Edge Cases

Each is covered by the scenario named:

- Two subscribes at once: AS-16. Two changes at once: AS-67. Change at the renewal boundary: AS-68. Cancel versus failed charge: AS-24. Two runs at once: AS-28. Duplicate charge job: AS-45.
- Replay, in-flight and different-body idempotency: AS-19, AS-69. Rate limits: AS-20, AS-57, AS-69.
- Illegal transitions: AS-21, AS-22, AS-25, AS-66. Cross-tenant: AS-18, AS-57, AS-69, AS-74, AS-80.
- Provider timeout and unknown outcome: AS-48 to AS-51, AS-58, AS-85. Limits: price bounds AS-06, quantity AS-17, trial AS-12/AS-13, list page size AS-79.
- Out-of-order and duplicate events: AS-75, AS-77. Month-end and leap days: AS-30. UTC day boundaries and time zones: AS-63. Rounding: AS-64, AS-70.
- Crash mid-run: AS-37, AS-85. Dependency down: AS-20 (limiter), AS-36 (usage), AS-51 (provider lookup).

## Requirements *(mandatory)*

### Functional Requirements

**Plans and prices**

- **FR-001**: `GET /plans` is public and cacheable, lists plans with only their active prices, in a fixed deterministic order, with explicit fields and money in `…Minor` integers (AS-01).
- **FR-002**: An operator creates a plan with a unique `code`; a shop-audience plan's code is one of `starter`, `pro`, `enterprise`; entitlement keys come from a fixed allowlist with non-negative numbers (AS-02).
- **FR-003**: An operator publishes a price as a new version of a plan and interval; existing prices are never touched; bounds: `0 ≤ unitAmountMinor ≤ 100,000,000`, currency `EUR`, `0 ≤ trialDays ≤ 90`, interval `MONTH` or `YEAR` (AS-03, AS-06).
- **FR-004**: A price's commercial fields can never change; only `active` may change, and only from `true` to `false`. The store enforces it (AS-05).
- **FR-005**: Retiring a price hides it from new customers; subscribers keep it and are billed with it at every renewal (AS-04, AS-07).
- **FR-006**: Catalog writes require the admin role; everything else is refused with `401`/`403` (AS-08).

**Subscribe**

- **FR-007**: A shop subscribes through `POST /shops/:shopId/subscription` (permission `billing.manage`); a buyer through `POST /me/subscription`. Every subscribe requires `Idempotency-Key` (AS-09, AS-10, AS-19).
- **FR-008**: Eligibility is checked before anything is written: the price is active; its plan's audience matches the subject type; a shop is not a sandbox shop (via `ShopQueryService`, R1, called before the transaction); `quantity` is 1 to 1000 and exactly 1 for a flat price; a reference is present when a charge is due or a trial is requested (AS-14, AS-15, AS-17).
- **FR-009**: A trial's length comes only from the price; the request cannot set it; it is available once per subject over its whole history (AS-11, AS-12, AS-13).
- **FR-010**: At most one live (not `CANCELED`) subscription per subject, enforced by the store; a losing concurrent subscribe answers `409 already_subscribed` (AS-16).
- **FR-011**: The subscription, its history row, its first invoice and lines, the charge request and the outbox events are written in one transaction; the provider is never called and nothing is published inside it (AS-09).
- **FR-012**: The billing anchor day is the UTC day-of-month on which the first paid period starts (for a trial, the day the trial ends) (AS-09, AS-11, AS-30).
- **FR-013**: Responses are explicit DTOs validated by contract schemas; the payment-method reference is never returned (AS-09, AS-78).
- **FR-014**: Subscribe and change attempts are rate limited per subject and fail closed (AS-20, AS-69).

**State machine**

- **FR-015**: The statuses and the transition table of User Story 3 are the only legal moves; the status type is a discriminated union with exhaustive `switch` statements ending in `assertNever` (AS-21).
- **FR-016**: Every transition is a conditional update from the expected status asserting one affected row, with one history row, one version increment and its outbox event in the same transaction (AS-23, AS-24).
- **FR-017**: A request that implies an illegal transition is answered `409` with a stable code and changes nothing; a subscription that is not live answers `404 no_active_subscription` (AS-22).
- **FR-018**: `CANCELED` is terminal: no later trigger changes a cancelled subscription (AS-25).
- **FR-019**: `PAST_DUE → ACTIVE` and `UNPAID → ACTIVE` happen only when no invoice of the subscription remains owed (AS-46, AS-47, AS-56).
- **FR-020**: A shop's plan tier (`STARTER`, `PRO`, `ENTERPRISE`) is announced with `billing.subscription_plan_changed {shopId, plan, version}` only when the shop's effective tier changes. The effective tier is the live subscription's plan in `TRIALING`, `ACTIVE` and `PAST_DUE`, and `STARTER` otherwise. `version` is a per-shop counter that never repeats or decreases across subscriptions (AS-81).

**Billing run**

- **FR-021**: A scheduled job `billing.run` (cron `*/10 * * * *`, UTC) runs once per slot across replicas; its work is idempotent (AS-28, AS-29).
- **FR-022**: A subscription is due when its status is `TRIALING` or `ACTIVE` and `currentPeriodEnd ≤ now`; due rows are claimed oldest period end first, at most 500 per run, with row locks that skip locked rows; each subscription is renewed in its own transaction (AS-27, AS-38).
- **FR-023**: A renewal creates the next invoice and advances the period in one transaction guarded by the subscription's version; an invoice has a deterministic business key (`renewal:<periodStart>`, `proration:v<version>`) unique per subscription, so a repeated trigger finds the existing invoice and never creates a second (AS-26, AS-28).
- **FR-024**: A run advances a subscription by at most one period; repeated runs catch up one period at a time with one invoice per period (AS-35).
- **FR-025**: Period ends use calendar months or years in UTC with the stored anchor day clamped to the month's length and restored afterwards (AS-30).
- **FR-026**: A finished trial becomes `ACTIVE` with its first invoice; a subscription with cancellation scheduled becomes `CANCELED` at its period end without an invoice, including when `PAST_DUE` or `UNPAID`; `PAST_DUE` and `UNPAID` subscriptions are never renewed; `UNPAID` for 30 days becomes `CANCELED` (AS-31, AS-32, AS-33, AS-34).
- **FR-027**: Usage lines of a renewal come from S18's provider and are fetched before the transaction opens; when it fails or exceeds 5 s the subscription is deferred (no partial state), never invoiced without usage (AS-36).
- **FR-028**: A failure on one subscription is logged and counted and never stops the run; a crash leaves unprocessed subscriptions due (AS-37, AS-85).
- **FR-029**: An issued invoice and its lines are immutable; only `status`, attempt fields and `paidAt` change, and `status` only along the invoice transitions (AS-39).

**Charging and dunning**

- **FR-030**: Invoice statuses are `OPEN`, `PAID`, `VOID`, `UNCOLLECTIBLE`; transitions are conditional updates with a history row: `OPEN → PAID`, `OPEN → UNCOLLECTIBLE` (dunning exhausted, or the subscription was cancelled immediately, FR-044), `UNCOLLECTIBLE → PAID` (late payment). `VOID` is reserved for operator tooling that is out of scope; nothing in this capability produces it (AS-40, AS-42, AS-56, AS-72).
- **FR-031**: Each numbered attempt is claimed by one conditional update that increments `attempts` only for an `OPEN` invoice with no attempt in flight and whose `nextAttemptAt` has passed; the provider call happens after the claim and outside any transaction, with an 8 s timeout, the amount, currency `EUR`, metadata `{kind: "subscription_invoice", invoiceId, subscriptionId, attempt}` and the idempotency key `<invoiceId>:<attempt>` (AS-40, AS-45).
- **FR-032**: The provider answer is classified as `succeeded`, `declined` (definite, with reason), `authentication_required` (a definite failure), or `unknown` (timeout, connection error, `5xx`, unclassifiable); only `succeeded` pays and only definite answers count as failed attempts (AS-41, AS-48, AS-52, AS-58).
- **FR-033**: An unknown attempt keeps the invoice `OPEN`, the attempt number and the subscription unchanged and is resolved by looking the charge up by our reference at `+30 s` then with exponential backoff and full jitter (cap 15 min): succeeded → paid; failed → declined; awaiting customer → `authentication_required`; not found after 60 minutes → `no_provider_record`; provider unreachable → remains unknown. A charge is never sent again for an unknown attempt (AS-48 to AS-51).
- **FR-034**: Dunning attempts 2, 3 and 4 are due at `firstFailedAt + 1`, `+ 3` and `+ 7` days regardless of when the previous attempt ran; a declined attempt 4 makes the invoice `UNCOLLECTIBLE` and the subscription `UNPAID` (AS-42, AS-43).
- **FR-035**: The first definite failure moves an `ACTIVE` subscription to `PAST_DUE`; every definite failure emits `billing.invoice_payment_failed` with the attempt, next due time and reason (AS-41, AS-52, AS-53).
- **FR-036**: A charge job delivered early, twice, or for a finished invoice has no effect and no provider call (AS-44, AS-45, AS-25).
- **FR-037**: An invoice whose total is `0` or negative is created `PAID` and never charged; a missing payment method is a definite failure with reason `no_payment_method` and no provider call (AS-53, AS-54).
- **FR-038**: Updating the payment method stores the reference and, when the subscription is `PAST_DUE` or `UNPAID`, makes one immediate extra attempt (`<invoiceId>:manual:<k>`) on the oldest owed invoice that does not alter the numbered schedule; a success recovers per FR-019; the route is rate limited to 5 per hour per subject (AS-55, AS-56, AS-57).
- **FR-039**: A paid invoice emits `billing.invoice_paid`; all events are written through the outbox in the transaction of the change (AS-40, AS-81).

**Changes and proration**

- **FR-040**: Preview and change compute the same lines with the same function and clock; preview writes nothing (AS-59, AS-60).
- **FR-041**: Days are whole UTC calendar days: `total = date(periodEnd) − date(periodStart)`, `remaining = clamp(date(periodEnd) − date(changeAt), 0, total)`; the day of the change belongs to the new price. With `remaining = 0` or `total = 0` there are no lines and no invoice (AS-63).
- **FR-042**: The proration net is the exact rational `(new − old) × remaining / total` rounded once, half away from zero, using integer arithmetic only; the credit and charge lines are its largest-remainder split (each the floor or the ceiling of its exact value, summing to the net, ties to the credit line); zero lines are omitted (AS-64, AS-70).
- **FR-043**: A positive net creates a `PRORATION` invoice (charged); a negative net creates a closed `PRORATION` invoice and adds its absolute value to the subscription's credit balance in the same transaction; the balance is never negative (store constraint and conditional update) (AS-60, AS-61).
- **FR-044**: A renewal applies the credit balance up to the invoice's positive subtotal as a `CREDIT` line and reduces the balance by that amount in the same transaction; any remainder stays (AS-61). An immediate cancellation sets unpaid `OPEN` invoices to `UNCOLLECTIBLE` and keeps the balance (AS-72).
- **FR-045**: A change is a version-guarded update; of two concurrent changes exactly one wins and the other answers `409 subscription_changed_concurrently`; the proration invoice's business key is derived from the new version, so two changes never collide on one key (AS-67).
- **FR-046**: Changes are refused for another interval, another audience, no difference, an unavailable price, an invalid quantity, or a `PAST_DUE`/`UNPAID` subscription; a change in `TRIALING` swaps the price with no invoice (AS-65, AS-66).

**Cancel, resume, offboarding**

- **FR-047**: Cancel at period end sets a flag and keeps access; immediate cancellation moves to `CANCELED` now; resume clears the flag before the period ends (AS-71, AS-72, AS-73).
- **FR-048**: `tenancy.shop_offboarding_started` schedules cancellation at period end with reason `shop_offboarding`; `…_cancelled` clears only that reason and only when it is newer than the recorded `started`; `tenancy.shop_deleted` cancels immediately and erases the payment-method reference; invoices, lines and histories are never purged (AS-75, AS-76).
- **FR-049**: Every consumer deduplicates on `eventId` with an inbox, validates its payload with zod, and dead-letters invalid messages without effect (AS-77).

**Reads and events**

- **FR-050**: Subscription and invoice reads are scoped by the principal's subject in the predicate; a foreign or unknown ID answers `404` with an identical body; shop routes need `shop.read` (subscription) or `billing.manage` (invoices); buyer routes use the session's user (AS-18, AS-78, AS-80).
- **FR-051**: Invoice lists use keyset pagination (`createdAt` desc, `id` desc) with an opaque cursor, default limit 20, maximum 100, and include invoices of cancelled subscriptions of the subject (AS-79).
- **FR-052**: The events of this capability are `billing.subscription_status_changed`, `billing.subscription_plan_changed`, `billing.invoice_payment_failed`, `billing.invoice_paid` with the payloads of the contracts section; each is keyed by `subjectId` and carries the envelope fields (AS-81).

**Cross-cutting**

- **FR-053**: Money is integer minor units everywhere (storage, arithmetic, DTOs, events); no floating point (AS-64, AS-70).
- **FR-054**: The domain reads time only through the injected clock; all stored instants are UTC (AS-26, AS-27, AS-63).
- **FR-055**: Errors are RFC 9457 problem+json with a stable `code`; 5xx details are generic (AS-22, AS-66).
- **FR-056**: The domain complies with IX.4 (0 cross-domain accesses), I.2 layering and X.4 entry points, and registers each new table in the ownership registry (AS-82).
- **FR-057**: No payment-method reference, provider secret or card data appears in logs, responses, events or metric labels (AS-83).
- **FR-058**: The schema change is expand-only with a `lock_timeout` and migrates existing data without loss (AS-84).
- **FR-059**: On shutdown the worker stops claiming, finishes the current unit of work and the in-flight provider call, then exits; unfinished work remains due (AS-85).
- **FR-060**: Metrics: `billing_renewals_total{outcome}`, `billing_renewal_deferred_total{reason}`, `billing_renewal_failed_total`, `billing_charge_attempts_total{outcome}`, `billing_unknown_attempts` (gauge), `billing_dunning_exhausted_total`, `billing_overdue_subscriptions` (gauge: due for more than 30 minutes); logs are structured with request or job IDs (AS-26, AS-36, AS-37, AS-42).

### Key Entities

- **Plan**: `{id, code, name, audience: BUYER | SHOP, entitlements, createdAt}`; code unique; shop codes `starter | pro | enterprise`.
- **Price**: `{id, planId, version, interval, unitAmountMinor, currency, perSeat, trialDays, includedUsage, overagePer1000Minor, active, createdAt}`; immutable except `active: true → false`.
- **Subscription**: `{id, subjectType: USER | SHOP, subjectId, priceId, status, quantity, billingAnchorDay, currentPeriodStart, currentPeriodEnd, trialEndsAt, cancelAtPeriodEnd, cancelReason, canceledAt, statusSince, paymentMethodRef (never exposed), creditBalanceMinor, version}`; at most one live per subject.
- **Subscription transition (history)**: `{subscriptionId, from, to, reason, actor, at, version}`; append-only.
- **Invoice**: `{id, subscriptionId, kind: RENEWAL | PRORATION, businessKey, periodStart, periodEnd, status, totalMinor, currency, attempts, attemptStartedAt, attemptUnknown, manualAttempts, firstFailedAt, nextAttemptAt, usageMeasuredAt, paidAt, createdAt}`; unique `(subscriptionId, businessKey)`.
- **Invoice line**: `{id, invoiceId, kind: PLAN | USAGE | ADJUSTMENT | CREDIT | PRORATION_CREDIT | PRORATION_CHARGE, description, quantity, amountMinor}`; immutable.
- **Invoice transition (history)**: `{invoiceId, from, to, reason, at}`; append-only.
- **Subject plan state**: `{subjectType: SHOP, subjectId, tier, planVersion}`: the per-shop counter and current announced tier (FR-020).
- **Outbox rows** (technical table of the outbox lib, IX.6): the four events.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Across 10,000 simulated renewals with two concurrent runs, duplicated charge deliveries and random worker crashes, 0 subscriptions are billed twice for a period, 0 periods are skipped, and 0 invoices are charged more than once per attempt.
- **SC-002**: 99% of subscriptions are renewed and their first charge requested within 15 minutes of their period end; `billing_overdue_subscriptions` is 0 outside an incident.
- **SC-003**: For 100% of tested changes the invoiced amount equals the preview computed at the same instant, to the minor unit, and the lines sum to the single-rounded net (property-tested on at least 1,000 generated cases).
- **SC-004**: A card that declines is retried exactly on day 1, 3 and 7 after its first failure (to the second) in 100% of dunning runs, regardless of how late each attempt executed; a customer who then updates their payment method is back to `ACTIVE` within 1 minute of a successful charge.
- **SC-005**: When the payment provider is silent, 0 customers are charged twice and 100% of unknown attempts are settled within 60 minutes by lookup.
- **SC-006**: In a matrix over every subscription and invoice route, 100% of cross-tenant attempts answer "not found" with an identical body and change nothing.
- **SC-007**: A customer can subscribe, see their invoice, and cancel in under 2 minutes of interaction; the subscribe call answers in under 1 second at the 95th percentile because no provider call is made in it.
- **SC-008**: A catalog price edit in place is impossible: 100% of attempted edits fail; every invoice ever issued can be recomputed from its subscription history and price version.
- **SC-009**: 0 payment-method references appear in logs, responses or events in a full lifecycle test.
- **SC-010**: The domain has 0 cross-domain table accesses in the ownership check and its migration applies to a populated database without blocking writes for longer than the configured lock timeout.

## Assumptions

Each default is also a line in `questions.md`.

- **Build, not buy**: the platform is the subscription system of record; the payment provider is used only to charge a saved payment-method reference, so there are no provider subscription webhooks to receive. Entitlement changes are driven by this capability's own versioned events (S18 consumes them), which are the analogue of the note's provider-webhook bullet.
- **Charging path**: billing charges through its own domain port and an adapter over the shared provider client, not through a payments command, because payments' intents are bound to reserved orders (S13); invoice charges are tagged with metadata `kind: "subscription_invoice"` so order webhooks ignore them.
- **Payment-method reference**: a provider token produced in the customer's browser; ownership is enforced by the provider at charge time; the platform stores only the opaque reference.
- **Single currency**: `EUR`. The provider client must charge the invoice's currency (today it hard-codes another).
- **Trial**: set on the price; once per subject; requires a payment method; no invoice during the trial; the first charge happens at its end.
- **Grace period**: `PAST_DUE` keeps the plan's entitlements; `UNPAID` falls back to the free tier (S18). The first invoice of a new subscription follows the same dunning rules.
- **Credit**: a downgrade credit is applied only to later renewals of the same subscription, is not paid out, and is not refunded on cancellation.
- **Proration scope**: only price and quantity changes within the same interval; interval changes are refused; the preview is not a binding quote (the invoice uses the instant of the change).
- **Cancelled subscribers** may subscribe again later, with no trial.
- **Operator tools** beyond the catalog (manual invoice voiding, refunds, forced status changes) are not provided in this version.
- **Retention**: invoices, lines and histories are financial records and are never purged with a shop; only the stored payment-method reference is erased.
- **Revenue in the ledger**: not posted in this version.
- **Entitlement keys** (allowlist): `freeShipping`, `earlyAccessDrops`, `maxProducts`, `seats`, `auctions`, `apiCallsPerMonth`, `assistantTokensPerMonth`; S18 may extend it.

## Cross-capability contracts

Specs already written that mention this capability, and what they require: **S03** (event `billing.subscription_plan_changed`, permission `billing.manage`, `ShopQueryService` consumer, shop lifecycle events), **S13** (billing sends a charge command; see `questions.md`), **S14**/**S15**/**S16** (subscriptions and subscription invoices are S17's; nothing required of S17), **S01** (service caller `billing` in an internal-endpoint example; this capability declares no internal endpoint).

**Provides**:

- **HTTP** (all problem+json errors; every body parses with the named `packages/contracts` schema):
  - `GET /plans` (anonymous) → `planCatalogSchema`.
  - `GET /shops/:shopId/subscription` (`shop.read`) → `{subscription: subscriptionSchema | null, entitlements}`; `POST /shops/:shopId/subscription` (`billing.manage`, `Idempotency-Key`) `{priceId, quantity?, paymentMethodRef?}` → `201 subscriptionSchema`; `POST …/subscription/preview {priceId?, quantity?}` → `200 changePreviewSchema`; `POST …/subscription/change {priceId?, quantity?}` (key) → `200 {lines, subscription}`; `POST …/subscription/cancel {immediately?}` → `200 subscriptionSchema`; `POST …/subscription/resume` → `200`; `PUT …/subscription/payment-method {paymentMethodRef}` → `200`; `GET /shops/:shopId/invoices?limit&cursor` → `invoicePageSchema`; `GET /shops/:shopId/invoices/:invoiceId` → `invoiceSchema` (`billing.manage`).
  - Buyer: `GET|POST /me/subscription`, `POST /me/subscription/{preview,change,cancel,resume}`, `PUT /me/subscription/payment-method`, `GET /me/invoices`, `GET /me/invoices/:invoiceId` (same shapes, authenticated user).
  - Admin: `POST /admin/billing/plans`, `POST /admin/billing/plans/:planId/prices`, `POST /admin/billing/prices/:priceId/retire`.
- **Events** (outbox → topic of the `billing` aggregate, key `subjectId`, envelope `{eventId, type, version, occurredAt, aggregateId}`):
  - `billing.subscription_status_changed` v1 `{subscriptionId, subjectType: 'USER'|'SHOP', subjectId, status, from: string | null, planCode, subscriptionVersion}`. Consumers: **S18** (invalidate and rebuild the entitlement view; ignore a `subscriptionVersion` older than the stored one), **S28** (mails).
  - `billing.subscription_plan_changed` v1 `{shopId, plan: 'STARTER'|'PRO'|'ENTERPRISE', version}`; `version` is the per-shop counter (FR-020). Consumer: **S03** (as it requires). Shops only.
  - `billing.invoice_payment_failed` v1 `{invoiceId, subscriptionId, subjectType, subjectId, attempt, nextAttemptAt: string | null, reason: 'card_declined'|'authentication_required'|'no_payment_method'|'no_provider_record'|string, totalMinor, currency}`. Consumer: **S28** (dunning mails: attempt 1 to 4; `nextAttemptAt null` = access withdrawn).
  - `billing.invoice_paid` v1 `{invoiceId, subscriptionId, subjectType, subjectId, kind, totalMinor, currency, periodStart, periodEnd, paidAt}`. Consumers: **S28** (receipt); **S14** if finance later wants revenue postings.
- **Exported service (same domain, for S18)**: `SubscriptionBasisService` with `getLiveBasis(subjectType, subjectId): Promise<{subscriptionId, status, planCode, entitlements, subscriptionVersion} | null>` (statuses `TRIALING`, `ACTIVE`, `PAST_DUE` are "live for entitlements"; `UNPAID` and `CANCELED` return `null`) and a batch `getLiveBasisBySubjectIds(subjectType, ids ≤ 500): Promise<Map<string, Basis>>`; guarantee: reads the committed state only.
- **For J02 (seller-to-first-sale)**: after `POST /shops/:shopId/subscription` returns `201` and the charge job ran, `GET /shops/:shopId/subscription` shows `ACTIVE` and S18's entitlements for the plan within 5 seconds (cache invalidated after commit).
- **Rate-limit policies (S50 registry)**: `billing.subscribe.subject` 10/hour; `billing.change.subject` 30/hour; `billing.preview.subject` 60/min; `billing.payment-method.subject` 5/hour; `billing.plans.ip` 120/min (fail-open: public cached data); the rest fail closed.
- **Scheduled jobs (S49)**: `billing.run` (`*/10 * * * *`, UTC, lease 600 s); jobs `billing.charge-invoice {invoiceId}` (idempotency key `invoice-charge:<invoiceId>:<attempt>`) and `billing.resolve-attempt {invoiceId, attempt}`.
- **Consumers it hosts (S53 inbox, zod, DLQ)**: `tenancy.shop_offboarding_started`, `tenancy.shop_offboarding_cancelled`, `tenancy.shop_deleted`.

**Requires**:

- **S01**: `Firewall({anonymous?, roles?})` with role `ADMIN`; `@User()` giving `{id}`.
- **S03**: `ShopScoped(permission)` giving `shopId`, with `404` for non-members, `403` for missing permission, and the permissions `shop.read` and `billing.manage`; `ShopQueryService.getShopsByIds(ids ≤ 500)` returning `isSandbox` (R1); events `tenancy.shop_offboarding_started` v1 `{shopId, purgeAt}`, `tenancy.shop_offboarding_cancelled` v1 `{shopId}`, `tenancy.shop_deleted` v1 `{shopId}` with the envelope `eventId` and `occurredAt`; it consumes `billing.subscription_plan_changed`.
- **S18** (same domain): `UsageInvoiceLinesProvider.linesFor({subscriptionId, subjectId, priceId, periodStart, periodEnd, measuredAt}): Promise<{lines: {kind: 'USAGE'|'ADJUSTMENT', description, quantity, amountMinor}[]}>` (read-only, ≤ 5 s, throws on failure); `EntitlementsService.get(subjectType, subjectId)` and `EntitlementsService.invalidate(subjectType, subjectId)`.
- **S49**: single-run scheduled jobs, `enqueue` with `idempotencyKey` and `runAt` inside the caller's transaction, row-claiming. **S50**: the policies above. **S53**: `outbox.append(event)` in the domain's transaction, inbox, DLQ. **S54**: problem+json filter with `code`, idempotency facility (`Idempotency-Key` semantics of V.6), clock, config validation, metrics, graceful shutdown.
- **Infrastructure `stripe` lib**: charge with `{amountMinor, currency, paymentMethodRef, idempotencyKey, metadata, timeout}` classified into succeeded / declined / authentication required / unknown, and lookup by idempotency key; a test double at the provider's HTTP edge.
- **S10**: the order webhook acknowledges and ignores payment intents whose metadata `kind` is `subscription_invoice`.
