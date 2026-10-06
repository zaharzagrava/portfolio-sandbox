# Gaps: S17 — Subscriptions (domain `billing`)

What the current code gets wrong or lacks against [`spec.md`](spec.md). This is the implementation agent's to-do list. References are `file:line` under `packages/backend/libs/domains/billing/` unless stated. Decisions behind each item are in [`questions.md`](questions.md).

## A. Behaviour gaps

| # | Gap | Where | Spec |
|---|---|---|---|
| A1 | Responses serialize ORM models, including `paymentMethodRef`; `plans()` returns `Price` rows with an embedded `Plan`; no contracts schemas exist in `packages/contracts` | `api/billing.controller.ts:20-21, 28, 69`, `application/billing.service.ts:35-37, 120-126` | FR-001, FR-013, AS-01, AS-09, AS-78 |
| A2 | No catalog write API: no admin routes to create a plan, publish a price version or retire a price; `Price` has no `version`, no `trialDays`; immutability is a comment, not a store rule; no currency check; plan codes unconstrained | (absent), `infra/models/price.model.ts:5-18`, migration `migrations/20261001190000-subscriptions-billing.js:13-32` | FR-002–FR-006, AS-02–AS-08 |
| A3 | Subscribe: no `Idempotency-Key`; `trialDays` chosen by the client (`:49-50`); no payment-method requirement or format check (`dto:7`); no sandbox-shop check; no trial-once rule; price read outside the transaction; `new Date()` instead of the clock (`:44`); anchor is the subscribe day, wrong for trials (`:45`); `UNPAID` subscriptions block re-subscribing with no exit; entitlement cache invalidated inside the transaction (`:69`) | `application/billing.service.ts:39-76`, `api/billing.dto.ts:4-9`, `api/billing.controller.ts:31-35, 72-76` | FR-007–FR-012, FR-014, AS-09–AS-20 |
| A4 | The first invoice's charge job is enqueued without the open transaction, so it can run before the invoice commits; events are recorded by separate statements | `application/billing.service.ts:147`, `infra/billing.jobs.ts:138-147, 160` | FR-011, FR-039, AS-09 |
| A5 | No status transition table: `setStatus` updates a possibly stale instance with no `WHERE status = :from`, no history row, no `assertNever`; `Subscription.status` is a plain union with no exhaustive `switch`; no `statusSince`, `canceledAt`, `cancelReason` | `infra/billing.jobs.ts:157-161`, `infra/models/subscription.model.ts:5, 15` | FR-015–FR-018, AS-21–AS-25 |
| A6 | No history tables for subscriptions or invoices (III.7) | (absent), migration `…190000…js` | FR-016, FR-030, AS-23 |
| A7 | Illegal calls are not answered `409`: `change` is allowed in `PAST_DUE`/`UNPAID`; `cancelAtPeriodEnd` does not check for an existing schedule and updates by ID without the subject (`:116`); returns `404` for any miss and `204` on success; no resume, no immediate cancel | `application/billing.service.ts:90-118`, `api/billing.controller.ts:52-57` | FR-017, FR-046, FR-047, AS-22, AS-71–AS-74 |
| A8 | Billing run: `findAll` with `limit: 500`, no ordering, no row locks, `new Date()` for "now" (`:58`); `PAST_DUE` and `UNPAID` not handled with a cancel flag; no `UNPAID` expiry; no trial-end status history; failures only logged (`:62`) with no metrics; no deferral; usage lines fetched without a timeout | `infra/billing.jobs.ts:55-110` | FR-021–FR-028, AS-26–AS-38 |
| A9 | Renewal marks every negative open `PRORATION` invoice `PAID` wholesale and builds `CREDIT` lines from them, losing credit above the renewal total; the renewal total can be negative | `infra/billing.jobs.ts:87, 112-115` | FR-043, FR-044, AS-61 |
| A10 | Invoice uniqueness `(subscriptionId, periodStart, kind)` with `findOrCreate` returning `null` on a duplicate: a second same-instant change gets no invoice; no business key; no `paidAt`, `firstFailedAt`, `attemptStartedAt`, unknown-attempt state; invoices and lines are editable | `application/billing.service.ts:129-149`, `infra/models/invoice.model.ts:9-21`, migration `…190000…js:55-78` | FR-023, FR-029, AS-26, AS-39, AS-60 |
| A11 | Charge job reads `attempts`, calls the provider, then writes, with no attempt claim, so two deliveries both act; `invoice.update` is unconditional; a paid invoice returns any `PAST_DUE` subscription to `ACTIVE` regardless of other owed invoices | `infra/billing.jobs.ts:117-132` | FR-031, FR-036, FR-019, AS-45–AS-47 |
| A12 | Dunning delays count from `Date.now()` at each failure (cumulative 1, 4, 11 days) instead of `firstFailedAt + 1/3/7`; the schedule is inline, not a pure function | `infra/billing.jobs.ts:26, 136-137` | FR-034, AS-42, AS-43 |
| A13 | Unknown outcomes `throw` and rely on generic job retry: no lookup by reference, no 60-minute limit, no unknown state, no resolution job, no classification of unrecognised answers or customer-action answers as separate reasons; "no payment method" is a definite failure without events of its own | `infra/billing.jobs.ts:125-134`, `infra/billing-gateway.port.ts:24-31` | FR-032, FR-033, FR-037, AS-48–AS-53, AS-58 |
| A14 | The provider adapter sends no currency (the shared client hard-codes `usd`), no metadata beyond `idempotencyKey`, no timeout, and no lookup operation is exposed on the port; the shared client answers "succeeded" in load-test mode without calling the provider | `infra/billing-gateway.port.ts:24-26`, `libs/infrastructure/stripe/stripe.service.ts:63-110`, `:206` (`findPaymentIntentByIdempotencyKey` exists but is unused here) | FR-031, AS-40 |
| A15 | No payment-method update route (so no recovery path and no extra attempt) | (absent) | FR-038, AS-55–AS-57 |
| A16 | Proration: independent per-line rounding with float division, day count by `Math.round(ms / 86_400_000)` (wrong at half days and with time-of-day periods), `amountFor` uses `Number(...)` money | `domain/proration.ts:25-35`, `domain/periods.ts:19-21`, `application/billing.service.ts:21` | FR-041, FR-042, FR-053, AS-63, AS-64, AS-70 |
| A17 | Change flow: `loadChange` outside the transaction; trial path updates without a version guard (`:93-97`); no refusal for no-op changes; no `Idempotency-Key`; no credit balance; invoice key collision (A10); cache invalidated after, not tied to the commit | `application/billing.service.ts:90-113, 151-158` | FR-040–FR-046, AS-59–AS-69 |
| A18 | Invoices: last 24 of the live subscription only (`404` after cancellation), no cursor, no detail route, no buyer route; `mustHave` loads by shop then the subscription (principal not in the invoice predicate) | `application/billing.service.ts:124-126`, `api/billing.controller.ts:59-63, 78-82` | FR-050, FR-051, AS-79, AS-80 |
| A19 | No tenancy event consumers (offboarding, deletion); no inbox | (absent) | FR-048, FR-049, AS-75–AS-77 |
| A20 | Events: `SubscriptionStatusChanged` and `InvoicePaymentFailed` lack `from`, `planCode`, `subscriptionVersion`, `reason`, amounts; `billing.invoice_paid` and `billing.subscription_plan_changed` do not exist; no per-shop plan counter; not written through the outbox in the same transaction | `application/events/billing-events.ts:4-16`, `infra/billing.jobs.ts:138-147, 160` | FR-020, FR-039, FR-052, AS-41, AS-81 |
| A21 | No rate-limit policies on billing routes (`GET /plans` skips throttling entirely) | `api/billing.controller.ts:17`, whole controller | FR-014, AS-20, AS-57, AS-69 |
| A22 | Plan seeds disagree with S03's seat limits (starter 2, pro 20) and there is no `enterprise`; negative or unknown entitlement keys are not validated | migration `…190000…js:82-83`, `infra/models/plan.model.ts:5-13` | FR-002, `questions.md` |
| A23 | Migration lacks `lock_timeout`, immutability triggers, history tables, `creditBalanceMinor`, business keys, `Price.version`/`trialDays`, a CHECK `currency = 'EUR'`, and a conversion of existing negative open prorations | migration `…190000…js:9-95` | FR-058, AS-05, AS-84 |
| A24 | The worker module imports every provider but no shutdown handling for the run or in-flight charges is specified in code; no metrics | `billing-worker.module.ts:14-19`, `infra/billing.jobs.ts` | FR-059, FR-060, AS-85 |
| A25 | `EntitlementsService`, `UsageService`, `ShopEntitlementGuard` and the usage projector live in this domain's S17-facing module and barrel; the renewal reaches into `UsageService` directly instead of a lines provider | `billing.module.ts:20-27`, `infra/billing.jobs.ts:92-110`, `index.ts:14-15` | cross-capability contracts (S18) |
| A26 | Tests: the e2e suite calls `BillingService` and `BillingJobs` directly (no HTTP, no `supertest`), spies on `UsageService`, uses `DUNNING_DAYS.length` to loop, and has no cross-tenant, idempotency, rate-limit, concurrency (beyond two runs), unknown-outcome, event or consumer cases; the unit spec covers 4 cases with no property tests | `billing.e2e-spec.ts:62-63, 71-119`, `domain/billing-math.spec.ts:1-53` | VII.2, VII.3, VII.4, VII.5, all of `test-plan.md` |
| A27 | The order webhook maps provider intents by `metadata.idempotencyKey`, which every charge from the shared provider client also sets (billing's value is `<invoiceId>:<attempt>`); it must ignore `kind: "subscription_invoice"` | `libs/domains/orders/api/stripe-webhook.controller.ts:54-55` (S10's change), `infra/billing-gateway.port.ts` | Requires S10 |
| A28 | `RequiresShopEntitlement` is applied in auctions and `UsageService` is used by the assistant's meter through the billing barrel; these are S18/S21/S46 concerns and must keep working while S17's barrel changes | `libs/domains/auctions/api/auctions.controller.ts:8, 20`, `libs/domains/auctions/auctions.module.ts:1`, `libs/domains/assistant/infra/llm/llm-meter.ts:3` | not S17; keep exports until S18 |

## B. Open debt-register rows naming `billing` (or applying to it)

Source: `docs/architecture/debt-register.md`. The only open row that names billing is D-14; D-6, D-7 and D-8 apply to every domain and are listed because billing exhibits them.

| Debt | What in billing | Mechanism that replaces it |
|---|---|---|
| D-14 (X.3, X.7) | `llm-meter` (assistant) calls billing's `UsageService` directly (`libs/domains/assistant/infra/llm/llm-meter.ts:3`) | Not S17's to fix: S46 publishes `llm.call_completed`; S18 consumes it into usage (**R3**, event → billing-owned store). S17 only keeps the barrel export until then. |
| D-6 (I.2) | `application/billing.service.ts:4-8` and `application/entitlements.service.ts:6` import `infra/models/*`; `infra/billing.jobs.ts` holds application logic (renewal, dunning) | Repository ports in `domain/` (injection tokens) with Sequelize adapters in `infra/`; renewal and charging become `application/` services, with `BillingJobs` a thin handler (**no cross-domain mechanism; layering only**). |
| D-7 (IX.4) | `index.ts:7-11` exports `InvoiceLineModel`, `InvoiceModel`, `PlanModel`, `PriceModel`, `SubscriptionModel` | Remove the model exports. No other domain imports them (grep of `packages/backend` found none outside billing), so nothing needs replacing; any future consumer uses the S18 R1 services or the events. |
| D-8 (X.4) | `index.ts:14-15` exports `UsageProjector` and `BillingWorkerModule` | Apps import `BillingWorkerModule` and the S18 projector module only; stop exporting the projector class (S18). |

## C. `pnpm --dir packages/backend check:table-ownership` lines for `billing`

Run in this spec session (87 cross-domain data accesses in 21 domains):

- **Billing as the accessing domain: 0 findings.** `billing` does not appear in the report. Every query in this domain (the entitlements `SELECT … FROM "Subscription" JOIN "Price" JOIN "Plan"` at `application/entitlements.service.ts:31-34`, the renewal and charge queries) touches only billing-owned tables (`Plan`, `Price`, `Subscription`, `Invoice`, `InvoiceLine`).
- **Another domain accessing a billing table: 0 findings.** No row in the report has `owned by billing`.
- **Debt D-12 for billing: none.** The only cross-domain read in the code is the S18 ClickHouse usage query (`application/usage.service.ts:35-59`), which is not Postgres and belongs to S18.

What S17 must add so the result stays 0 with `--strict`:

| New access | Mechanism |
|---|---|
| Shop `isSandbox` at subscribe | **R1** `ShopQueryService.getShopsByIds` (S03), batch, before the transaction; no `Shop` model or SQL |
| Shop authorization on shop routes | **R1** `ShopScoped` (S03); no `ShopMembership` read |
| Shop lifecycle (offboarding, deletion) | **R3-style** Kafka subscription to `tenancy.*` events with an inbox; no read of tenancy tables |
| Usage lines of a renewal | Exported service of the same domain (S18); no cross-domain access |
| Subscription history, invoice history, plan-tier state | New tables registered in `packages/backend/db/ownership.ts` as `domain:billing` in the same PR |
| Outbox rows and charge jobs | IX.6 technical-table exception: `outbox.append(event)` and the jobs service's `enqueue` inside billing's own transaction |

## D. Suggested order of work

1. Migration (expand-only, `lock_timeout`): new columns and tables, triggers for price/invoice/history immutability, conversion of existing data, ownership registry entries (A2, A6, A10, A23).
2. Pure domain: status table with `assertNever`, periods, proration with single rounding and allocation, dunning schedule, with their unit and property tests (A5, A12, A16).
3. Repository ports and application services: subscribe, change, cancel/resume, billing run, charge and resolution, payment-method update (A3–A9, A11, A13, A15, A17).
4. Provider adapter: currency, metadata, timeout, lookup, classification; remove the load-test shortcut from the shared client (A14); S10 webhook ignore rule (A27).
5. HTTP API, DTOs, contracts schemas, rate-limit policies, idempotency (A1, A7, A18, A21).
6. Consumers and events through the outbox, plan-tier counter (A19, A20).
7. Rewrite `billing.e2e-spec.ts` into the eight e2e files of `test-plan.md` over HTTP (A26); barrel cleanup and layering (B).
