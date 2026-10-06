# Gaps: current code vs S49 spec

Files in scope (all under `packages/backend/libs/infrastructure/jobs/` unless noted): `jobs.service.ts`, `job-worker.service.ts`, `job-maintenance.service.ts`, `job-registry.service.ts`, `job-handler.decorator.ts`, `job-types.ts`, `cron.ts`, `jobs.module.ts`, `jobs-worker.module.ts`, `cron-module/*`, `jobs.e2e-spec.ts`; migration `packages/backend/migrations/20261001110000-create-jobs.js`; ownership entries in `packages/backend/db/ownership.ts`. Line numbers were taken on 2026-10-06 and drift as the code changes. This is the implementation agent's to-do list.

The code is a good draft of the core: `SKIP LOCKED` claim, partial indexes, partitioned `Job`, `JobKey` dedupe, advisory-lock materialiser, fenced completion by worker, full-jitter backoff. The gaps are in invariants that hold only on the happy path.

## Debt register and ownership check

| Source | State | What S49 does |
|---|---|---|
| Debt rows naming `S49` | **none open.** D-1 (infrastructure imports domain/test code) was resolved in Phase 3; the jobs lib has no `@app/domains/*` import | nothing; keep `pnpm check:boundaries` green (X.5) |
| Debt rows naming `infrastructure` | D-1, D-2, D-3 resolved (Phase 3). D-14 (LLM port) and D-16 (Elasticsearch product adapter) are open but belong to S46 and S32, not to `jobs` | nothing here |
| D-7 (domains import other domains' `*Model`) | open for other domains | `jobs` registers no business model and no domain imports a Job model; no replacement needed |
| D-12 (cross-domain raw SQL) | open for other domains | `jobs` queries only `Job`, `JobKey`, `JobSchedule` (all `infrastructure:jobs`, `db/ownership.ts`); **but three other domains' specs query `"Job"` directly** (below), replaced by **R1** (`JobsAdminService`) |
| `pnpm --dir packages/backend check:table-ownership` | **not run**: the command needed approval in this unattended session. By grep, the `infrastructure/jobs` lib's own SQL is limited to its three tables, with one dynamic-identifier statement (`job-maintenance.service.ts:147`, see G-24). | the implementation agent must run it and `--strict` and record the `jobs` lines (expected: none except G-24 before the fix) |

Cross-domain SQL on the job tables found by grep (test code; IX.6 allows seed/clean helpers only, so these are still to be replaced by **R1** `JobsAdminService` or a test-only probe, FR-059):

- `libs/domains/seller-onboarding/onboarding.e2e-spec.ts:168`
- `libs/domains/developer-platform/webhooks.e2e-spec.ts:102`
- `libs/domains/notifications/notifications.e2e-spec.ts:123`

## Gaps by area

### Enqueue (FR-001–FR-010, AS-01–AS-09)

- **G-01** (AS-06, FR-006) `jobs.service.ts:20`: no runtime validation of type or payload. `JobPayloads` is compile-time only (`job-types.ts:9`). Add a job-type declaration registry with a zod contract per type, validate in `enqueue` and `upsertSchedule`, and again at claim time (G-13). Error classes `UnknownJobTypeError`, `InvalidJobPayloadError`, `InvalidEnqueueOptionsError`, `IdempotencyKeyConflictError` do not exist.
- **G-02** (AS-07, FR-006) `jobs.service.ts:21`: `maxAttempts`, `runAt`, key length and payload size are unchecked.
- **G-03** (AS-05, FR-004) `jobs.service.ts:24–44`: a key reused with another type silently returns the first job. The key row does not store the type; either store it in `JobKey` or read it from the job.
- **G-04** (AS-09, FR-005) No code ever deletes `JobKey` rows; the table grows without bound. Add batched purge in the maintenance job (G-25) and an index on `JobKey("createdAt")` (migration, expand-only).
- **G-05** (AS-04) `jobs.service.ts:57–62`: the fallback read dereferences `existing.jobId` and throws a `TypeError` if the key row vanished between statements (purge race). Handle "not found" by retrying the insert path once.
- **G-06** (AS-08) Verify enqueue with no active CLS transaction commits on its own and with one joins it; the draft relies on `@InjectConnection` plus CLS but has no test for the community (no-SQL-transaction) caller (S26).
- **G-07** (FR-054) No originating request id or trace stored; add `enqueuedByRequestId` and `traceparent` columns (nullable, expand) and set them from the request context.
- **G-08** (AS-39–AS-43, FR-008) `jobs.service.ts:65`: `cancel(jobId)` returns a boolean, has no tenant scope (loads by id only, III.4) and no `cancelByKey`. Return the discriminated outcome; add `shopId` to the predicate; hide existence across shops (`NOT_FOUND`).
- **G-09** (AS-44, AS-45, FR-010) No operator `retryDead`, no `JobsAdminService` at all (`listJobs`, `getStats`, `listSchedules`, `setScheduleEnabled`). Add it, exported from the lib; add the supporting indexes (G-27). S01 adds the HTTP routes (see CONTRACT in `questions.md`).
- **G-10** (AS-38, FR-007) The status model is a string union (`job-types.ts:19`) with a DB `CHECK`, but there is no pure transition function and no `assertNever` over statuses. Add `job-state.ts` (pure) and use it in every conditional update.

### Worker (FR-011–FR-019, AS-10–AS-37)

- **G-11** (AS-15, FR-012) `job-worker.service.ts:85–86`: the claim sets a fixed 60 s lease; the handler lease is applied by a second statement at `:118`. Set the handler lease in the claim (join the type's lease via a per-type `CASE`, or claim per lease class).
- **G-12** (AS-14, FR-013) `job-worker.service.ts:77` and `job-handler.decorator.ts:9`: `concurrency` is per instance only. Add `fleetConcurrency` enforced in the claim (needs an index on running jobs by type, G-27).
- **G-13** (AS-21, FR-019) `job-worker.service.ts:105–121`: the payload is passed to the handler unvalidated. Parse with the type's contract; on failure end the job `DEAD` with `invalid payload: …` without calling the handler.
- **G-14** (AS-30, AS-31, FR-015) Fencing is by `lockedBy` only (`job-worker.service.ts:136,144,161`). The same worker can reap-and-reclaim its own job (new attempt) and the old execution's completion then matches. Fence on `(lockedBy, attempts)` as well.
- **G-15** (AS-32, FR-014, FR-016) `job-worker.service.ts:114`: heartbeat errors are swallowed and a zero-row extension (lease lost) is ignored. Detect it and abort the handler's signal with reason `lease_lost`.
- **G-16** (AS-24, AS-25, FR-016) No `maxRuntimeMs`; a hung handler heartbeats forever. Add the option (default 15 min), per-job abort controller (today the single shared `abort` at `:34` is for shutdown only) and a `timeout` outcome.
- **G-17** (AS-22, FR-017) `job-types.ts:46`: `JobContext` lacks `jobId`, `maxAttempts`, `isLastAttempt`; the signal has no typed reasons.
- **G-18** (AS-26, FR-018) Completion writes (`finish`, `fail`) are single attempts; a transient error leaves the job `RUNNING`. Retry 3× with full jitter; log at `error` after the last.
- **G-19** (AS-35, FR-025) `job-worker.service.ts:172–183`: `stop()` aborts at 20 s (the shutdown task allows 25 s) and unfinished jobs are left `RUNNING` until the lease expires. Release them (`QUEUED`, `runAt = now`, attempt refunded) after the abort; align the deadlines to 25 s.
- **G-20** (AS-36) Confirm `claim` cannot run after `running = false`; add the test.
- **G-21** (AS-37, FR-026) `job-worker.service.ts:67`: the loop sleeps a fixed 1 s on error; use backoff with jitter. Same for the maintenance loop (`job-maintenance.service.ts:57`).
- **G-22** (FR-012, config) `CLAIM_BATCH`, `PER_SHOP_RUNNING_CAP`, `POLL_IDLE_MS` are constants (`job-worker.service.ts:13–16`). Read them from validated config (`jobs.claimBatch`, `jobs.perShopRunningCap`).
- **G-23** (AS-23, AS-80) Logs at `:151` are plain strings with the error message; make them structured with `jobId`, `type`, `attempt`, `shopId`; never log payloads. Truncation of `lastError` exists (`:165`).

### Fairness (FR-027, FR-028, AS-46–AS-52)

- **G-24b** (AS-48, AS-49) `job-worker.service.ts:90–93`: the saturated-shop `NOT IN` subquery counts only rows already `RUNNING` at statement start. One batch can claim up to `limit` jobs of one shop, and concurrent claimers each see the same low count. Enforce the cap atomically: a per-shop slot (advisory lock per shop for the shops present in the candidate set, or a counter row with a conditional update) and a window over the candidate set limiting each shop to `cap − running`.

### Reaper and maintenance (FR-024, FR-032–FR-038, FR-047–FR-049)

- **G-24** (AS-90, FR-048) `job-maintenance.service.ts:147`: `DROP TABLE "${name}"` builds an identifier in application SQL (IX.5). Move into a SQL function that resolves partitions from the catalog and drops under `lock_timeout 5s`.
- **G-25** (AS-85, AS-87) `job-maintenance.service.ts:131–150`: the partition check ignores recent `DEAD` jobs and never purges `JobKey`. `retainDays`/`aheadDays` payload values are unbounded; validate them.
- **G-26** (AS-27, AS-28, AS-33, FR-024) `job-maintenance.service.ts:106–115`: the reaper re-queues regardless of `attempts`, with no backoff, appends `[lease expired]` to `lastError` every time, is unfenced by attempt, and emits no metric. Rewrite: `DEAD` at the limit, backoff otherwise, `job_lease_expired_total`.
- **G-27** Indexes (migration, expand-only, `lock_timeout`): running-by-type for `fleetConcurrency`; `(status, type, createdAt DESC, id DESC)` for `listJobs`; `JobKey(createdAt)` for purge; schedule columns below. `Job_due_idx` is on `("runAt") WHERE status='QUEUED'` and does not cover `type IN (...)`; check the plan for AS-88 with realistic type counts.
- **G-28** (AS-53–AS-56) Materialiser basics exist (`job-maintenance.service.ts:60–101`, advisory lock `:62`, key `cron:<name>:<fireAt>` `:81`). Missing: `JobSchedule` has no `overlap`, `maxAttempts`, `consecutiveFailures`, `lastError` columns (migration `:60–72`); materialised jobs ignore a schedule's `maxAttempts` (`:87` inserts defaults).
- **G-29** (AS-58, FR-035) No overlap policy: every due fire is queued even if the previous run is unfinished. Add `skip` default and `cron_fires_skipped_total`.
- **G-30** (AS-65, FR-038) One failing schedule throws inside the single transaction (`:60`) and rolls back the whole tick, repeating every second. Isolate per schedule (savepoint), count failures, auto-disable after 5.
- **G-31** (AS-62, AS-63, FR-036) No `removeSchedule`, no enable/disable API, and re-enabling must compute from now (`jobs.service.ts:74–104` keeps `nextFireAt` whenever cron and zone are unchanged).
- **G-32** (AS-59, AS-61, FR-030) `jobs.service.ts:82` throws a plain `Error`; unknown job type, invalid payload, name pattern, `maxAttempts` are not validated; the zone is validated only through `CronTime`. Add `InvalidScheduleError`.
- **G-33** (AS-57) Verify the catch-up: `nextFireAt` is computed from `max(now, fireAt)` (`:93`), which is right; add the test with a 3-day outage.
- **G-34** (AS-86) No default-partition monitoring (`Job_default` in the migration `:45`); add the metric and warning.
- **G-35** (AS-77–AS-79, FR-052) Metrics: lag is overall only and measured every 10th tick (`job-maintenance.service.ts:55`); no dead-job gauge, no per-type lag, no `timeout`/`released` outcomes, no `cron_fires_total`, no leader gauge. `job_outcomes_total` and `job_duration_ms` exist (`job-worker.service.ts:36–37`).
- **G-36** (AS-81) `requestContext.run` (`job-worker.service.ts:121`) sets request id, shop and principal type; add the originating request id and trace (G-07).

### Time zones (FR-040–FR-043, AS-68–AS-76)

- **G-37** `cron.ts:9` delegates to the `cron` package (`CronTime`). The draft e2e only checks one Warsaw DST case (`jobs.e2e-spec.ts:164`). Verify AS-69 (gap), AS-70 (overlap), AS-71 (wildcard hour counts 25/23), AS-72 (31st, 29 Feb), AS-73 (strictly after), AS-74 against the library; where it deviates, wrap or replace it with a Luxon-based pure function (patterns P0104). Keep the function pure: the base instant is a parameter.
- **G-38** `isValidCron` (`cron.ts:15`) accepts whatever `CronTime` accepts; define and test the allowed dialect (5 or 6 fields, no `L/W/#`).

### Registry (FR-044–FR-046, AS-91–AS-95)

- **G-39** (AS-91) `job-registry.service.ts:32`: duplicate handlers are ignored at debug level. Fail startup when two different providers claim a type; ignore only the same instance.
- **G-40** (AS-92) No validation of type name, `leaseMs` range, `concurrency`, `maxRuntimeMs`; defaults are applied silently (`:36–37`).
- **G-41** (AS-93, AS-94) Type declaration and handler registration are the same thing today (`JobPayloads` augmentation plus `@JobHandler`). Add a separately loadable declaration (name, zod contract, defaults).
- **G-42** (AS-95) No `assertNever` over statuses or types (see G-10).

### Boundaries and legacy

- **G-43** (FR-060) `cron-module/` (`@nestjs/schedule`) runs in every replica; used by `outbox/outbox-publisher.service.ts:6,34,45` (a legitimate per-replica poller, S53) and imported by `libs/domains/identity/users.module.ts:15,29`. Check whether the identity import is still needed and drop it if not. Forbid new single-run uses (lint rule or doc comment).
- **G-44** (FR-056, III.12) No `statement_timeout` is set for the database roles used by the claim and enqueue paths (grep found none in `libs/infrastructure/database`); the claim query and the materialiser transaction have no timeout. Set them (S53 database lib) and write the pool arithmetic in `plan.md`.
- **G-45** (FR-058) Confirm the ownership registry has `Job`, `JobKey`, `JobSchedule` under `infrastructure:jobs` and that partitions are registered through the parent (`db/ownership.ts`); `Job_default` and `Job_YYYYMMDD` must not appear as separate unowned objects.
- **G-46** (VII.2) Tests: `jobs.e2e-spec.ts` has 7 cases (`:98–164`) against 95 scenarios, does not freeze time, and uses real `now()`. Introduce the injected clock (S54) into claim, lease, reaper and materialiser queries (G-11 style `:now` parameters), then write the nine e2e files and seven unit files listed in `test-plan.md`.
- **G-47** `JobsService` methods use raw `sequelize.query`; since they touch only owned tables this is allowed, but move the SQL into an `infra/` repository behind a port if the lib is restructured to the I.1 layering (D-6 style); not required for this capability unless the lib already follows that layout.

## Summary count

48 gap items (G-01 to G-47, plus G-24b for fairness). Highest risk first: G-24b (cap overshoot), G-26 (reaper loop), G-14 (zombie completion), G-30 (one bad schedule blocks all), G-01/G-03 (validation and key conflict), G-04 (unbounded `JobKey`), G-24 (IX.5).
