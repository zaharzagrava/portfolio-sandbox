# Implementation Plan: S17 — Subscriptions (domain `billing`)

**Branch**: `S17-subscriptions` (working branch `sdd/auto`) | **Date**: 2026-10-15 | **Spec**: [spec.md](spec.md)

**Inputs**: `spec.md`, `test-plan.md` (85 scenarios, 8 e2e files + 6 unit specs), `gaps.md` (A1–A28, B, C, D), `questions.md` (defaults accepted as written; no human edits found), constitution v3.1.0, the follow-ups listed under "Follow-ups from built specs" below.

## Summary

Rebuild `libs/domains/billing` (S17 side only; S18's entitlements and usage stay) from a service that returns ORM models and charges from inside a thin job into the layered, exactly-once subscription system the spec describes:

- **Catalog.** Public deterministic `GET /plans`; admin write API; `Price` gains `version` and `trialDays`; a store trigger makes commercial fields immutable and `active` one-way.
- **Subscribe / change / cancel / resume / payment method.** `@Idempotent` routes, explicit DTOs and contract schemas, eligibility before the transaction (`ShopQueryService`), one transaction for subscription + history + invoice + lines + charge job + outbox rows, cache invalidation after commit.
- **State machine.** `domain/subscription-status.ts` (union + `assertNever`), conditional updates with version guard, `SubscriptionTransition` / `InvoiceTransition` history written in the same transaction.
- **Billing run.** `billing.run` every 10 minutes, `FOR UPDATE SKIP LOCKED` claim of ≤ 500, usage lines fetched before each per-subscription transaction (deferral on failure), one period per run, unique business keys, month-end anchors in UTC.
- **Charging.** Claim → provider call outside any transaction (8 s) → settle; unknown outcomes resolved by lookup, never re-sent; dunning at `firstFailedAt + 1/3/7` days as a pure function; manual extra attempt on a payment-method update.
- **Proration and credit.** Integer arithmetic, one rounding, largest-remainder split, `creditBalanceMinor` applied up to each renewal's positive subtotal.
- **Events and consumers.** Four outbox events (two new), per-shop `SubjectPlanState` counter, tenancy lifecycle consumers with inbox.
- **Boundaries.** Repository ports, thin job handlers, barrel without models, three modules that each boot alone.

## Technical Context

**Language/Version**: TypeScript strict, Node 22, NestJS (monorepo `packages/backend`, `packages/contracts`).

**Primary Dependencies**: `@nestjs/sequelize` with SQL confined to `infra/`; S54 `TransactionRunner`, `CLOCK`, `@Idempotent`, problem+json, metrics, shutdown registry; S49 `JobsService`, `@JobHandler`, `declareJobType`, `upsertSchedule`, `backoff`; S53 `OutboxService.append`, `Projector` framework, `InboxService`; S50 `RateLimit`, `definePolicies`; S03 `ShopScoped`, `ShopQueryService.getShopsByIds`; S01 `Firewall`, `@User()`; infrastructure `stripe` lib (`StripeService`); S18 `EntitlementsService.invalidate`, `UsageService` behind the new `UsageInvoiceLinesProvider` token; `fast-check` for properties; `supertest` for e2e.

**Storage**: PostgreSQL shared `public` schema, flat names, ownership registry `packages/backend/db/ownership.ts`. Redis only through the rate limiter, Kafka only through outbox relay and projectors. ClickHouse stays S18's.

**Testing**: eight `*.e2e-spec.ts` files and six unit specs exactly as in `test-plan.md`, run through `/opt/sdd/repo/scripts/sdd/test-spec.sh`; the provider double sits at the HTTP edge of the Stripe client; the only other fakes are the ones `test-plan.md` lists (S03 R1 answers, clock, limiter store, S18 provider).

**Target Platform**: `apps/core` (`BillingModule`), `apps/worker` (`BillingWorkerModule` + consumers). No new deployable app (I.6).

**Project Type**: backend domain capability inside the existing monorepo; contracts package; no UI (no web capability owns a billing screen).

**Performance Goals**: subscribe p95 < 1 s (no provider call in the request, SC-007); renewal within 15 minutes of period end for 99% (SC-002, bench only); 10,000 renewals benchmark (SC-001).

**Constraints**: injected clock only (`check:no-wallclock`); explicit timeouts (provider 8 s, usage 5 s, DB statement timeout); `tables(q) ⊆ owned(billing)`; expand-only migration with `lock_timeout`; no `sequelize.transaction` in the domain (count stays 0); no payment reference in logs, responses, events, metric labels.

**Scale/Scope**: up to ~1M subjects, renewals in batches of 500 per run; invoice history per subject unbounded (keyset only).

### Pool arithmetic (III.12)

- Core API: primary pool unchanged. Subscribe holds one connection per request for one short transaction (no provider call). Reads use the primary (small, indexed by subject).
- Worker: `billing.run` concurrency 1 holds one connection at a time (claim transaction, then one per-subscription transaction; usage fetch and provider calls never hold a connection). `billing.charge-invoice` concurrency 8: each of its two transactions (claim, settle) is short and the provider call between them holds none, so at most 8 + 1 + resolve (4) + manual (4) = 17 connections in the worst case, below the worker pool default (verified against the platform config at task time, T-task asserts the number in a config test).
- Statement timeout applies to every billing statement; the run's claim query has its own `lock_timeout`.

## Constitution Check

*GATE — before Phase 0 and again after Phase 1.*

| Rule | Status | How |
|---|---|---|
| I.1/I.2 layers (D-6) | PASS (after work) | `domain/` pure, `application/` use cases, `infra/` adapters; `application` reaches infra only through `domain/ports.ts` tokens; `BillingJobs` thin. |
| I.3 clock | PASS | `CLOCK` everywhere (A3 `new Date()` removed); SQL gets instants as bound parameters. |
| I.4 / IX single owner | PASS | New tables in `ownership.ts` same PR; `check:table-ownership --strict` 0 findings for billing; shop sandbox flag through R1. |
| I.6 new app | N/A | No new deployable. |
| II.1 thin controllers | PASS | zod pipes, one service call, mapper to DTO. |
| III.2/III.3 transactions | PASS | `TransactionRunner.run` only; no network I/O inside (provider and usage calls outside; outbox/job enqueue are the documented exceptions). |
| III.4 principal in predicate | PASS | Subscription/invoice queries put `(subjectType, subjectId)` in the predicate; `ShopScoped` for shops, session user for `/me`. |
| III.6/III.7 invariants & transitions | PASS | Price immutability trigger, unique live subscription, unique business key, `CHECK creditBalanceMinor >= 0`, conditional updates, history tables with append-only trigger. |
| III.8 money | PASS | `BIGINT`, `…Minor`, integer math, no float. |
| III.10 pagination | PASS | Keyset with opaque cursor and unique tiebreaker. |
| III.11 migrations | PASS | Expand migration (`lock_timeout`, batched idempotent data steps) + later contract migration. |
| III.12 timeouts/pools | PASS | See arithmetic above. |
| IV.3–IV.5 consumers/outbox | PASS | Inbox dedupe, zod validation, DLQ; events only through the outbox in the change's transaction. |
| IV.8 anti-corruption | PASS | `BillingGateway` port + Stripe adapter; no provider types leak into `application/`. |
| V.1/V.2/V.3/V.6 | PASS | Contracts schemas, stable `code`s, `Idempotency-Key` on both money-moving POSTs. |
| VII tests | PASS (planned) | `test-plan.md` followed one-to-one; Gate 9 faults forced (AS-20, 36, 37, 48, 51, 58, 85). |
| VIII.4–VIII.6 | PASS | Cooperative shutdown, validated config, UTC schedule with lease. |
| IX.4/IX.7 | PASS | R1 and event reactions only; R2 unused. |
| X.3/X.4 | PASS | Barrel exports modules, services, events and S18's unchanged items; models removed. |

**Justified deviations**: none. **Post-design re-check** (after `data-model.md` and `contracts/`): the design adds only billing-owned tables and the four technical-table uses (outbox, inbox, jobs, idempotency) through their libs, so still PASS. Two items are open risks that the plan names rather than hides: eventual consistency of provider search (research R-4) and the shape of the migration runner for batched steps (data-model § Migrations); both have a task that decides and records the answer.

## Phase 0/1 artifacts

- [research.md](research.md) — decisions R-1…R-14 and the dependency facts found while planning.
- [data-model.md](data-model.md) — tables, triggers, state machines, migrations.
- [contracts/](contracts/) — `http.md`, `events.md`, `jobs.md`.
- [quickstart.md](quickstart.md) — runnable validation and Ops artifacts.

## Project Structure

### Documentation

```text
specs/domains/S17-subscriptions/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/{http.md,events.md,jobs.md}
├── spec.md  test-plan.md  gaps.md  questions.md
└── tasks.md            # next command (/speckit-tasks)
```

### Source code

```text
packages/contracts/src/billing/
├── index.ts  catalog.ts  subscription.ts  invoice.ts  preview.ts  events.ts      # zod schemas (V.2)

packages/backend/libs/domains/billing/
├── billing.module.ts               # core: controllers + use cases + repositories (+ S18 providers unchanged)
├── billing-worker.module.ts        # jobs + schedule bootstrap, own providers (boots standalone, L-018)
├── billing-consumer.module.ts      # tenancy consumers (inbox), own providers
├── rate-limit-policies.ts          # billing.subscribe.subject, change, preview, payment-method, plans.ip
├── index.ts                        # modules, SubscriptionBasisService, UsageInvoiceLinesProvider token, events, policies, S18 exports unchanged
├── api/
│   ├── plans.controller.ts  admin-billing.controller.ts
│   ├── shop-subscription.controller.ts  buyer-subscription.controller.ts   # same service calls, two subject resolvers
│   ├── billing.dto.ts              # zod pipes from contracts (strict)
│   └── billing.mappers.ts          # model -> DTO, never exposes paymentMethodRef
├── application/
│   ├── catalog.service.ts          # plans, prices, retire
│   ├── subscribe.service.ts  change.service.ts (preview + change)  cancellation.service.ts  payment-method.service.ts
│   ├── renewal.service.ts          # run claim, per-subscription renewal, trial end, cancel at end, unpaid expiry
│   ├── charge.service.ts           # claim, provider call, settle, dunning
│   ├── attempt-resolution.service.ts
│   ├── subscription-basis.service.ts  # S18's basis reads
│   ├── invoice-query.service.ts    # keyset list + detail, subject in predicate
│   ├── tenancy-lifecycle.service.ts
│   ├── plan-tier.service.ts        # SubjectPlanState counter + event
│   ├── entitlements.service.ts  usage.service.ts   # S18's, untouched except import paths
│   └── events/billing-events.ts    # four defineEvent
├── domain/
│   ├── subscription-status.ts  invoice-status.ts  periods.ts  proration.ts  allocation.ts
│   ├── dunning-schedule.ts  charge-outcome.ts  money.ts  cursor.ts  tier.ts  errors.ts  metrics.ts
│   └── ports.ts                    # SUBSCRIPTION_REPOSITORY, INVOICE_REPOSITORY, CATALOG_REPOSITORY, PLAN_STATE_REPOSITORY, BILLING_GATEWAY, SHOP_DIRECTORY, USAGE_LINES_PROVIDER, ...
├── infra/
│   ├── models/*.model.ts           # owned tables only (+ the three new ones)
│   ├── *.repository.ts             # SQL lives here, bound parameters, UTC instants from the clock
│   ├── stripe-billing-gateway.ts   # adapter over StripeService (create, lookup, classification)
│   ├── shop-directory.adapter.ts   # ShopQueryService adapter
│   ├── usage-lines.adapter.ts      # UsageService -> UsageInvoiceLinesProvider (transitional until S18)
│   ├── billing.jobs.ts             # @JobHandler shells + schedule bootstrap
│   ├── tenancy.consumers.ts        # three consumers
│   └── usage.projector.ts          # S18's, untouched
├── domain/*.spec.ts                # six unit specs
└── {plans-catalog,subscribe,subscription-lifecycle,billing-run,invoice-charging,subscription-change,billing-reads-events,billing-ops}.e2e-spec.ts

packages/backend/libs/infrastructure/stripe/stripe.service.ts   # + findPaymentIntentByMetadataPair (research R-4)
packages/backend/migrations/
├── 2026101[6]…-billing-s17-expand.js
└── 2026101[6]…-billing-s17-contract.js
packages/backend/db/ownership.ts    # rows for new tables and functions
packages/backend/test/fixtures/billing/   # DS-1 builders, FS, provider double scripts
packages/backend/test/fakes/              # provider double at the Stripe HTTP edge (create, search)
scripts/bench/billing-run-10k.ts          # SC-001, SC-002 (performance job)
docs/spec/capabilities/S17-subscriptions.md   # living page (rule 0): does not exist yet; first behavior task creates it
docs/work/architecture/{domain-map.md,debt-register.md}   # D-6/D-7/D-8 update; "payments (charge command)" wording
```

**Structure Decision**: extend the existing domain in place (same `libs/domains/billing` path) and split by layer; no new package except the `billing` folder in `packages/contracts`. The old `billing.service.ts` and `billing.jobs.ts` logic is moved, not copied: each moved function lands in its use-case service and the originals shrink to wiring or are deleted.

## Gap-to-plan map (every gaps.md item has an owner)

| Gap | Resolved by |
|---|---|
| A1 | `api/billing.mappers.ts`, `packages/contracts/src/billing/*`, controllers split (R-13) |
| A2, A22, A23 | Expand migration (Price `version`/`trialDays`, triggers, checks, seeds), `catalog.service.ts`, admin controller |
| A3 | `subscribe.service.ts` (eligibility before tx, trial from price, once per subject, anchor = first paid period start, clock, `@Idempotent`, cache after commit) |
| A4, A20 | One transaction writes subscription + history + invoice + job + outbox (R-2); `plan-tier.service.ts`; new events (`contracts/events.md`) |
| A5, A6 | `domain/subscription-status.ts`, `domain/invoice-status.ts`, history tables, conditional updates (data-model) |
| A7, A17 | `cancellation.service.ts`, `change.service.ts` (409 codes, version guard in trial path, no-op refusal, idempotency, credit) |
| A8 | `renewal.service.ts` (R-5) incl. `UNPAID` expiry, delinquent handling, deferral, metrics |
| A9, A10 | Credit balance + business keys (data-model, FR-043/044); duplicate trigger returns the existing invoice |
| A11, A12, A13 | `charge.service.ts` + `attempt-resolution.service.ts` + `domain/dunning-schedule.ts` + `domain/charge-outcome.ts` (R-3, R-4) |
| A14 | `stripe-billing-gateway.ts` + `StripeService.findPaymentIntentByMetadataPair`; the shared client's createPaymentIntent already takes currency/timeout/metadata (S13); the remaining `is_load_test` branches in `stripe.service.ts` are not on billing's path and belong to S13/S14 |
| A15 | `payment-method.service.ts` + `billing.manual-attempt` |
| A16 | `domain/proration.ts`, `allocation.ts`, `periods.ts`, `money.ts` (R-6) with unit/property specs |
| A18 | `invoice-query.service.ts` + keyset index (data-model) |
| A19 | `tenancy.consumers.ts` + `tenancy-lifecycle.service.ts` (R-8) |
| A21 | `rate-limit-policies.ts` + `@RateLimit` on every route; `GET /plans` fail-open policy |
| A24 | Shutdown registry integration in jobs, metrics in `domain/metrics.ts` |
| A25, A28, D-7, D-8 | Barrel rewrite (R-12), `UsageInvoiceLinesProvider` adapter; S18 items left in place |
| A26 | Eight e2e files + six unit specs (rewrite of `billing.e2e-spec.ts`; the old file is deleted once its scenarios are covered, L-017: scenario list checked against `test-plan.md`) |
| A27 | Metadata contains `kind`, not `idempotencyKey`; S10 follow-up in `gaps.md` |
| B (D-6, D-7, D-8, D-14) | Layer split, barrel, no change for D-14 (S46/S18) |
| C (ownership) | `ShopDirectoryPort`, `ShopScoped`, consumers, registry rows, outbox/jobs exceptions |
| D (order of work) | `tasks.md` follows it: migration → pure domain → repositories/services → provider adapter → HTTP/contracts → events/consumers → tests rewrite and cleanup |

## Follow-ups from built specs (requirements of this plan)

- **S03**: no `ShopModel`, `ShopMembershipModel`, `MembershipService` or raw SQL on tenancy tables in billing (a grep task proves it; sandbox flag via `ShopQueryService.getShopsByIds`, shop access via `ShopScoped`; `ShopAccessService` / `MembershipQueryService` are used only if a use case needs member lookups, none does today). Retest `ShopScoped` write routes on suspended (`403 shop_suspended`) and offboarding (`409 shop_offboarding`) shops in `subscribe`/`subscription-lifecycle` e2e. `payouts.read` and `sso.manage` are not billing permissions: nothing to retest, recorded in the report.
- **S03**: `billing.subscription_plan_changed {shopId, plan, version}` with the per-shop monotonic version (R-10, AS-81).
- **S13**: billing sends no payments command; it charges through its own port and the thin Stripe client with the invoice's currency, no breaker, no load-test shortcut, `maxNetworkRetries: 0` (R-4). Sibling bullet: the domain-map line "payments (charge command)" should read "provider via infrastructure".
- **S28**: `billing.invoice_payment_failed` gains `reason`, `subjectType` is `USER|SHOP`, `billing.invoice_paid` exists; the schemas ship in `packages/contracts/src/billing/events.ts` and S28 switches its import (sibling bullet).
- **S54**: no direct `sequelize.transaction` in billing; none added (gate checked).

## Complexity Tracking

| Decision | Why | Simpler alternative rejected |
|---|---|---|
| Attempt claimed on the `Invoice` row (`attemptStartedAt`) in addition to the job's idempotency key | Two deliveries and a crash after the provider call must neither double-charge nor lose the attempt | The job key alone cannot tell a crashed claim from a finished one |
| `SubjectPlanState` table | Monotonic per-shop version across subscriptions under concurrency (S03 contract) | A column on `Subscription` resets per subscription and repeats versions |
| `creditBalanceMinor` on `Subscription` | Credit above the renewal total must not vanish (FR-044) | Negative open invoices lose the excess today |
| Store triggers for immutability | FR-004, FR-029, AS-05, AS-23, AS-39 require the store to refuse | Application checks cannot stop a privileged statement |
| Three modules | Each deployable must boot alone (L-018) | One module would pull controllers into the worker |
| New lib method for provider search by two metadata pairs | The existing lookup keys on `metadata.idempotencyKey`, which billing must not set (S10 mapping) | Adding `idempotencyKey` to billing's metadata would collide with the order webhook |
