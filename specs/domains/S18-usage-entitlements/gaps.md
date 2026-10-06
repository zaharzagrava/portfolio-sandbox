# Gaps: S18 — Usage Metering and Entitlement Checks (domain `billing`)

What the current code gets wrong or lacks versus [`spec.md`](spec.md). This is the implementation agent's to-do list. Paths are under `packages/backend/libs/domains/` unless noted. S17's gaps (renewal, invoices, state machine) are in `specs/domains/S17-subscriptions/gaps.md` and are not repeated; where S18 needs an S17 change it is marked **needs S17**.

## A. Code versus spec

| # | Gap | Where | Spec |
|---|---|---|---|
| G1 | No settlement ledger. Late events are found by `ingested_at > previous invoice's usageMeasuredAt` and only for the single previous renewal invoice, so an event arriving after the *next* invoice measured is never billed and a period may be examined twice. | `billing/infra/billing.jobs.ts:92-110`, `billing/application/usage.service.ts:44-60` | FR-026 to FR-028, AS-37 to AS-43 |
| G2 | Late units priced entirely at the overage rate, ignoring the allowance, with a started block per adjustment. | `billing/infra/billing.jobs.ts:106` | FR-027, AS-39, AS-40 |
| G3 | Adjustments use today's price (`subscription.price.overagePer1000`), not the terms of the period. | `billing/infra/billing.jobs.ts:96-106` | FR-026, AS-41 |
| G4 | Usage lines are built inside the billing job from `UsageService` directly; no lines provider, no settlement plan, usage is measured at `new Date()`. | `billing/infra/billing.jobs.ts:70-77, 92-110` | FR-023, AS-32, AS-44, AS-45; **needs S17** (call `linesFor` before and `settle` inside the invoice transaction) |
| G5 | `UsageService.record` is a fire-and-forget Kafka produce that logs and drops the event on error, and is part of the public barrel, so other domains write usage by calling billing. | `billing/application/usage.service.ts:30-33`, `billing/index.ts:16`, `assistant/infra/llm/llm-meter.ts:54` | FR-016, AS-30 |
| G6 | `UsageService` is re-provided inside other modules, so billing's class is constructed by assistant, knowledge and onboarding with their own wiring. | `assistant/assistant.module.ts:32`, `assistant/knowledge.module.ts:39`, `seller-onboarding/onboarding.module.ts:34` | FR-016, AS-56 |
| G7 | The usage projector is not a validated, idempotent consumer: it filters invalid events silently (`UsageRecorded.match` null), has no inbox or identity check beyond the store's merge, no DLQ, no reasons, no metrics. | `billing/infra/usage.projector.ts:19-25` | FR-015 pattern, FR-017, FR-018, FR-021, AS-28, AS-29 |
| G8 | No input validation of usage: any metric string, any positive integer, any `ts` (past or future), `ts` stripped with `.replace('Z', '')`. | `billing/application/usage.service.ts:11-15`, `billing/infra/usage.projector.ts:24` | FR-018, AS-28 |
| G9 | No consumer for `llm.call_completed` into usage; llm-meter records `Math.max(1, tokens)` so a zero-token call bills one unit. The event also lacks `subjectId`, `metric`, `billableTokens`. | `assistant/infra/llm/llm-meter.ts:39-55`, `assistant/application/events/assistant-events.ts:5-20` | FR-016, FR-022, AS-27; **needs S46** |
| G10 | No consumer of `billing.subscription_status_changed`; invalidation is only the direct call after commit; the event has no `subscriptionVersion` or `planCode`. | `billing/application/events/billing-events.ts:10-16`, `billing/infra/billing.jobs.ts:159` | FR-011, AS-15, AS-16; **needs S17** (event shape) |
| G11 | Entitlement loader reads `Subscription ⋈ Price ⋈ Plan` with raw SQL instead of S17's basis service; no batch read. | `billing/application/entitlements.service.ts:29-37` | FR-007, FR-004, AS-06 |
| G12 | Cache has no version guard, no single-flight, no stale-on-error, no invalidation-race protection; `loaded ?? {}` turns a failed or empty load into "no features". | `billing/application/entitlements.service.ts:27-44` | FR-009 to FR-014, AS-12 to AS-21 |
| G13 | `invalidate` delegates to the cache and any failure surfaces unpredictably; callers in `BillingService` and `BillingJobs` do not handle it. | `billing/application/entitlements.service.ts:43-45`, `billing/application/billing.service.ts:69, 95, 111` | FR-014, AS-20 |
| G14 | Missing exports: `hasEntitlement`, `getMany`, `checkLimit`, `checkQuota`; no allowlist of keys, unknown keys are not rejected. | `billing/application/entitlements.service.ts` (absent), `billing/index.ts` | FR-002 to FR-006, AS-03 to AS-08 |
| G15 | Guard: `403` with a plain message, `403` when there is no shop context, boolean truthiness only, no `503` when the source is down, misconfiguration only detected at runtime. | `billing/application/entitlements.service.ts:56-72` | FR-008, AS-09 to AS-11 |
| G16 | Free-tier constants and entitlement types live in infra/model files (`Entitlements` in `plan.model.ts`), mixed with the application service. | `billing/application/entitlements.service.ts:8-10`, `billing/infra/models/plan.model.ts:4-12` | FR-002 (move to `domain/`) |
| G17 | No usage read routes, no contracts schema `usageSummarySchema`, no rate-limit policy `billing.usage-read.subject`. | `billing/api/billing.controller.ts` (absent) | FR-034 to FR-037, AS-49 to AS-55 |
| G18 | No reconciliation job and no drift metric; no ledger to reconcile. | absent | FR-031, AS-47 |
| G19 | No migration of existing invoices into ledger rows; no ownership-registry entry for the ledger table. | absent | FR-032, FR-042, AS-48 |
| G20 | No metrics for usage or entitlements. | absent | FR-040, AS-57 |
| G21 | The usage store query helpers build `from/to` strings with `.replace('Z', '')` and have no timeout; a slow store blocks the renewal run. | `billing/application/usage.service.ts:35-60` | FR-023 (5 s), AS-44 |
| G22 | The `usage_hourly` rollup and view have no reader. | `packages/backend/clickhouse/010_usage_events.sql:22-35` | LOCAL question (keep or drop) |
| G23 | Existing e2e stubs `UsageService.totalFor/lateFor` and calls services directly; no HTTP, no usage, no cache, no consumer coverage. | `billing/billing.e2e-spec.ts:27, 62-63` | VII.2, VII.4; test plan files |
| G24 | Layering: `application/entitlements.service.ts` imports `infra/models/plan.model` and the cache and `Sequelize` connection directly; `application/usage.service.ts` imports Kafka and ClickHouse infra clients. | `billing/application/entitlements.service.ts:5-6`, `billing/application/usage.service.ts:4-5` | I.2 (debt D-6): ports in `domain/`, adapters in `infra/` |
| G25 | `BillingModule` is `@Global` and exports `BillingService`, `UsageService`, the guard, so any module can inject them without importing. | `billing/billing.module.ts:23-27` | FR-042, X.4 |

## B. Open debt-register rows naming `billing` (or applying to it)

Source: `docs/architecture/debt-register.md`. The only open row that names billing is D-14; D-6, D-7, D-8 apply to every domain and are listed because billing exhibits them (same reading as S17).

| Debt | What in billing | Mechanism that replaces it |
|---|---|---|
| D-14 (X.3, X.7) | `llm-meter` calls billing's `UsageService.record` directly (`assistant/infra/llm/llm-meter.ts:3, 54`), and the assistant, knowledge and onboarding modules re-provide it (`assistant.module.ts:10, 32`, `knowledge.module.ts:10, 39`, `onboarding.module.ts:9, 34`). | **R3**: S46 publishes `llm.call_completed` (extended additively); S18 consumes it into the billing-owned usage store. No R1 call. Remove `UsageService` from the barrel and from those three modules' `providers`. |
| D-6 (I.2) | G24: application services import infra models, Kafka and ClickHouse clients, the Sequelize connection. | Repository and store ports in `domain/` (injection tokens); Sequelize, cache and ClickHouse adapters in `infra/`. No cross-domain mechanism. |
| D-7 (IX.4) | `index.ts:7-11` exports the five billing models. No other domain imports them (grep over `packages/backend/libs` finds only billing's own files). | Remove the model exports. Other domains use the R1 `EntitlementsService` and the events. |
| D-8 (X.4) | `index.ts:14-17` exports `UsageProjector`, `UsageService`, `BillingWorkerModule`. | Apps import `BillingWorkerModule` (hosting the consumers); the projector class and `UsageService` leave the barrel. |

## C. `pnpm --dir packages/backend check:table-ownership` lines for `billing`

The command needs approval in this session and was **not run**; the facts below come from code search plus the recorded S17 run (87 findings in 21 domains, 0 for billing as accessor, 0 with `owned by billing`).

- **Billing as the accessing domain: 0 Postgres findings.** The entitlement loader's `SELECT … FROM "Subscription" JOIN "Price" JOIN "Plan"` (`billing/application/entitlements.service.ts:30-34`) touches only billing-owned tables. **Mechanism going forward:** it moves behind S17's exported `SubscriptionBasisService` (same domain, R1-style batch export), so S18 holds no query on S17's tables at all.
- **The usage store (`usage_events`) is not Postgres**, so the check does not see it. It is billing's own store (domain map: usage in ClickHouse). Its readers are only `UsageService` today; after S18 only billing reads it. No cross-domain mechanism needed; **R3** is how data arrives (events).
- **Another domain accessing a billing table: 0 findings.** Other domains reach billing only through the barrel (`EntitlementsService`, `RequiresShopEntitlement`, `UsageService`, `InvoicePaymentFailed`); after S18 `UsageService` is gone (replaced by events, **R3**) and the rest are **R1** exports.
- **D-12 for billing: none.**
- **To add so `--strict` stays at 0:** register the new ledger table (`UsageSettlement`) in `packages/backend/db/ownership.ts` as `domain:billing` in the migration PR; consumers use the inbox and the DLQ only through the infrastructure libs' exported services (IX.6).

## D. Suggested order of work

1. **Pure domain** (`domain/`): entitlement keys and free tiers, `hasEntitlement`, `checkLimit`, quota-key map; block overage price; adjustment planner (snapshot, delta, advance without a line); period attribution; their table-driven and `fast-check` tests (G1–G3, G14, G16; AS-03–AS-07, AS-25, AS-33–AS-36, AS-39–AS-41).
2. **Migration** (expand-only, `lock_timeout`): ledger table, unique `(subscriptionId, periodStart, metric)`, check constraints for forward-only values, ownership registry entry, backfill (G18, G19; AS-48).
3. **Ports and adapters**: usage store port (exact totals with timeout, durable insert), ledger repository, entitlement cache port (version guard, single-flight, stale-on-error) (G11–G13, G21, G24).
4. **Consumers**: `usage.recorded`, `llm.call_completed`, `billing.subscription_status_changed` with schema validation, identity de-dup, DLQ, metrics (G7–G10; AS-15–AS-31). Coordinate **needs S46** (event fields) and **needs S17** (event shape).
5. **Provider and settlement**: `UsageInvoiceLinesProvider.linesFor`, `UsageSettlementService.settle`; **needs S17** to call them in its renewal (G1, G4; AS-32, AS-37–AS-47).
6. **Entitlement service and guard**: new exports, 503/403 semantics, startup validation (G14, G15; AS-01–AS-11).
7. **Usage read routes**, contracts schema, rate-limit policy (G17; AS-49–AS-55).
8. **Reconciliation job** and metrics (G18, G20; AS-47, AS-57).
9. **Barrel and modules**: remove model, projector, `UsageService` exports and the `@Global`; fix the three modules that re-provide `UsageService` (G5, G6, G25; AS-56).
10. **Tests**: replace `billing.e2e-spec.ts` stubs with the files in `test-plan.md` and record a green run (G23).
