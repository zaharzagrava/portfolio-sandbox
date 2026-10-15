# Implementation Plan: S18 — Usage Metering and Entitlement Checks (domain `billing`)

**Branch**: `S18-usage-entitlements` (working branch `sdd/auto`) | **Date**: 2026-10-15 | **Spec**: [spec.md](spec.md)

**Inputs**: `spec.md` (57 scenarios), `test-plan.md` (7 e2e files + 3 unit specs), `gaps.md` (G1–G25, D-6/7/8/14), `questions.md` (defaults accepted; no human edits found), constitution v3.1.0, and the follow-ups from built specs (table below; each is a requirement).

## Summary

Take over `EntitlementsService`, `UsageService`, `ShopEntitlementGuard` and `UsageProjector` from the transitional S17/S21/S46 shims and build them as the spec describes:

- **Entitlements.** Pure `domain/entitlements.ts` (key allowlist, free tiers, `hasEntitlement`, `checkLimit`, quota map). `EntitlementsService` gains `getMany`, `hasEntitlement`, `checkLimit`; `checkQuota` stays and is hardened. It loads only through S17's `SubscriptionBasisService` (`getLiveBasis` / `getLiveBasisBySubjectIds`).
- **Cache.** Behind an `EntitlementCachePort`; the adapter uses the S52 `CacheService` (`getOrLoad` with `staleIfErrorMs` 60 min, `versionOf`, single flight; the `invalidate` result is checked, `l2: 'failed'` rejects; `invalidateIfOlder` for versioned events). A load that began before a newer invalidation never stores.
- **Consumers (R3).** Three `Projector`s in `BillingConsumerModule` with schema validation, identity de-dup, `PermanentError(reason)` → DLQ and metrics: `usage.recorded`, `llm.call_completed`, `billing.subscription_status_changed`. `UsageService.record` and its fire-and-forget Kafka produce are deleted.
- **Usage store.** `UsageStorePort` in `domain/`; ClickHouse adapter in `infra/` with exact de-duplicating totals, 5 s timeout, `DateTime64` parameter formatting without `.replace('Z','')`, and a synchronous insert that rejects on failure (new `insert` on the ClickHouse infra client; today it only has `query`).
- **Settlement.** New table `UsageSettlement` (ledger). Pure `domain/usage-overage.ts` and `domain/usage-adjustment.ts`. `UsageLinesService` implements S17's `UsageInvoiceLinesProvider` (extended with `settlement`); `UsageSettlementService.settle` runs in S17's invoice transaction with conditional updates bound to `fromQuantity`.
- **Read API.** `GET /shops/:shopId/usage`, `GET /me/usage`, `usageSummarySchema` in contracts, policy `billing.usage-read.subject`.
- **Ops.** Job `billing.usage-reconcile` (daily 03:15 UTC, report only), migration with backfill, metrics, startup validation of the guard.
- **Boundaries.** Barrel exports only contracted items; `BillingModule` is no longer `@Global`; ports in `domain/`, adapters in `infra/`.

## Technical Context

**Language/Version**: TypeScript strict, Node 22, NestJS monorepo (`packages/backend`, `packages/contracts`).

**Primary Dependencies**: `@nestjs/sequelize` (SQL only in `infra/`); S54 `TransactionRunner`, `CLOCK`, problem+json, metrics, shutdown; S49 `declareJobType`, `@JobHandler`, `upsertSchedule`; S53 `Projector`, `InboxService`, `PermanentError`; S52 `CacheService`; S50 `definePolicies`/`RateLimit`; S03 `ShopScoped`; S01 `Firewall`, `@User()`; `ClickHouseService`; `fast-check`; `supertest`.

**Storage**: PostgreSQL (new `UsageSettlement`, `domain:billing`); ClickHouse `usage_events` (existing; `event_id` is a free string so `llm:<id>` needs no change); Redis only through `CacheService`.

**Testing**: the 7 e2e files and 3 unit specs of `test-plan.md`, run through `/opt/sdd/repo/scripts/sdd/test-spec.sh`. The stubs of `UsageService` in `billing.e2e-spec.ts` are replaced (G23; scenarios survive, files may not, L-017). Fakes only at edges: clock, S03 R1 answers, a controllable basis source in cache tests, fault injection for VII.9 paths.

**Target Platform**: `apps/core` (`BillingModule`), `apps/worker` (`BillingWorkerModule`), `apps/projector` (`BillingConsumerModule`). No new deployable (I.6).

**Project Type**: backend domain capability + contracts package; no UI.

**Performance Goals**: cached check p99 < 20 ms (SC-006); `linesFor` ≤ 5 s; usage visible ≤ 30 s (SC-004).

**Constraints**: injected clock only; explicit timeouts; integer money; `tables(q) ⊆ owned(billing)`; expand-only migration with `lock_timeout`; **0 direct `sequelize.transaction`** in billing (grep: none today, no `// S54 T037 audit` comments to migrate); no payment data in logs.

**Scale/Scope**: ≤ 500 ids per batch; ledger rows ≤ metrics × periods × subscriptions; usage events unbounded (analytical store).

## Constitution Check

| Gate | Result |
|---|---|
| I.2 layering (D-6) | Fixed by this plan: `domain/` ports (`UsageStorePort`, `SettlementRepository`, `EntitlementCachePort`); `infra/` adapters; application imports no model, Kafka, ClickHouse client or Sequelize connection. |
| III transactions | `settle` joins the caller's `TransactionRunner` context (S17's invoice transaction); consumers use `runner.run`; concurrency by conditional update `WHERE settledQuantity = :fromQuantity` (III.6). 0 new direct sites. |
| IV events (IV.5) | Three consumers validated, idempotent, DLQ; usage enters only by events. |
| V contracts | problem+json with stable `code`; `usageSummarySchema`; GET only. |
| VII testing | One row per AS in `test-plan.md`; VII.9 degradation paths forced (AS-11, 19, 20, 30, 44, 54); duplicate and invalid-payload tests per consumer. |
| VIII ops | FR-040 metrics, consumer shutdown drain, single-run job. |
| IX ownership | `UsageSettlement` registered `domain:billing`; basis via same-domain R1; usage via R3; R2 unused. D-7, D-8, D-14 closed. |
| X.4 entry point | Barrel trimmed; `@Global` removed. |

No violation to justify. Post-design re-check: unchanged (no cross-domain access added; the one S17 edit is a same-domain call).

## Follow-ups from built specs (each is a requirement)

| From | Requirement | Planned in |
|---|---|---|
| S05 | `checkLimit('SHOP', id, 'maxProducts', n)` exported; S05 does not enforce | B; sibling bullet |
| S17 | `linesFor` ≤ 5 s throwing, replacing `UsageServiceLinesAdapter`; consume `billing.subscription_status_changed` by `subscriptionVersion`; load via `SubscriptionBasisService`; take over the four classes and their barrel exports | B, C, D, G |
| S21 | Keep `403 entitlement_required {feature}` and `Domain_EntitlementRequiredError`; add `503 entitlements_unavailable` and startup checks; `auction-schedule.e2e-spec.ts` AS-03 stays green | B |
| S38 | Callers put `plan` into `EvalContext`; S18 never exposes a plan code (spec: plans are never named). Nothing to build; recorded as a sibling bullet | gaps.md |
| S42 | `checkQuota('SHOP', id, 'apiCallsPerMonth')` → `{allowed, used, limit, resetsAt}`, rejecting `usage_unavailable`; consume `usage.recorded` `api.calls` with deterministic `eventId` | B, C; sibling bullet |
| S46 | Consume `llm.call_completed` (identity `llm:<aggregateId>`, `billableTokens`, `subjectId`, `metric`); producer is `@app/infrastructure/llm` | C |
| S46 | `assistantTokensPerMonth` answered for every buyer: keep `FREE_BUYER = {assistantTokensPerMonth: 200_000}`; `checkQuota` rejects `usage_unavailable` | A (research R-2: overrides DS-1 `{}`) |
| S47 | Accept `llm.call_completed` `metric: llm.rag.tokens`, `subjectId: "anonymous"`, outcomes `failed|refused|aborted` as platform cost, no allowance | C (R-3) |
| S49 | `declareJobType` with payload contract for `billing.usage-reconcile`; handle `InvalidScheduleError` | F |
| S52 | `await` the `invalidate` result, reject on `l2: 'failed'`; adopt `invalidateIfOlder` with `versionOf` | B |

## Project Structure

### Documentation (this feature)

```text
specs/domains/S18-usage-entitlements/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/ {http.md, events.md, jobs.md, ports.md}
└── tasks.md            # /speckit-tasks
```

### Source Code (repository root)

```text
packages/backend/libs/domains/billing/
├── domain/       entitlements.ts, usage-overage.ts, usage-adjustment.ts, usage-period.ts, usage-validation.ts,
│                 ports.ts (+ UsageStorePort, SettlementRepository, EntitlementCachePort; UsageInvoiceLinesProvider extended),
│                 errors.ts (+ the S18 codes), entitlements.spec.ts, usage-overage.spec.ts, usage-adjustment.spec.ts
├── application/  entitlements.service.ts (rewritten), entitlement.guard.ts (guard + startup validator),
│                 usage-lines.service.ts, usage-settlement.service.ts, usage-read.service.ts,
│                 usage-reconcile.service.ts            [usage.service.ts deleted]
├── api/          usage.controller.ts (shop + me), usage.mappers.ts
├── infra/        clickhouse-usage.store.ts, usage-settlement.repository.ts, models/usage-settlement.model.ts,
│                 entitlement-cache.adapter.ts, usage.consumers.ts, usage-reconcile.job.ts
│                 [usage.projector.ts, usage-lines.adapter.ts deleted]
├── billing-core.module.ts, billing.module.ts (no @Global), billing-consumer.module.ts, billing-worker.module.ts
├── rate-limit-policies.ts (+ billing.usage-read.subject), index.ts (trimmed)
└── entitlements / entitlements-cache / usage-ingestion / usage-invoice-lines / usage-migration / usage-read /
    billing-observability  *.e2e-spec.ts
packages/backend/db/                       migration (UsageSettlement + backfill), ownership.ts entry
packages/backend/libs/infrastructure/clickhouse/   synchronous `insert`
packages/contracts/src/billing/usage.ts    usageSummarySchema
docs/spec/capabilities/S18-usage-entitlements.md   created in the first behavior task (rule 0)
```

**Structure Decision**: extend the existing billing layout as S17 did; no new package or app.

## Phases (details become tasks.md)

- **A. Pure domain** (G1–G3, G14, G16): entitlements, overage, adjustment planner, validation, period attribution; unit and `fast-check` specs. The live-spec page is created first.
- **B. Ports, adapters, entitlement service** (G11–G15, G21, G24): usage store, cache adapter, rewritten service, guard with `503` and startup validation, `getMany` via `getLiveBasisBySubjectIds`.
- **C. Consumers** (G5, G7–G10): three projectors; delete `UsageService.record`, the old projector and adapter.
- **D. Migration and settlement** (G1–G4, G18, G19): table, ownership entry, backfill, `UsageLinesService`, `UsageSettlementService`, and the S17 edit in `renewal.service.ts` (same domain): pass `settlement` through and call `settle` inside the invoice transaction.
- **E. Read API** (G17): controller, contracts schema, rate-limit policy.
- **F. Reconciliation, metrics, job type** (G18, G20).
- **G. Boundaries** (G6, G25, D-7/D-8/D-14): barrel, modules, drop the `UsageService` provider from the assistant, knowledge and onboarding modules.
- **H. Verification**: replace `billing.e2e-spec.ts` stubs; narrow runs per file, then `test-spec.sh libs/domains/billing` once; `auctions`, `assistant`, `developer-platform` suites; static gates; boot `apps/core`, `apps/worker`, `apps/projector` each alone; `scripts/qa/fresh-run.sh`.

## Known-failure classes checked

- L-018/L-015/L-004: phase H boots each app alone; the consumers live in `BillingConsumerModule`, which imports what it injects.
- L-001/L-002/L-020: no new queue; the Kafka topics (`usage.events`, `llm.events`, `billing.events`) already exist, a task verifies the names.
- L-011: `UsageSettlement` comes from a migration present in the test stack; compare with the doctor.
- L-003: exact values from the spec, no "A or B" assertions.
- L-017: the AS→test mapping in `test-plan.md` is the checklist when `billing.e2e-spec.ts` is split.
- L-013: fault-injection tests restore what they break.
- L-006/L-008: each e2e creates its own subjects; suites run in batches of fresh processes.

## Complexity Tracking

None.
