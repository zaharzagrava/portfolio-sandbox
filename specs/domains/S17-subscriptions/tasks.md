# Tasks: S17 — Subscriptions (domain `billing`)

**Input**: `specs/domains/S17-subscriptions/` — plan.md, spec.md, test-plan.md, gaps.md, questions.md (defaults accepted), research.md, data-model.md, contracts/{http,events,jobs}.md, quickstart.md. Constitution `.specify/memory/constitution.md`.

**Tests**: REQUESTED (test-plan.md, 85 scenarios). Order is test-first: for every test-plan row the failing test task comes before the code task that makes it pass.

**Conventions**
- `BILLING` = `packages/backend/libs/domains/billing`. Backend commands run from `packages/backend`. Specs run through `/opt/sdd/repo/scripts/sdd/test-spec.sh <path>` (condensed output; open the full log only if needed). Narrowest spec per task; whole suite once in the last phase. After 5 failed fixes of the same test: stop, write blocker/tried/hypothesis into `questions.md`.
- Transactions: `TransactionRunner.run` / `@Transactional` only; never add `sequelize.transaction` (billing count stays 0). Clock: `CLOCK` only (`check:no-wallclock`). No `git checkout/restore/reset/stash/clean`.
- Never create or edit `*.reviewed.json`. Never log or return `paymentMethodRef`.
- Gap ids (A1–A28, B, C, D) and AS ids are those of gaps.md and test-plan.md.

## Format: `- [X] T### [P?] [US?] Description with file path`

---

## Phase 1: Setup

- [X] T001 Create living page `docs/spec/capabilities/S17-subscriptions.md` (rule 0: rules and behaviors first, `[proof: …]` / `[code: …]` lines pointing at the eight e2e files and six unit specs, filled as each story lands); run `python3 scripts/livespec/check.py`. Do not touch any `*.reviewed.json`.
- [X] T002 [P] Create contracts folder `packages/contracts/src/billing/{index,catalog,subscription,invoice,preview,events}.ts` with zod schemas from `contracts/http.md` and `contracts/events.md` (`planCatalogSchema`, `subscriptionSchema` with `hasPaymentMethod` and no `paymentMethodRef`, `changePreviewSchema`, `invoiceSchema`, `invoicePageSchema`, `changeResultSchema`; event schemas for the four billing events; money fields end in `Minor`; request bodies `.strict()`, `paymentMethodRef` `^pm_[A-Za-z0-9_]+$` ≤ 255, `quantity` int 1–1000, `limit` 1–100 default 20); export from the package index (A1, A20; S28 follow-up: `reason`, `subjectType` `USER|SHOP`, `billing.invoice_paid`).
- [X] T003 [P] Create test fixtures `packages/backend/test/fixtures/billing/` (DS-1 prices, FS subscription builder, helpers for privileged statements used only by AS-05/23/39 and period aging) and the provider double at the Stripe HTTP edge in `packages/backend/test/fakes/` (`pm_ok`, `pm_declined`, `pm_auth`, `pm_timeout`, `pm_late`, lookup answers, unclassifiable body, call counts, spy asserting no DB transaction is open during a call), the scriptable `UsageInvoiceLinesProvider` fake, consumer delivery harness (real envelopes) and a limiter-store fault switch (A26, L-005, L-006: every test creates its own data).
- [X] T004 [P] Queues/topics in the test stack (L-002, L-011, L-020): define job queues `billing.run`, `billing.charge-invoice`, `billing.resolve-attempt`, `billing.manual-attempt` in `elasticmq.conf` (and reload command for unattended agents if the repo has one), topics for the four billing events and three `tenancy.*` topics consumed; confirm with the doctor/readiness check.
- [X] T005 Record the open-risk decisions in `research.md` addenda: (a) which per-step helper existing expand migrations use for batched data steps (keeps the S54 direct-site count unchanged), (b) provider search consistency (R-4) wording. Check `grep -rn "sequelize.transaction" BILLING` count baseline = 0.

---

## Phase 2: Foundational (blocks every story)

**Purpose**: store schema, pure domain, ports, module split. Nothing here is skipped by a story.

### Tests first (unit)

- [X] T006 [P] Unit spec `BILLING/domain/subscription-status.spec.ts` — AS-21: full status × trigger matrix with `it.each`, closed table, exhaustiveness (`assertNever`); must fail first.
- [X] T007 [P] Unit spec `BILLING/domain/periods.spec.ts` — AS-30: Jan 31 monthly, Feb 29 yearly, server time zone variants, UTC.
- [X] T008 [P] Unit spec `BILLING/domain/dunning-schedule.spec.ts` — AS-43: `firstFailedAt + 1/3/7` days to the second, late attempts, month ends.
- [X] T009 [P] Unit spec `BILLING/domain/proration.spec.ts` — AS-63 (UTC date boundary, time zones, zero remaining) and AS-64 (single rounding half away from zero, four worked cases, `fast-check` property `sum(lines) = round(exact net)`, each line within 1, ≥ 1,000 cases).
- [X] T010 [P] Unit spec `BILLING/domain/allocation.spec.ts` — AS-70: largest-remainder `fast-check` property (sum exact, ±1, tie order).

### Migration (expand-only)

- [X] T011 Write migration `packages/backend/migrations/2026101[6]…-billing-s17-expand.js` per data-model.md: `SET LOCAL lock_timeout = '5s'` per statement group, no whole-file transaction; `Plan` CHECKs (`code ~ '^[a-z][a-z0-9-]{1,31}$'`, `audience = 'BUYER' OR code IN ('starter','pro','enterprise')`, `billing_entitlements_valid(jsonb)` allowlist `freeShipping, earlyAccessDrops, maxProducts, seats, auctions, apiCallsPerMonth, assistantTokensPerMonth` and values ≥ 0, added `NOT VALID` then validated), seed `starter.seats 2→5`, `pro.seats 20→25` only where old value, `enterprise` seed (A22); `Price` `version INTEGER NOT NULL DEFAULT 1` (backfill row_number), `trialDays INTEGER NOT NULL DEFAULT 0 CHECK (trialDays BETWEEN 0 AND 90)`, CHECK `unitAmount BETWEEN 0 AND 100000000`, CHECK `currency = 'EUR'`, unique `(planId, interval, version)`, trigger `billing_price_immutable` (only `active` true→false may change; BEFORE DELETE raises when referenced) (A2, A23).
- [X] T012 In the same expand migration: `Subscription` `statusSince TIMESTAMPTZ NOT NULL DEFAULT now()`, `canceledAt`, `cancelReason TEXT NULL`, `offboardingStartedAt`, `creditBalanceMinor BIGINT NOT NULL DEFAULT 0 CHECK (creditBalanceMinor >= 0)`, partial indexes `Subscription_run_due_idx ("currentPeriodEnd","id") WHERE status IN ('TRIALING','ACTIVE')` and `Subscription_unpaid_idx ("statusSince") WHERE status = 'UNPAID'`, plain index `(subjectType, subjectId)`; `Invoice` `businessKey TEXT` (backfill, then NOT NULL + unique `(subscriptionId, businessKey)`), `attemptStartedAt`, `attemptUnknown BOOLEAN NOT NULL DEFAULT FALSE`, `manualAttempts INTEGER NOT NULL DEFAULT 0`, `firstFailedAt`, `paidAt` (backfill), index `(subscriptionId, createdAt DESC, id DESC)`, trigger `billing_invoice_immutable` (legal edges `OPEN→PAID`, `OPEN→UNCOLLECTIBLE`, `UNCOLLECTIBLE→PAID`; no DELETE); `InvoiceLine` trigger `billing_invoice_line_immutable` and widened kind CHECK `PLAN, USAGE, ADJUSTMENT, CREDIT, PRORATION_CREDIT, PRORATION_CHARGE` (A10, A23).
- [X] T013 In the same expand migration: new tables `SubscriptionTransition` (unique `(subscriptionId, version)`, actor CHECK `^(user:[0-9a-f-]{36}|system:billing-run|system:dunning|event:[0-9a-f-]{36})$`), `InvoiceTransition`, `SubjectPlanState` (PK `(subjectType, subjectId)`, `tier CHECK (tier IN ('STARTER','PRO','ENTERPRISE'))`, `planVersion INTEGER NOT NULL`), trigger `billing_history_append_only`; idempotent batched (500) data step converting negative open `PRORATION` invoices into `creditBalanceMinor` with history reason `migrated_credit` (only `WHERE status = 'OPEN' AND total < 0`; re-run changes nothing) (A6, A9, A23).
- [X] T014 [P] Write contract migration `…-billing-s17-contract.js` dropping `Invoice_subscriptionId_periodStart_kind_key` and the old due index (runs after expand code deployed; not applied in the test stack before AS-84 checks).
- [X] T015 Register rows in `packages/backend/db/ownership.ts`: `SubscriptionTransition`, `InvoiceTransition`, `SubjectPlanState` (`domain:billing`) and functions/triggers `billing_price_immutable`, `billing_invoice_immutable`, `billing_invoice_line_immutable`, `billing_history_append_only`, `billing_entitlements_valid` (like S16); run `pnpm check:table-ownership --strict` (C).
- [X] T016 [P] Update Sequelize models in `BILLING/infra/models/*.model.ts` for new columns and add `subscription-transition.model.ts`, `invoice-transition.model.ts`, `subject-plan-state.model.ts`; `pnpm check:model-registry`.

### Pure domain (make T006–T010 pass)

- [X] T017 [P] `BILLING/domain/subscription-status.ts` — discriminated union, `transition(status, trigger) → {ok:true,to}|{ok:false,error:'illegal_transition'}`, `assertNever` in every `switch` (A5); passes T006.
- [X] T018 [P] `BILLING/domain/invoice-status.ts` (`OPEN→PAID|UNCOLLECTIBLE`, `UNCOLLECTIBLE→PAID`, VOID storable only), `BILLING/domain/errors.ts`, `BILLING/domain/money.ts` (BIGINT minor, integer math, no float).
- [X] T019 [P] Rewrite `BILLING/domain/periods.ts` (UTC, month-end/leap anchors, no `Math.round(ms/86_400_000)`); passes T007 (A16).
- [X] T020 [P] `BILLING/domain/dunning-schedule.ts` — pure `firstFailedAt + 1/3/7 days`; passes T008 (A12).
- [X] T021 [P] Rewrite `BILLING/domain/proration.ts` (UTC-date day count, single rounding half away from zero) and add `BILLING/domain/allocation.ts` (largest remainder); pass T009, T010 (A16).
- [X] T022 [P] `BILLING/domain/charge-outcome.ts` (paid, declined, authentication_required, no_payment_method, unknown, unclassifiable→unknown), `cursor.ts` (opaque base64url `{createdAt,id}` with version tag; tampered ⇒ `invalid_cursor`), `tier.ts`, `metrics.ts` (incl. `billing_overdue_subscriptions` gauge, labels never carry payment refs).
- [X] T023 `BILLING/domain/ports.ts` — tokens `SUBSCRIPTION_REPOSITORY`, `INVOICE_REPOSITORY`, `CATALOG_REPOSITORY`, `PLAN_STATE_REPOSITORY`, `BILLING_GATEWAY`, `SHOP_DIRECTORY`, `USAGE_LINES_PROVIDER` (D-6).
- [X] T024 Repository adapters in `BILLING/infra/{subscription,invoice,catalog,plan-state}.repository.ts`: SQL only in `infra/`, bound parameters, instants from the clock, `(subjectType, subjectId)` in every predicate (III.4), version-guarded conditional update `WHERE id=:id AND status=:from AND version=:v` asserting one row plus history insert; `INSERT … ON CONFLICT DO NOTHING RETURNING` then `SELECT` for invoice business keys; credit decrement `WHERE creditBalanceMinor >= :x`.
- [X] T025 Shop directory adapter `BILLING/infra/shop-directory.adapter.ts` over `ShopQueryService.getShopsByIds` (S03 follow-up: no `ShopModel`, `ShopMembershipModel`, `MembershipService`, raw tenancy SQL). `MembershipQueryService`/`ShopAccessService` only if a use case needs them (none expected).
- [X] T026 Split modules: `BILLING/billing.module.ts` (core: controllers + use cases + repositories + S18 providers unchanged), `billing-worker.module.ts` (jobs + schedule bootstrap, own providers), `billing-consumer.module.ts` (tenancy consumers, own providers) — each boots standalone (L-018); barrel `BILLING/index.ts` drops model exports and `UsageProjector` export, keeps S18 exports and `RequiresShopEntitlement`/`UsageService` (D-7, D-8, A25, A28).
- [X] T027 [P] Provider adapter: add `findPaymentIntentByMetadataPair(pairs, timeoutMs)` to `packages/backend/libs/infrastructure/stripe/stripe.service.ts` (additive), `BILLING/infra/stripe-billing-gateway.ts` (create with invoice currency, metadata `{kind:'subscription_invoice', invoiceId, subscriptionId, attempt}` — never `idempotencyKey`, 8 s timeout, `maxNetworkRetries: 0`, lookup, classification); replace direct `StripeService.createPaymentIntent` use in `infra/billing-gateway.port.ts` (A14, A27, S13 follow-ups; breaker and `is_load_test` are not on billing's path).
- [X] T028 [P] `BILLING/infra/usage-lines.adapter.ts` — `UsageInvoiceLinesProvider` token over `UsageService` (≤ 5 s timeout, throws on failure; transitional until S18) (A25).
- [X] T029 [P] `BILLING/rate-limit-policies.ts` (`billing.subscribe.subject` 10/h fail-closed, `billing.change.subject` 30/h, `billing.preview.subject` 60/min, `billing.payment-method.subject` 5/h, `billing.plans.ip` 120/min fail-open) via S50 `definePolicies` (A21).
- [X] T030 Events: rewrite `BILLING/application/events/billing-events.ts` with four `defineEvent` (`billing.subscription_status_changed` with `subscriptionId, from, planCode, subscriptionVersion`; `billing.subscription_plan_changed {shopId, plan, version}`; `billing.invoice_payment_failed` with `reason, totalMinor, currency`, `subjectType USER|SHOP`; `billing.invoice_paid`), schemas re-exported from contracts (T002); grep other consumers of the old shapes (A20, S28 follow-up).
- [X] T031 `BILLING/application/plan-tier.service.ts` + plan-state repository: per-shop monotonic `SubjectPlanState.planVersion`, emits `billing.subscription_plan_changed {shopId, plan, version}` only for shops and only when the effective tier changes, inside the change's transaction via `OutboxService.append` (S03 follow-up, A20).

**Checkpoint**: `test-spec.sh libs/domains/billing/domain` green; `tsc --noEmit` green; migration applies on the test stack.

---

## Phase 3: US1 — Plans are a catalog and a price is never edited (P1) 🎯 MVP

**Goal**: public deterministic catalog, admin write API, immutable prices. **Independent test**: `plans-catalog.e2e-spec.ts` (AS-01–AS-08).

- [X] T032 [US1] Write failing e2e `BILLING/plans-catalog.e2e-spec.ts` describe "Billing: plans and versioned prices": AS-01 catalog read, AS-02 create plan (duplicate code `plan_code_taken`, shop codes, entitlements), AS-03 new price version, AS-04 existing subscribers keep price (renewal on retired price), AS-05 store refuses price edit (privileged statements, SC-008), AS-06 validation/limits, AS-07 retire twice → 409 `price_already_retired`, AS-08 401/403; response bodies parsed with contracts schemas; persisted state asserted.
- [X] T033 [US1] `BILLING/application/catalog.service.ts` (plans, prices, retire; `trialDays` 0–90, currency EUR, bounds).
- [X] T034 [P] [US1] `BILLING/api/plans.controller.ts` (`GET /plans`, anonymous, `Cache-Control: public, s-maxage=300`, `billing.plans.ip`) and `BILLING/api/admin-billing.controller.ts` (`POST /admin/billing/plans`, `…/plans/:planId/prices`, `…/prices/:priceId/retire`; `Firewall({roles:[ADMIN]})`), with `api/billing.dto.ts` zod pipes from contracts and `api/billing.mappers.ts` (model→DTO, never `paymentMethodRef`) (A1, A2).
- [X] T035 [US1] Run `test-spec.sh libs/domains/billing/plans-catalog.e2e-spec.ts` green; add proof lines to the living page.

**Checkpoint**: catalog independently usable.

---

## Phase 4: US2 — A customer subscribes, safely and once (P1)

**Goal**: atomic subscribe, no provider call in request. **Independent test**: `subscribe.e2e-spec.ts` (AS-09–AS-20).

- [X] T036 [US2] Write failing e2e `BILLING/subscribe.e2e-spec.ts` describe "Billing: subscribing": AS-09 shop subscribes (subscription + history + invoice + lines + charge job + outbox in one transaction; provider double 0 calls), AS-10 buyer, no tier event, AS-11 trial from price/anchor day, AS-12 trial once per subject, AS-13 client cannot send `trialDays` (400), AS-14 payment method required when money due/free price, AS-15 eligibility (audience, sandbox, retired price), AS-16 one live subscription under concurrent subscribes (50×, one 201) and `UNPAID` blocks, AS-17 validation, AS-18 credentials/IDOR, AS-19 idempotency (replay, in-flight, different body, missing), AS-20 429 and limiter down (503 fail-closed); retest S03 `403 shop_suspended` / `409 shop_offboarding` on this write route.
- [X] T037 [US2] `BILLING/application/subscribe.service.ts`: eligibility via `SHOP_DIRECTORY` before the transaction; trial from price; once per subject; anchor = first paid period start; `TransactionRunner.run` writing subscription + `SubscriptionTransition` + invoice + lines + `billing.charge-invoice` job + outbox rows (+ plan-tier event for shops); entitlement cache invalidated after commit; `@Idempotent`; clock only (A3, A4).
- [X] T038 [US2] `BILLING/api/shop-subscription.controller.ts` and `buyer-subscription.controller.ts` — `GET|POST` subscription routes sharing the service via two subject resolvers (`ShopScoped('billing.manage'|'shop.read')`, session user for `/me`), rate-limit decorators, check order authn → authz → validation → idempotency → rate limit → eligibility; remove the old `billing.controller.ts`.
- [X] T039 [US2] Run `subscribe.e2e-spec.ts` green. Start `apps/core` alone to confirm it boots (L-004, L-015).

---

## Phase 5: US3 — One status, only legal arrows (P1)

**Goal**: state machine enforced at API and store. **Independent test**: `subscription-lifecycle.e2e-spec.ts` AS-22–AS-25 (+ T006 unit already green).

- [X] T040 [US3] Write failing e2e part of `BILLING/subscription-lifecycle.e2e-spec.ts` describe "Billing: subscription state machine, cancel, resume and shop lifecycle": AS-22 illegal moves → 409/404, AS-23 one history row per move, atomic, append-only (privileged tamper rejected), AS-24 conditional transitions under concurrency (50×, consistent chain), AS-25 `CANCELED` terminal.
- [X] T041 [US3] `BILLING/application/subscription-transitions` helper (or in `subscription.repository`) applying `transition()` + version guard + history + outbox `billing.subscription_status_changed` (not for `cancel_scheduled`/`cancel_withdrawn`) in one transaction; map failures to `409` codes (`subscription_not_changeable`, `subscription_changed_concurrently`) and `404` (A5, A7).
- [X] T042 [US3] Run AS-22–AS-25 green.

---

## Phase 6: US4 — The billing run renews every subscription exactly once (P1)

**Goal**: scheduled, concurrent-safe renewal. **Independent test**: `billing-run.e2e-spec.ts` (AS-26–29, 31–39).

- [X] T043 [US4] Write failing e2e `BILLING/billing-run.e2e-spec.ts` describe "Billing: renewal run": AS-26 renewal, AS-27 due boundary at the millisecond, AS-28 two concurrent runs (50×), AS-29 scheduled once, AS-31 trial ends, AS-32 cancel at period end, AS-33 delinquent not renewed, AS-34 `UNPAID` 30-day expiry boundary, AS-35 catch-up one period per run, AS-36 usage lines unavailable → deferred (forced fault), AS-37 poison subscription and crash resume after Nth commit (twin run identical), AS-38 batches ≤ 500, ordering, no double claim, AS-39 invoices/lines immutable (privileged statements).
- [X] T044 [US4] `BILLING/application/renewal.service.ts`: claim ≤ 500 with `FOR UPDATE SKIP LOCKED` ordered by `(currentPeriodEnd, id)`; usage lines fetched before each per-subscription transaction (timeout 5 s, deferral on failure, metrics); one period per run; business key `renewal:<periodStart ISO ms>` with duplicate returns existing invoice; credit applied up to each renewal's positive subtotal (A9, FR-043/044); trial end; cancel at end; `UNPAID` expiry; delinquent skipped; poison row isolated (A8, A10).
- [X] T045 [US4] `BILLING/infra/billing.jobs.ts` rewritten as thin `@JobHandler` shells (`billing.run`, payload via `declareJobType`, malformed rejected without effect) plus `upsertSchedule` `*/10 * * * *` UTC lease 600 s at worker boot; shutdown registry honoured between units; `BILLING/billing-worker.module.ts` wiring (A24, D-6).
- [X] T046 [US4] Run `billing-run.e2e-spec.ts` green. Start `apps/worker` alone; confirm schedule registered once (L-018).

---

## Phase 7: US5 — Exactly-once charging and dunning (P1)

**Goal**: claim → provider outside tx → settle; unknown outcomes resolved by lookup; dunning. **Independent test**: `invoice-charging.e2e-spec.ts` (AS-40–42, 44–58).

- [X] T047 [US5] Write failing e2e `BILLING/invoice-charging.e2e-spec.ts` describe "Billing: charging, unknown outcomes and dunning": AS-40 success (key, currency, metadata, no open tx), AS-41 decline starts dunning (events with `reason`), AS-42 full dunning to `UNPAID` (day 1/3/7 exact), AS-44 early job does nothing, AS-45 duplicate/concurrent delivery (50×, ≤ 1 create per attempt key), AS-46 paying while past due recovers, AS-47 recovery waits for every invoice in dunning, AS-48 silent provider → unknown (forced fault), AS-49 lookup finds succeeded/failed/awaiting, AS-50 lookup finds nothing + 60-min boundary, AS-51 lookup unreachable (forced fault), AS-52 customer action, AS-53 no payment method, AS-54 zero/negative never charged, AS-55 new card gives one extra attempt now, AS-56 paying `UNPAID` reactivates, AS-57 payment-method route validation/401/404/403/429, AS-58 unclassifiable → unknown (forced fault); SC-009 no payment ref in anything.
- [X] T048 [US5] `BILLING/application/charge.service.ts`: claim on `Invoice.attemptStartedAt` (conditional), provider call outside any transaction (8 s), settle conditionally; dunning `nextAttemptAt` from `dunning-schedule`; `billing.invoice_paid` / `billing.invoice_payment_failed` through outbox in the settle transaction; recovery to `ACTIVE` only when no other owed invoice (A11, A12).
- [X] T049 [US5] `BILLING/application/attempt-resolution.service.ts` + jobs `billing.resolve-attempt` (+30 s then full-jitter backoff capped 15 min, reschedules itself, 60-min limit, stale-claim detection) via the gateway lookup; unknown outcome never re-sent (A13).
- [X] T050 [US5] `BILLING/application/payment-method.service.ts` + route `PUT …/subscription/payment-method` (shop and `/me`, `billing.payment-method.subject`) + job `billing.manual-attempt` (`invoice-charge:<invoiceId>:manual:<k>`, one extra attempt, only on `PAST_DUE`/`UNPAID`) (A15).
- [X] T051 [US5] Jobs `billing.charge-invoice` (concurrency 8, 3 retries infra-only, idempotency key `invoice-charge:<invoiceId>:<attempt>`) in `infra/billing.jobs.ts`; assert pool arithmetic (≤ 17 connections) in a config test against the platform pool default (plan: Pool arithmetic).
- [X] T052 [US5] Run `invoice-charging.e2e-spec.ts` green.

---

## Phase 8: US6 — Changing plan or seats charges exactly the part affected (P1)

**Goal**: preview equals invoice; credit balance. **Independent test**: `subscription-change.e2e-spec.ts` (AS-59–62, 65–69; AS-63/64/70 already green as units).

- [X] T053 [US6] Write failing e2e `BILLING/subscription-change.e2e-spec.ts` describe "Billing: plan changes and proration": AS-59 preview, AS-60 upgrade equals preview to the minor unit (SC-003), AS-61 downgrade becomes credit, applied at renewals (recompute invoice from history and price version, SC-008), AS-62 seat change, AS-65 change while trialing, AS-66 refused changes (`subscription_not_changeable`, `no_change_requested`, `billing_interval_change_not_supported`, `plan_not_available_for_subject`, `quantity_not_applicable`), AS-67 concurrent changes (50×), AS-68 change vs renewal at boundary (50×), AS-69 validation/401/404/403/idempotency/429; retest S03 closed-shop codes on change.
- [X] T054 [US6] `BILLING/application/change.service.ts` (preview + change): reads inside the transaction with version guard (trial path too), key `proration:v<new version>`, lines `PRORATION_CREDIT`/`PRORATION_CHARGE`, `creditBalanceMinor` for negative nets, outbox + charge job + cache invalidation after commit, plan-tier event (A17, A16).
- [X] T055 [US6] Routes `POST …/subscription/preview` and `…/change` in shop and buyer controllers with `@Idempotent` on change and rate-limit policies.
- [X] T056 [US6] Run `subscription-change.e2e-spec.ts` green.

---

## Phase 9: US7 — Customers leave cleanly, closed shops stop being billed (P2)

**Goal**: cancel, resume, tenancy consumers. **Independent test**: remaining rows of `subscription-lifecycle.e2e-spec.ts` (AS-71–77).

- [X] T057 [US7] Extend failing `subscription-lifecycle.e2e-spec.ts`: AS-71 cancel at period end, AS-72 cancel immediately, AS-73 resume, AS-74 cancel/resume validation/401/404/403 (+ cross-tenant), AS-75 offboarding stops billing and out-of-order cancel (`occurredAt > offboardingStartedAt`), AS-76 deleted shop (`CANCELED`, `paymentMethodRef` NULL, histories intact), AS-77 duplicate delivery on all three consumers and invalid payload dead-lettered.
- [X] T058 [US7] `BILLING/application/cancellation.service.ts` and routes `POST …/cancel {immediately?}`, `POST …/resume` (409 `already_scheduled_for_cancellation`, `not_scheduled_for_cancellation`; history rows `from = to` for schedule/withdraw) (A7).
- [X] T059 [US7] `BILLING/application/tenancy-lifecycle.service.ts` and `BILLING/infra/tenancy.consumers.ts` (`tenancy.shop_offboarding_started`, `…_cancelled`, `shop_deleted`; zod validation; `InboxService` dedupe in the effect's own transaction; DLQ on invalid); `billing-consumer.module.ts` boots alone; confirm event definitions are importable from `@app/domains/tenancy` else record an S03 follow-up (A19).
- [X] T060 [US7] Run full `subscription-lifecycle.e2e-spec.ts` green.

---

## Phase 10: US8 — Reads and events (P2)

**Goal**: subscription and invoice reads, versioned events. **Independent test**: `billing-reads-events.e2e-spec.ts` (AS-78–81).

- [X] T061 [US8] Write failing e2e `BILLING/billing-reads-events.e2e-spec.ts` describe "Billing: reads and events": AS-78 read subscription (`hasPaymentMethod`, no ref, entitlements), AS-79 invoice history keyset pages, after cancellation, `invalid_cursor`, AS-80 invoice detail and cross-tenant identical 404 body (SC-006 matrix over every route), AS-81 plan tier events versioned per shop, consecutive, monotonic under concurrency.
- [X] T062 [US8] `BILLING/application/invoice-query.service.ts` (keyset list/detail joined on `Subscription (subjectType, subjectId)`, subject in predicate) and `application/subscription-basis.service.ts` (`getLiveBasis`, `getLiveBasisBySubjectIds`, exported from barrel for S18) plus routes `GET …/invoices`, `GET …/invoices/:invoiceId`, `GET /me/invoices[/:id]` (A18).
- [X] T063 [US8] Run `billing-reads-events.e2e-spec.ts` green.

---

## Phase 11: US9 — Safe to run, move and keep (P3)

**Goal**: boundaries, secrets, migration, shutdown. **Independent test**: `billing-ops.e2e-spec.ts` (AS-82–85).

- [X] T064 [US9] Write failing e2e `BILLING/billing-ops.e2e-spec.ts` describe "Billing: boundaries, secrets, migration and shutdown": AS-82 registry assertion for the new tables/functions, AS-83 no payment data in logs, responses, events across a full lifecycle (SC-009), AS-84 expand migration on a seeded old schema (conversion, re-run is a no-op), AS-85 graceful shutdown mid-run and mid-charge (forced fault).
- [X] T065 [US9] Fix whatever AS-82–85 reveal; delete the old `BILLING/billing.e2e-spec.ts` and `domain/billing-math.spec.ts` only after a scenario-by-scenario check against test-plan.md (L-017); remove old `billing.service.ts` logic (moved, not copied) and any leftover `Date.now()`/`new Date()`.
- [X] T066 [US9] Run `billing-ops.e2e-spec.ts` green.

---

## Phase 12: Gap closure, follow-ups, Ops artifacts, polish

- [X] T067 Gap sweep: tick each gaps.md item against code — A1–A28 (owners in plan Gap-to-plan map), B (D-6, D-7, D-8; D-14 unchanged), C (`check:table-ownership --strict` billing rows = 0), D order followed. Record anything unmet in `gaps.md` rather than hiding it.
- [X] T068 S03 follow-up proof: grep `BILLING` for `ShopModel|ShopMembershipModel|MembershipService` and raw SQL on tenancy tables (must be none); confirm `payouts.read` and `sso.manage` are not billing permissions (state it in the report); retest closed-shop codes covered in T036/T053.
- [X] T069 S13 follow-up proof: grep that billing sends no payments command, passes the invoice currency, uses no `is_load_test` branch and no breaker; `maxNetworkRetries: 0`.
- [X] T070 [P] S28 follow-up: confirm event names/payloads in `contracts/events.md` match `packages/contracts/src/billing/events.ts`; `billing.invoice_payment_failed` has `reason` and `subjectType USER|SHOP`, `billing.invoice_paid` exists (test in AS-41/AS-40).
- [X] T071 [P] S54 transaction gate: `grep -rn "sequelize.transaction" BILLING` count 0; delete any `// S54 T037 audit` comment in files touched.
- [X] T072 Sibling bullets: verify `## Sibling-spec follow-ups` in `gaps.md` has S10 (ignore `kind: subscription_invoice`), S13 (domain-map wording; unused `Domain_CircuitBreakerOpenError`), S14, S18, S28, S03, S46 entries; add any new ones discovered; do not edit sibling specs. Update `docs/work/architecture/{domain-map.md,debt-register.md}` for D-6/D-7/D-8 and the "provider via infrastructure" wording only if rule 1 allows (otherwise leave as a sibling bullet).
- [X] T073 [P] Ops artifacts: bench script `scripts/bench/billing-run-10k.ts` (SC-001, SC-002); confirm quickstart.md "Ops artifacts" lists SC-001, SC-002, SC-007, SC-010 lock time, provider search consistency (R-4), J02 step; confirm `specs/UNVERIFIED.md` has one `not run` row each (rows already present at lines ~213–218; add any missing); never describe them as verified.
- [X] T074 Static gates: `pnpm tsc --noEmit`, `pnpm lint` (backend and contracts), `pnpm check:boundaries`, `pnpm check:table-ownership --strict`, `pnpm check:model-registry`, `pnpm check:no-wallclock`, `python3 scripts/livespec/check.py` — all green.
- [X] T075 Importers still pass (A28): `test-spec.sh libs/domains/auctions` and `libs/domains/assistant`.
- [X] T076 Whole capability once: `/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/billing` (batches of fresh processes if large, L-008; a batch without its summary line is a crash).
- [X] T077 (DONE except the empty-stack run: `boot-app.sh core|worker|projector` and `boot-check.sh --start` passed 2026-10-15; the billing suite and the three wiring specs pass (11 suites, 120 tests); `scripts/qa/fresh-run.sh` refuses while the dev stack is up and takes a full browser run, so it is listed in `specs/UNVERIFIED.md` as `not run`) Runtime proofs by script (L-004, L-015, L-018, L-012, L-019): boot `apps/core` and `apps/worker` each alone (worker registers `billing.run` once and three consumers); `scripts/qa/fresh-run.sh` with the billing suite on an empty stack. Record failures, never skip.
- [X] T078 Final report notes in `gaps.md` under `## Spec changes` ("None" unless a human-signed line changed) and list each follow-up addressed (S03 ×2, S13 ×2, S28 ×2).

---

## Dependencies & Execution Order

- Phase 1 → Phase 2 (blocks all). Inside Phase 2: tests T006–T010 before domain T017–T021; migration T011–T013 before models/repos T016/T024; T023 before T024–T028.
- US1 (P1) needs Phase 2 only. US2 needs US1's fixtures (prices) and T031. US3 can start after T041's helper; US4, US5, US6 need US2 (subscriptions exist) and US3 transitions. US5 needs US4 (invoices). US6 needs US5's charge job. US7 needs US3. US8 needs US2. US9 last, then Phase 12.
- Recommended order: Phases 1–2 → US1 → US2 → US3 → US4 → US5 → US6 → US7 → US8 → US9 → Phase 12.

## Parallel Opportunities

- Setup T002, T003, T004 together. Foundational unit specs T006–T010 together; domain files T017–T022 together; T027, T028, T029 together.
- After Phase 2: US1 controllers (T034) parallel with US8 query service drafting; US7 consumers (T059) parallel with US6 once US3 lands.

## Implementation Strategy

- **MVP**: Phases 1–2 + US1 + US2 (catalog and subscribe) — then US3/US4/US5 for money safety, which is the real value; do not ship renewal without charging exactly-once.
- Incremental: each story ends with its e2e file green and its proof lines on the living page; whole suite only in T076.

## Notes

- Every gaps.md item maps to a task (T067 verifies). Every test-plan row maps to a test task: AS-01–08 T032, 09–20 T036, 21 T006, 22–25 T040, 26–29/31–39 T043, 30 T007, 40–42/44–58 T047, 43 T008, 59–62/65–69 T053, 63–64 T009, 70 T010, 71–77 T057, 78–81 T061, 82–85 T064.
