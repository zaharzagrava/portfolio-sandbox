---
description: "Tasks for S49 distributed job scheduler"
---

# Tasks: S49 — Distributed job scheduler

**Input**: spec.md, plan.md, research.md (R-01–R-10), data-model.md, contracts/, test-plan.md, gaps.md (G-01–G-47, G-24b), questions.md (defaults accepted).
**Tests**: required (test-plan.md). Every test task comes before the code task it drives and must fail first.
**Base path**: `JL` = `packages/backend/libs/infrastructure/jobs`. Run backend commands from `packages/backend`. E2E: `/opt/sdd/repo/scripts/sdd/test-spec.sh <path>`. Unit: `pnpm jest <path>`.
**Rules**: no git checkout/restore/reset/stash/clean (undo by hand-editing); no new `sequelize.transaction` (use `TransactionRunner.run`); no payloads in logs; time only via the injected S54 `Clock`; SC without automated proof stays in quickstart "Ops artifacts" and `specs/UNVERIFIED.md` (already has SC-002/006/007 and AS-88/89 rows, status `not run`; never mark verified).
**E2E files**: each file's top-level `describe` names its feature, boots real `JobsModule`/`JobsWorkerModule` against real Postgres, truncates job tables first, freezes time with `FakeClock`, and asserts return value and persisted state.

## Phase 1: Setup

- [X] T001 Run baseline from `packages/backend`: `pnpm exec tsc --noEmit`, `pnpm check:boundaries`, `pnpm check:table-ownership --strict`, `grep -rn "sequelize.transaction" libs/infrastructure/jobs`; record the `jobs` lines and the direct-transaction count in a note at the end of `specs/domains/S49-job-scheduler/quickstart.md` (G-45; G-24 is the expected hit)
- [X] T002 [P] Add config keys `jobs.claimBatch` (50), `jobs.perShopRunningCap` (5), `jobs.retainDays` (30), `jobs.pollIdleMs` (500) to the S54 zod config schema (locate with `grep -rn "jobs\." packages/backend/libs/infrastructure/config`); validate claimBatch ≤ pool max × 10 (G-22, R-09)
- [X] T003 [P] Inject S54 `Clock` (`@app/common/core/clock`) into `JL/jobs.service.ts`, `JL/job-worker.service.ts`, `JL/job-maintenance.service.ts`: every `now()`/`new Date()` becomes a `:now` parameter from the clock; `pnpm check:no-wallclock` must pass for JL (G-46)

## Phase 2: Foundational (blocks all stories)

- [X] T004 [P] Write failing `JL/job-state.spec.ts`: table of legal transitions from data-model.md (QUEUED→RUNNING→SUCCEEDED, RUNNING→QUEUED|DEAD, QUEUED→CANCELLED, DEAD→QUEUED) with every illegal one rejected; `assertNever` table over every status (AS-38, AS-95, G-10, G-42)
- [X] T005 [P] Write failing `JL/enqueue-options.spec.ts` with `it.each`: payload ≤ 64 KiB serialised; key 1–200 chars; `maxAttempts` 1–25 (default order: option, schedule, type default, 8); `runAt` valid date ≤ now + 366 d, past allowed; plus `expectTypeOf` on `JobPayloads` (AS-07, AS-93, G-02)
- [X] T006 [P] Write failing `JL/job-cursor.spec.ts`: base64url cursor with checksum round-trips (createdAt, id); any tamper throws `InvalidCursorError` (AS-82 cursor part)
- [X] T007 [P] Write failing `JL/handler-options.spec.ts` with `it.each`: type pattern `<domain>.<action>` kebab-case; `leaseMs` 5 s–4 h; `concurrency` ≥ 1; `fleetConcurrency` ≥ 1 optional; `maxRuntimeMs` ≥ `leaseMs`, default 15 min (AS-92, G-40)
- [X] T008 [P] Write/confirm `JL/backoff.spec.ts`: ceiling `min(15 min, 1 s × 2^attempts)` table and jitter bounds 0..ceiling (AS-18)
- [X] T009 Implement `JL/job-state.ts`: pure `nextStatus(from, event)` plus `assertNever`; make T004 pass (G-10, G-42)
- [X] T010 [P] Implement `JL/job-errors.ts`: `UnknownJobTypeError`, `InvalidJobPayloadError{fields}`, `InvalidEnqueueOptionsError{field}`, `IdempotencyKeyConflictError{key, existingType}`, `InvalidScheduleError{field}`, `InvalidCursorError` (G-01, G-32)
- [X] T011 Implement `JL/enqueue-options.ts` validators with the exact limits of T005; make T005 pass (G-02)
- [X] T012 [P] Implement `JL/job-cursor.ts`; make T006 pass
- [X] T013 [P] Implement `JL/handler-options.ts` (name pattern, ranges, defaults, zod); make T007 pass (G-40)
- [X] T014 Implement `JL/job-type-registry.ts`: `declareJobType({ name, contract: zod, maxAttempts?, leaseMs? })`, process-wide registry typed `<K extends JobType>` against the `JobPayloads` augmentation, lookup/parse helpers; export from `JL/index.ts` (G-01, G-41, R-08)
- [X] T015 Extend `JL/job-types.ts`: `JobContext` gains `jobId`, `maxAttempts`, `isLastAttempt`; `signal.reason` ∈ `'timeout'|'lease_lost'|'shutdown'` (G-17)
- [X] T016 Write migration `packages/backend/migrations/<ts>-jobs-hardening.js` exactly as data-model.md (expand-only, `SET LOCAL lock_timeout='5s'`, `IF NOT EXISTS`): `Job.enqueuedByRequestId`, `Job.traceparent`, `Job.scheduleName`; `JobKey.type`, `JobKey.createdAt` + `JobKey_createdAt_idx`; `JobSchedule.overlap` TEXT NOT NULL DEFAULT 'skip' CHECK in ('skip','allow'), `maxAttempts` INT NULL CHECK 1–25, `consecutiveFailures` INT NOT NULL DEFAULT 0, `lastError` TEXT NULL; indexes `Job_running_type_idx`, `Job_running_shop_idx`, `Job_list_idx`, `Job_cron_active_idx`; SQL function `job_drop_expired_partitions(int,int)` (R-06: catalog-resolved, `format('%I')`, keeps recent DEAD, lock_timeout) and a default-partition row-count function; comment documenting the per-partition CONCURRENTLY path (G-04, G-07, G-24, G-27, G-28, G-34)
- [X] T017 Run the migration on the test DB; confirm `pnpm check:table-ownership --strict` and `packages/backend/db/ownership.ts` (≈lines 179–181) cover `Job`, `JobKey`, `JobSchedule` with `Job_default`/`Job_YYYYMMDD` through the parent; edit ownership only if needed (G-45, FR-058)
- [X] T018 Create test helper `JL/testing/jobs-test-app.ts` (boot `JobsModule`+`JobsWorkerModule` with `FakeClock`, recording test handlers, truncate `Job`/`JobKey`/`JobSchedule`) and a test probe exported for foreign specs (FR-059)

**Checkpoint**: unit specs green, migration applied, `tsc` green.

## Phase 3: US1 — Enqueue delayed work safely (P1)

**Goal**: validated, idempotent, tenant-safe enqueue. **Independent test**: `jobs-enqueue.e2e-spec.ts`.

- [X] T019 [US1] Write failing `JL/jobs-enqueue.e2e-spec.ts`: AS-01 delayed job not claimed before `runAt`; AS-02 joins caller transaction, rollback leaves no Job/JobKey; AS-03 same key → existing job `created:false`; AS-04 20 concurrent enqueues of one key → one `created:true`; AS-05 key reused with another type → `IdempotencyKeyConflictError`; AS-06 unknown type / invalid payload rejected, nothing persisted; AS-08 enqueue with no caller transaction commits alone; G-05 key row vanishing between statements → insert retried once, no TypeError; G-07 `enqueuedByRequestId`/`traceparent` stored
- [X] T020 [US1] Modify `JL/jobs.service.ts` `enqueue`: validate type/payload/options (T011/T014), write `JobKey.type`, conflict check (legacy null falls back to job row type), retry insert path once when key row missing, store request id and traceparent from `RequestContextService`, join CLS transaction else commit alone; make T019 pass (G-01–G-03, G-05–G-07)
- [X] T021 [US1] Declare the platform job types with `declareJobType` in the handler files that lack it: `platform.purge-idempotency-keys` (S54 `IdempotencyPurgeService`), `outbox.purge-published`, `inbox.purge` (S53), and the maintenance payloads in JL; otherwise boot-time `upsertSchedule` fails (S54 follow-up (a))

## Phase 4: US2 — Workers run each due job once, in order (P1)

**Independent test**: `jobs-worker.e2e-spec.ts` (claim part).

- [X] T022 [US2] Write failing `JL/jobs-worker.e2e-spec.ts` claim cases: AS-10 four workers drain 1,000 jobs once each; AS-11 oldest `runAt` first, future job untouched; AS-12 type without local handler not claimed; AS-13 per-type `concurrency` bulkhead; AS-14 `fleetConcurrency:1` across 3 workers; AS-15 `lockedUntil` equals handler `leaseMs` straight after claim (G-11, G-12, G-22)
- [X] T023 [US2] Create `JL/job-claim.sql.ts` per R-01/R-02/R-04: single claim statement with types+lease+fleet limit via `unnest` arrays, `FOR UPDATE SKIP LOCKED`, per-type advisory xact lock for fleet-limited types, `SET LOCAL statement_timeout='5s'`, increments `attempts`, sets `lockedBy`, `lockedUntil = :now + lease` (no second extend statement); per-shop slots come in T039 (G-11, G-12, G-44)
- [X] T024 [US2] Refactor `JL/job-worker.service.ts` to use `job-claim.sql.ts`, config values (`claimBatch`, `pollIdleMs`) and per-type bulkhead; make T022 pass (G-12, G-22)
- [X] T025 [US2] Add `fleetConcurrency` and `maxRuntimeMs` to `JL/job-handler.decorator.ts` options, validated by `handler-options.ts` (G-12, G-16, G-40)

## Phase 5: US3 — Failures retry with backoff, then die loudly (P1)

**Independent test**: `jobs-worker.e2e-spec.ts` (outcomes part).

- [X] T026 [US3] Extend `JL/jobs-worker.e2e-spec.ts` (failing first): AS-16 success → `SUCCEEDED`, locks cleared, counter; AS-17 failure → `QUEUED` with jittered `runAt`, then success; AS-19 attempts exhausted → `DEAD`; AS-20 `NonRetryableJobError` → `DEAD` at attempt 1; AS-21 stored payload violating contract → `DEAD` `invalid payload: …`, handler not called; AS-22 context `jobId`/`attempt`/`maxAttempts`/`isLastAttempt`; AS-23 `lastError` ≤ 2,000 chars and no payload in log lines; AS-24 `maxRuntimeMs` aborts with `signal.reason==='timeout'`, retryable (G-13, G-16, G-17, G-23)
- [X] T027 [US3] Modify `JL/job-worker.service.ts`: fenced writes `WHERE id AND "createdAt" AND status='RUNNING' AND "lockedBy" AND attempts` (R-04) using `job-state.ts`; parse payload with the registry contract at claim time (invalid → `DEAD`); per-job `AbortController` with `timeout` via `maxRuntimeMs`; new JobContext fields; structured pino logs `{jobId,type,attempt,shopId}` never payload; `requestContext.run` carrying originating request id/trace; make T026 pass (G-13, G-14, G-16, G-17, G-23, G-36)
- [X] T028 [US3] Replace the fixed 1 s error sleep with `fullJitterBackoff` in `JL/job-worker.service.ts` and `JL/job-maintenance.service.ts` loops (G-21; proven by AS-37 in T030)

## Phase 6: US4 — Dead worker's jobs return, zombies fenced (P1)

**Independent test**: `jobs-lease.e2e-spec.ts`.

- [X] T029 [US4] Write failing `JL/jobs-lease.e2e-spec.ts`: AS-25 late completion after timeout fenced; AS-26 completion write retried 3× then left to reaper, `error` log after last; AS-27 expired lease reaped, re-run, attempts counted; AS-28 worker-killing job ends `DEAD` via reaper, no hot loop, `[lease expired]` not repeatedly appended; AS-29 heartbeat keeps long job alive; AS-30 zombie completion fenced after re-claim by another worker; AS-31 same-worker re-claim: old execution fenced by attempt; AS-32 heartbeat on lost lease aborts signal `lease_lost`; AS-33 two reapers at once: each job reaped once (G-14, G-15, G-18, G-26)
- [X] T030 [US4] Add failing cases to the same file: AS-34 graceful shutdown drains in-flight; AS-35 past 25 s drain deadline: abort `shutdown`, job released `QUEUED`, `runAt=now`, attempt refunded; AS-36 no claim after shutdown begins; AS-37 DB outage: loops survive and resume (G-19, G-20, G-21)
- [X] T031 [US4] Modify `JL/job-worker.service.ts`: heartbeat detects zero-row extension → abort `lease_lost` and surfaces errors; completion writes retried 3× with full jitter then `error` log; make worker-side T029 cases pass (G-15, G-18)
- [X] T032 [US4] Create `JL/job-reaper.service.ts` (split from maintenance) per R-05: one statement with `FOR UPDATE SKIP LOCKED` CTE; `attempts >= maxAttempts` → `DEAD`, else `QUEUED` with jittered backoff `runAt`; emits `job_lease_expired_total{type}`; wire into `JL/job-maintenance.service.ts` and modules; make AS-27/28/33 pass (G-26)
- [X] T033 [US4] Shutdown: register one S54 `ShutdownRegistry` task `jobs-worker` (25 s) in `JL/job-worker.service.ts`; stop claiming, await in-flight, abort with `shutdown`, release fenced (`QUEUED`, `runAt=now`, attempts−1), await release writes; `claim` checks `running` again before the statement; make T030 pass (G-19, G-20, R-10)

## Phase 7: US5 — Cancel and retry state machine (P2)

**Independent test**: `jobs-state.e2e-spec.ts`.

- [X] T034 [US5] Write failing `JL/jobs-state.e2e-spec.ts`: AS-39 cancel QUEUED → `{outcome:'CANCELLED'}`; AS-40 other statuses → `CONFLICT{status}`, unknown → `NOT_FOUND`; AS-41 cancel vs claim race: exactly one winner; AS-42 `cancelByKey`; AS-43 cross-shop cancel → `NOT_FOUND`, row unchanged; AS-44 `retryDead` DEAD→QUEUED (`attempts=0`, `runAt=now`, `finishedAt` cleared), others `CONFLICT`, audit log line with job id, previous status, actor; AS-45 two concurrent retries: one `RETRIED`
- [X] T035 [US5] Modify `JL/jobs.service.ts`: `cancel(jobId,{shopId?})` and new `cancelByKey(key,{shopId?})` returning the discriminated outcome via conditional update using `job-state.ts`, `shopId` in the predicate (III.4); make cancel cases pass (G-08)
- [X] T036 [US5] Create `JL/jobs-admin.service.ts` with `retryDead(jobId, actorId)` and `cancel(jobId)` per contracts/jobs-admin-service.md; register in `JobsModule`, export from `JL/index.ts`; make T034 pass (G-09)
- [X] T037 [US5] Update callers of `JobsService.cancel` (`grep -rn "\.cancel(" packages/backend/libs/domains | grep -i job`) to the discriminated result (BREAKING in questions.md); if a caller sits in another capability's spec file, do not edit it and list it under gaps.md "Sibling-spec follow-ups" (none exist: no code outside the lib called `JobsService.cancel`)

## Phase 8: US6 — Per-shop fairness (P2)

**Independent test**: `jobs-fairness.e2e-spec.ts`.

- [X] T038 [US6] Write failing `JL/jobs-fairness.e2e-spec.ts`: AS-46 cap holds fleet-wide under load (sampled running ≤ 5); AS-47 saturated shop does not delay another; AS-48 cap counts jobs claimed in the same batch; AS-49 four concurrent claimers keep the cap; AS-50 jobs without shop uncapped; AS-51 finishing frees a slot next poll; AS-52 oldest-first among unsaturated shops
- [X] T039 [US6] Extend `JL/job-claim.sql.ts` per R-01: over-fetch `claimBatch × 4`, `pg_advisory_xact_lock(hashtextextended('job-shop:'||shopId,0))` for distinct shops in sorted order, recount RUNNING per shop, window limiting each shop to `cap − running`, shop-less jobs skip the lock; cap from `jobs.perShopRunningCap`; make T038 pass (G-24b, G-22)

## Phase 9: US7 — Recurring schedules once per fire (P1)

**Independent test**: `jobs-cron.e2e-spec.ts`.

- [X] T040 [US7] Write failing `JL/schedule-validation.spec.ts` (`it.each`): name `^[a-z0-9]+([._-][a-z0-9]+)*$` max 100; cron dialect 5 or 6 fields, no `L/W/#`; valid zone; `maxAttempts` 1–25; `overlap` ∈ skip|allow (AS-76, G-32, G-38)
- [X] T041 [US7] Implement `JL/schedule-validation.ts`; make T040 pass; make `isValidCron` in `JL/cron.ts` use it (G-38)
- [X] T042 [US7] Write failing `JL/jobs-cron.e2e-spec.ts` (FakeClock): AS-53 due schedule → one job key `cron:<name>:<fireAt>`; AS-54 five instances tick at once → one leader, one job; AS-55 leader aborted mid-tick → no partial effect, next instance fires once; AS-56 duplicate materialisation deduped; AS-57 3-day outage → one catch-up; AS-58 overlap `skip` vs `allow`; AS-59 upsert idempotent, recompute only on cron/zone change; AS-60 8 replicas upsert at boot concurrently; AS-61 invalid schedule → `InvalidScheduleError`, row unchanged; AS-62 disable/re-enable computes from now; AS-63 `removeSchedule` keeps materialised jobs; AS-64 1,200 due schedules over ≤ 3 ticks (batch 500); AS-65 failing schedule isolated, auto-disabled after 5; AS-66 schedule `maxAttempts` propagates; AS-67 six-field schedule fires every 10 s
- [X] T043 [US7] Modify `JL/job-maintenance.service.ts` materialiser per R-07: migrate its direct `sequelize.transaction` (≈line 76) to `TransactionRunner.run` and delete the `// S54 T037 audit` comment; `pg_try_advisory_xact_lock` leader, `SET LOCAL statement_timeout='5s'`, batch 500, per-schedule `SAVEPOINT`, overlap check via `Job_cron_active_idx` on `scheduleName`, set `Job.scheduleName` and `maxAttempts` from the schedule, failure counter and auto-disable at 5, `cron_fires_total`/`cron_fires_skipped_total`/`cron_leader`; expose tick for tests (G-28–G-30, G-44)
- [X] T044 [US7] Modify `JL/jobs.service.ts` `upsertSchedule` (validated, `InvalidScheduleError`, `overlap`, `maxAttempts`, concurrent-safe `ON CONFLICT`, recompute `nextFireAt` only on cron/zone change or enable, unknown job type/payload rejected) and add `removeSchedule(name): boolean`; make T042 pass (G-31, G-32)
- [X] T045 [US7] Add `listSchedules()` and `setScheduleEnabled(name, enabled)` (enable recomputes `nextFireAt` from now) to `JL/jobs-admin.service.ts` (G-09, G-31)
- [X] T046 [US7] Check `packages/backend/libs/domains/identity/users.module.ts:15,29` import of `CronModule`; drop it if unused, otherwise document why; add a doc comment in `JL/cron-module` forbidding new single-run uses (outbox poller stays) (G-43, FR-060)

## Phase 10: US8 — Cron in local wall-clock time across DST (P1)

**Independent test**: `JL/cron.spec.ts`.

- [X] T047 [US8] Write failing/extended `JL/cron.spec.ts` (`it.each`, base instant is a parameter): AS-68 daily 09:00 Europe/Warsaw across both DST changes; AS-69 nonexistent local time fires once after the gap; AS-70 ambiguous time fires once at first occurrence; AS-71 wildcard hour gives 25/23 fires on DST days; AS-72 31st and 29 Feb skip impossible dates; AS-73 next fire strictly after base; AS-74 fractional-offset (Asia/Kolkata) and no-DST zones; AS-75 zone change recomputes (R-03, G-37)
- [X] T048 [US8] Run T047 against the current `cron` library; if every row passes keep it, otherwise implement a pure Luxon `nextFireAt(expr, zone, after)` in `JL/cron.ts` (parse field sets once, reject `L W #`, walk local wall-clock candidates) until T047 passes; record the decision in research.md R-03 (G-37)

## Phase 11: US9 — Operators see lag, failures, dead jobs (P2)

**Independent test**: `jobs-observability.e2e-spec.ts`.

- [X] T049 [US9] Write failing `JL/jobs-observability.e2e-spec.ts`: AS-77 `job_queue_lag_seconds{type}` every tick, 0 when nothing due; AS-78 `job_outcomes_total{type,outcome}` (incl. `timeout`, `released`), `job_duration_ms`, `job_dead_jobs{type}`; AS-79 `job_lease_expired_total`, `cron_fires_skipped_total`; AS-80 structured logs with ids, no payload, originating request id/trace carried; AS-81 per-job request context isolation; AS-82 `listJobs` keyset pagination, tampered cursor → `InvalidCursorError`, limit clamp 1–100 default 50; AS-83 `getStats` equals row counts (in-memory metric reader)
- [X] T050 [US9] Create `JL/job-metrics.ts` with the FR-052 instruments under the fixed names in contracts/jobs-service.md (`job_queue_lag_seconds`, `job_outcomes_total`, `job_duration_ms`, `job_dead_jobs`, `job_lease_expired_total`, `cron_fires_total`, `cron_fires_skipped_total`, `cron_leader`, `job_default_partition_rows`); use from worker, reaper, materialiser; lag computed every maintenance tick per type, not every 10th (G-35)
- [X] T051 [US9] Add `listJobs` (order `createdAt DESC, id DESC`, DTO without payload, uses `Job_list_idx`) and `getStats()` to `JL/jobs-admin.service.ts`; make T049 pass (G-09, G-27)
- [X] T052 [US9] Replace direct `"Job"` SQL in the three foreign specs with `JobsAdminService.listJobs` or the test probe: `libs/domains/seller-onboarding/onboarding.e2e-spec.ts:168`, `libs/domains/developer-platform/webhooks.e2e-spec.ts:102`, `libs/domains/notifications/notifications.e2e-spec.ts:123`; run each file afterwards (FR-059, D-12) (done with `JobsTestProbe`; onboarding passes; the other two need Cassandra, which this sandbox lacks, see quickstart.md)

## Phase 12: US10 — Tables stay small and fast (P2)

**Independent test**: `jobs-retention.e2e-spec.ts`.

- [ ] T053 [US10] BLOCKED on AS-89 only (questions.md BLOCKER); written and green for AS-09, AS-84–AS-88, AS-90: Write failing `JL/jobs-retention.e2e-spec.ts`: AS-09 key expiry at the 30-day boundary; AS-84 partitions created ahead, idempotent; AS-85 drop rules (finished dropped; QUEUED/RUNNING kept; DEAD finished within retention kept; young kept); AS-86 insert with no partition lands in default, `job_default_partition_rows` reported with warning; AS-87 `JobKey` purge in batches of 10,000; AS-88 claim plan uses the partial due index on 200k rows (reduced size by env); AS-89 HOT update ratio ≥ 90% (reduced cycles by env); AS-90 drop by catalog-resolved name within lock timeout
- [X] T054 [US10] Modify `JL/job-maintenance.service.ts`: replace `DROP TABLE "${name}"` (≈line 147) with a call to `job_drop_expired_partitions`; validate `retainDays`/`aheadDays` payload bounds; batched `JobKey` purge 30 days after the job finished (10,000 per batch); default-partition gauge and warning; make T053 pass (G-24, G-25, G-04, G-34)
- [X] T055 [US10] If AS-88 shows the due index is insufficient with realistic type counts, add a `(type, runAt)` partial index in `packages/backend/migrations/<ts>-jobs-due-type-idx.js`; otherwise note "not needed" in research.md (G-27) (not needed, noted)

## Phase 13: US11 — Handlers and job types declared once, checked at boot (P2)

**Independent test**: `jobs-registry.e2e-spec.ts`.

- [X] T056 [US11] Write failing `JL/jobs-registry.e2e-spec.ts`: AS-91 two different providers for one type fail startup, same provider twice is fine; AS-92 one representative bad type name/option aborts boot; AS-94 enqueue works in an app without the handler module; S54 follow-up: boot `JobsWorkerModule` + `IdempotencyModule` and assert handler `platform.purge-idempotency-keys` is registered and the 15-minute `JobSchedule` row exists via `JobsService.upsertSchedule`
- [X] T057 [US11] Modify `JL/job-registry.service.ts`: fail startup on a duplicate handler from a different provider; validate options via `handler-options.ts`; require a `declareJobType` declaration for each handler; apply defaults explicitly; `assertNever` over types where switching; make T056 pass (G-39–G-42)
- [X] T058 [US11] Verify `packages/backend/apps/worker/src/worker.module.ts` imports `IdempotencyModule` (plan says it does); add the import if missing (S54 follow-up requirement); confirm JL has no `@app/domains` import (X.5)
- [X] T059 [US11] Add a `declareJobType` call (contract written from the existing `JobPayloads` interface) next to each `JobPayloads` augmentation in `libs/domains/**/infra/*.jobs.ts` (≈35 files; find with `grep -rln "interface JobPayloads" packages/backend/libs/domains`); run `tsc` and the registry e2e afterwards (G-41, R-08)

## Phase 14: Polish & cross-cutting

- [X] T060 Retire old `JL/jobs.e2e-spec.ts` once its 7 cases are covered by the nine new files (list the mapping in the report), then delete the file (G-46)
- [X] T061 [P] Update `JL/index.ts` exports (R1): `JobsService`, `JobsAdminService`, `declareJobType`, errors, `JobContext`, `NonRetryableJobError`, test probe
- [X] T062 [P] Confirm `JL/jobs.service.ts` SQL touches only `Job`, `JobKey`, `JobSchedule`; record the G-47 decision (no restructure) in plan.md
- [X] T063 Static gates from `packages/backend`: `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm check:boundaries`, `pnpm check:table-ownership --strict`, `pnpm check:no-wallclock`; `grep -rn "sequelize.transaction" libs/infrastructure/jobs` must return 0 and no `// S54 T037 audit` may remain there; record the `jobs` lines
- [X] T064 Append any new sibling follow-ups found in T037/T052/T059 to `## Sibling-spec follow-ups` in gaps.md as `- **<id>**: <what they must adopt>` (never edit their specs)
- [X] T065 Ops artifacts: confirm quickstart.md "Ops artifacts" lists SC-002, SC-006, SC-007 and AS-88/89 full scale, and `specs/UNVERIFIED.md` has one S49 row each with status `not run` (already present); add missing rows only, never describe them as verified
- [ ] T066 BLOCKED by AS-89 (96 of 97 tests of the capability suite pass; the one failure is AS-89, see questions.md): Run the whole capability suite once: `/opt/sdd/repo/scripts/sdd/test-spec.sh libs/infrastructure/jobs`, plus the three foreign specs from T052; after 5 failed fixes of one test write blocker, attempts and hypothesis to `questions.md` and stop
- [X] T067 Final report mentions: S54 follow-up (worker imports `IdempotencyModule`, purge type declared, REG case), BREAKING items adopted, UNVERIFIED rows, `check:table-ownership` jobs lines

## Dependencies

- Phase 1 → Phase 2 (blocks all). T016/T017 before any e2e. T014 before T020, T027, T057.
- US1 → US2 → US3 → US4 run sequentially (shared `job-worker.service.ts` and `job-claim.sql.ts`).
- US5 needs US1; US6 needs US2; US7 needs Foundational, and `job-maintenance.service.ts` is shared so sequence T032 → T043 → T054; US8 is unit-only and can run any time after Phase 2; US9 needs US3/US4/US7; US10 needs T016; US11 needs T014.
- T052 and T059 need Phase 3 done; T060 before T063.

## Parallel examples

- Phase 2 unit specs T004–T008 together, then T010/T012/T013.
- US8 (T047–T048) in parallel with US1–US4 (different files).
- T061/T062 together at the end.

## Implementation strategy

MVP = Phases 1–6 (US1–US4: enqueue, claim, retry, lease and fencing). Then US7+US8 (schedules, DST), then US5, US6, US9–US11, then polish. Each phase ends with its e2e/unit file green via `test-spec.sh`; whole suite once at T066.
