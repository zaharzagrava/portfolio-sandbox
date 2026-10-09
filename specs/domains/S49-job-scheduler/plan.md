# Implementation Plan: S49 — Distributed job scheduler

**Branch**: `S49-job-scheduler` (working branch `sdd/auto`) | **Date**: 2026-10-09 | **Spec**: [spec.md](spec.md)

**Input**: spec.md (95 scenarios, FR-001–FR-060, SC-001–SC-009), test-plan.md, gaps.md (G-01–G-47 plus G-24b), questions.md (defaults accepted as written).

## Summary

The lib `packages/backend/libs/infrastructure/jobs` is a good draft of the core (`SKIP LOCKED` claim, partitioned `Job`, `JobKey`, advisory-lock materialiser). This plan hardens it to the spec: runtime-validated job types, a pure status machine, claim-identity fencing `(lockedBy, attempts)`, an atomic per-shop cap, fleet concurrency, a rewritten reaper, `maxRuntimeMs`, graceful release on shutdown, overlap policy and per-schedule isolation, DST-correct cron, catalog-resolved partition drop, retention of `JobKey`, full metrics, and `JobsAdminService`. Approach: keep SQL in the lib (it only touches its own three tables), split the three big services into small units behind the existing exported surface, inject the S54 `Clock` into every time comparison, and add all schema changes as one expand-only migration. The existing 35 domain files that declare job types only by module augmentation get a runtime `declareJobType` call (mechanical, BREAKING per questions.md).

## Technical Context

**Language/Version**: TypeScript strict, Node (repo version), NestJS 10, Sequelize + raw SQL via `@InjectConnection`.

**Primary Dependencies**: `cron` (kept only for 5/6-field parsing; fire computation goes to Luxon if research R-03 shows deviation), `luxon` (already in repo for P0104), `zod` (IV.5), `@opentelemetry/api` metrics (as today, via S54 meter names), S54: `Clock` (`@app/common/core/clock`, `FakeClock`), `TransactionRunner`, `RequestContextService.run`, `ShutdownRegistry`, `fullJitterBackoff`.

**Storage**: PostgreSQL. Tables `Job` (daily partitions by `createdAt`), `JobKey`, `JobSchedule`, owner `infrastructure:jobs`. One new migration (expand-only, `lock_timeout`).

**Testing**: Jest e2e against real Postgres through `scripts/sdd/test-spec.sh`; nine e2e files and seven unit specs listed in test-plan.md; replaces the 7-case `jobs.e2e-spec.ts`.

**Target Platform**: Linux containers; enqueue side in every app, execution side in `apps/worker`.

**Project Type**: backend infrastructure library (no HTTP routes; S01 hosts operator routes).

**Performance Goals**: 5k jobs/s claim+complete on the due partial index; materialise within 2 s of due; lag visible within 10 s (SC-002/006/007).

**Constraints**: no network I/O in claim/enqueue transactions; `statement_timeout` is already 30 s per connection (database module, S54 G-25), claim and materialiser add a `SET LOCAL statement_timeout` of 5 s; migrations set `lock_timeout 5s`.

**Scale/Scope**: 50M outstanding jobs, 30-day retention, ≤ 1,200 schedules due at once.

**Pool arithmetic (III.12, G-44)**: worker pool `db_pool_max` 10 per instance; each worker instance uses at most 1 connection for claim, 1 for the reaper/maintenance loop, 1 for the materialiser tick, up to `claimBatch`-independent 2 for completion/heartbeat writes (short statements), so ≤ 5 of 10 are held by jobs infra and handlers share the rest. Fleet bound: 20 worker instances × 10 = 200 plus API apps, below the database limit documented in the S54 plan; the figure is asserted in `jobs.config` validation (claim batch ≤ pool max × 10).

## Constitution Check

| Rule | Status | How |
|---|---|---|
| I.1/I.4 layering | pass, noted | The lib stays flat (G-47 allows it); SQL moves into small `*.sql.ts`/repository classes inside the lib only if a file passes 300 lines. No domain import. |
| III.2 transactions | pass | `JobMaintenance` materialiser opens `sequelize.transaction` at `job-maintenance.service.ts:76`: migrate to `TransactionRunner.run` and delete its `// S54 T037 audit` marker (count of direct sites in the domain must fall to 0). No new direct sites. |
| III.3 no network I/O in tx | pass | handlers run outside claim transaction; metrics are in-process. |
| III.4 tenant predicate | pass | `cancel`/`cancelByKey`/`JobsAdminService.cancel` take `shopId` in the predicate (G-08). |
| III.5 parameterised SQL | fix | G-24: partition drop moves into SQL function `job_drop_expired_partitions` (catalog-resolved). |
| III.6 invariants by the store | fix | per-shop cap via per-shop advisory xact lock + window over candidates (G-24b); `fleetConcurrency` in the claim; key uniqueness by `JobKey` PK. |
| III.7 conditional transitions + history | pass with deviation | conditional updates via `job-state.ts`; **no history table** (IX.3 allowlist is closed, doubles writes) — see Complexity Tracking. |
| III.10 keyset | pass | `listJobs` ordered `(createdAt DESC, id DESC)`, opaque HMAC-free base64url cursor with checksum. |
| III.11 migrations | pass | one expand-only migration, `lock_timeout`, concurrently-built indexes outside the tx where required. |
| III.12 timeouts | pass | see Constraints. |
| IV.5 zod | pass | payload contracts, config, admin filters. |
| VII.1–VII.8 testing | pass | as test-plan.md; every success criterion without a test goes to UNVERIFIED. |
| VIII.1 logs | pass | structured pino fields, never payloads (G-23). |
| VIII.6 once per schedule | pass | advisory-lock leader + `JobKey` dedupe. |
| IX.4/IX.6 ownership | fix | G-45 verify registry; three foreign specs stop querying `"Job"` (Sibling follow-ups). |
| X.5 boundaries | pass | `check:boundaries` stays green; lib imports nothing from domains. |

**Gate result**: no unjustified violation. One justified deviation (III.7 history). Re-checked after Phase 1 design: unchanged.

## Phase map (implementation order, each step ends green)

1. **P0 Foundations** (no behaviour change): `job-state.ts` (pure transition fn, `assertNever`), error classes, `job-type-registry.ts` (`declareJobType`, zod), `enqueue-options.ts` validators, `job-cursor.ts`, config keys, clock injection. Units: `job-state`, `enqueue-options`, `handler-options`, `job-cursor`, `backoff`.
2. **P1 Migration** `<ts>-jobs-hardening.js`: see [data-model.md](data-model.md).
3. **P2 Enqueue** (G-01..G-08, G-10): validation, type conflict, purge-race retry, no-tx path, request id/trace capture, `cancel`/`cancelByKey` discriminated. ENQ, STATE (cancel part).
4. **P3 Worker** (G-11..G-23, G-24b, G-20, G-21): claim with per-type lease and fleet concurrency and shop slots, fencing, lease-lost, `maxRuntimeMs`, completion retry, release on shutdown (25 s), structured logs, validated config. RUN, LEASE, FAIR.
5. **P4 Reaper and maintenance** (G-24, G-25, G-26, G-34): reaper rewrite, partition SQL function, `JobKey` purge, default-partition metric. RET, LEASE.
6. **P5 Schedules** (G-28..G-33): columns, overlap, savepoint isolation, auto-disable, `removeSchedule`, enable from now, `InvalidScheduleError`, TransactionRunner migration. CRON.
7. **P6 Cron math** (G-37, G-38): [research R-03]. `cron.spec.ts`, `schedule-validation.spec.ts`.
8. **P7 Registry** (G-39..G-42): duplicate-provider failure, option validation, separate declaration. REG.
9. **P8 Admin and observability** (G-09, G-35, G-36): `JobsAdminService`, full metric set, lag every tick per type. OBS.
10. **P9 Boundaries and rollout** (G-43, G-45, G-46, follow-ups): declare the 35 existing domain types, replace direct SQL in three foreign specs, S54 purge follow-up check, `CronModule` import in identity, ownership checks, old `jobs.e2e-spec.ts` retired once its 7 cases are covered.

## Follow-up from S54 (IdempotencyPurgeService)

`apps/worker/src/worker.module.ts` already imports `IdempotencyModule` (verified in this run), so `platform.purge-idempotency-keys` is discovered by the worker. S49 still must (a) declare the type `platform.purge-idempotency-keys` (and `outbox.purge-published`, `inbox.purge`) with a `declareJobType` call, otherwise the new `UnknownJobTypeError`/`InvalidScheduleError` makes their boot-time `upsertSchedule` fail; (b) add a REG e2e case that boots `JobsWorkerModule` + `IdempotencyModule` and asserts the handler is registered and the 15-minute schedule row exists. Both are tasks in P7/P9.

## Project Structure

### Documentation (this feature)

```text
specs/domains/S49-job-scheduler/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/jobs-service.md  contracts/jobs-admin-service.md
└── tasks.md   # /speckit-tasks
```

### Source Code

```text
packages/backend/
├── migrations/<ts>-jobs-hardening.js                 # new, expand-only
├── db/ownership.ts                                   # verify only
├── libs/infrastructure/jobs/
│   ├── job-state.ts (+ .spec)            # pure transitions, assertNever
│   ├── job-errors.ts                     # 4 enqueue errors, InvalidScheduleError, InvalidCursorError
│   ├── job-type-registry.ts              # declareJobType, zod contracts, defaults
│   ├── enqueue-options.ts (+ .spec)      # limits
│   ├── job-cursor.ts (+ .spec)
│   ├── schedule-validation.ts (+ .spec)
│   ├── handler-options.ts (+ .spec)
│   ├── cron.ts (+ .spec)                 # pure, base instant is a parameter
│   ├── jobs.service.ts                   # enqueue, cancel, cancelByKey, upsert/removeSchedule
│   ├── jobs-admin.service.ts             # list/stats/retry/cancel/schedules
│   ├── job-worker.service.ts             # claim loop, execution, fencing
│   ├── job-claim.sql.ts                  # claim statement and shop slots
│   ├── job-reaper.service.ts             # split from maintenance
│   ├── job-maintenance.service.ts        # materialiser + partition maintenance
│   ├── job-metrics.ts                    # FR-052 instruments
│   ├── job-registry.service.ts, job-handler.decorator.ts, job-types.ts
│   ├── index.ts                          # exports (R1)
│   └── jobs-*.e2e-spec.ts (9)            # ENQ RUN LEASE STATE FAIR CRON OBS RET REG
└── libs/domains/**/infra/*.jobs.ts       # P9: declareJobType next to each augmentation
```

**Structure Decision**: stay inside the existing lib; no new project or module. Files above 300 lines are split by responsibility (worker / claim SQL / reaper / metrics).

## Gap coverage

Every gaps.md item is mapped to a phase in the phase map (G-01–G-47 and G-24b). Constitution-debt rows: none open for S49; D-12 handled by the three foreign-spec replacements; `check:table-ownership` and `--strict` are run in P9 and their `jobs` lines recorded in the report; G-24 is the only expected hit before the fix.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| III.7: no per-transition history row | Job tables are an allowlisted technical set (IX.3 closed); history doubles the ~2 writes per job; row keeps `attempts`, `lastError`, `finishedAt`, plus metrics and structured logs | A history table needs a constitution amendment and halves throughput at 5k jobs/s |
| Per-shop advisory lock in the claim | strict fleet-wide cap (III.6) | `NOT IN` count is check-then-write; a counter row adds a hot row per shop |

## Decisions recorded during implementation

- **G-47 (T062)**: `jobs.service.ts` SQL touches only `"Job"`, `"JobKey"` and `"JobSchedule"` (checked by reading every statement). The lib stays flat; no repository layer. The materialiser, reaper and claim SQL live in their own services and `job-claim.sql.ts`.
- **III.2 outcome**: `libs/infrastructure/jobs` has no direct `sequelize.transaction` and no `// S54 T037 audit` marker left; the claim and the materialiser use `TransactionRunner.run` with `requires_new` and a 5 s statement timeout.
- **III.7 deviation** unchanged (no history table).
