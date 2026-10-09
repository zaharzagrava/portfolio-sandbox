# Research: S49 — Distributed job scheduler

No NEEDS CLARIFICATION remain; questions.md defaults are accepted. Decisions below settle how.

## R-01 Per-shop cap enforced atomically
- **Decision**: In the claim transaction, pick candidates (`ORDER BY runAt, id`, `FOR UPDATE SKIP LOCKED`, limit `claimBatch × 4`), take `pg_advisory_xact_lock(hashtextextended('job-shop:'||shopId,0))` for the distinct shops in the candidate set in sorted order (no deadlock), recount `RUNNING` per shop under the lock, then keep per shop the first `cap − running` rows via `ROW_NUMBER() OVER (PARTITION BY shopId)`; update those to `RUNNING`.
- **Rationale**: the lock serialises claimers per shop, so the count-then-update is no longer check-then-write; the window enforces the cap inside one batch (AS-48). Shops without `shopId` skip the lock (AS-50). Candidate over-fetch avoids head-of-line blocking by a saturated shop (AS-47).
- **Alternatives**: counter row per shop (hot row, drift on crash); `NOT IN` subquery (current, racy); a partial unique index on a slot number (complex, needs slot recycling).

## R-02 Fleet concurrency and per-type lease in the claim
- **Decision**: one claim statement per poll takes the registered types with their `leaseMs` and `fleetConcurrency` as arrays (`unnest`), computes `lockedUntil = :now + lease` per row via join, and for types with a fleet limit takes `pg_advisory_xact_lock` per type and limits by `limit − running(type)` with the same window technique. Index `Job_running_type_idx ("type") WHERE status='RUNNING'`.
- **Rationale**: no second statement extends the lease (AS-15); fleet limit by the store (III.6).
- **Alternatives**: claim per lease class (more round trips); Redis semaphore (second store, not strongly consistent).

## R-03 Cron semantics and DST
- **Decision**: first write `cron.spec.ts` against the current `cron` library for AS-68–AS-75. If any case deviates, replace `nextFireAt` with a Luxon pure function: parse the field sets once (5/6 fields, lists, ranges, steps, names; reject `L W #`), walk candidate local wall-clock times in the zone, convert with Luxon; for a nonexistent local time return the first instant after the gap; for an ambiguous time take the first occurrence; wildcard hour iterates elapsed UTC hours. `isValidCron` and the dialect check share the parser. The base instant is always a parameter.
- **Rationale**: spec FR-041 requires behaviour the library does not document; test-first avoids needless replacement. `cron` stays only if it passes all rows.
- **Alternatives**: `cron-parser` (also leaves DST-gap semantics to the library); materialising fires in SQL (zone data in the database, harder to test purely).

## R-04 Claim identity fence
- **Decision**: every write after claim is `WHERE id=:id AND "createdAt"=:createdAt AND status='RUNNING' AND "lockedBy"=:worker AND attempts=:attempt`; the reaper never changes `attempts`, the claim increments it, so a re-claim by the same worker produces a different fence (AS-31). Release on shutdown decrements `attempts` under the same fence.
- **Alternatives**: a `claimToken` column (extra write per claim, redundant with attempts).

## R-05 Reaper
- **Decision**: single statement `UPDATE … WHERE status='RUNNING' AND lockedUntil < :now` using `FOR UPDATE SKIP LOCKED` in a CTE; rows with `attempts >= maxAttempts` → `DEAD`, others → `QUEUED` with `runAt = now + jittered backoff` (random drawn in SQL from a seed parameter supplied by the caller so tests are deterministic), `lastError` set to the last message plus a single `[lease expired]` marker (replace, not append). Emits `job_lease_expired_total{type}`.
- **Rationale**: two reapers split rows via SKIP LOCKED, so each is reaped once (AS-33).

## R-06 Partition drop in the database
- **Decision**: SQL function `job_drop_expired_partitions(retain_days int, lock_timeout_ms int)` iterates `pg_inherits`/`pg_class` for children of `"Job"`, derives the day from the catalog bound, checks emptiness of `QUEUED|RUNNING` and recent `DEAD`, runs `DROP TABLE` with `format('%I')` under `SET LOCAL lock_timeout`, returns dropped names. `JobKey` purge is a batched `DELETE … WHERE ctid IN (SELECT … LIMIT 10000)` on `"createdAt"` index, run until a short batch.
- **Rationale**: removes the application-built identifier (IX.5); recent `DEAD` rows survive (AS-85).

## R-07 Materialiser isolation
- **Decision**: one transaction per tick via `TransactionRunner.run`, `pg_try_advisory_xact_lock`; each due schedule inside a `SAVEPOINT`; on failure roll back to the savepoint, `UPDATE consecutiveFailures+1, lastError`, auto-disable at 5. Overlap `skip` checks `EXISTS (SELECT 1 FROM "Job" WHERE type=… AND "idempotencyKey" LIKE 'cron:<name>:%' AND status IN ('QUEUED','RUNNING'))` — served by a new `Job_cron_active_idx` partial index on `(("scheduleName")) WHERE status IN ('QUEUED','RUNNING')` using a new nullable `scheduleName` column set at materialisation, so no `LIKE`.
- **Alternatives**: separate transaction per schedule (loses single-leader atomicity across the tick; AS-55 needs no partial effect per fire, which per-schedule savepoints keep).

## R-08 Type declarations
- **Decision**: `declareJobType({ name, contract: zod, maxAttempts?, leaseMs? })` stores into a process-wide registry on import; `JobPayloads` augmentation stays for compile-time types, and `declareJobType<K extends JobType>` ties both so a mismatch fails `tsc`. Handlers fail boot without a declaration. Enqueue-only apps import the declaration file only (AS-94).
- **Impact**: 35 domain files add one call (P9). Contracts for legacy types are written from the existing `JobPayloads` interfaces.

## R-09 Config and timeouts
- **Decision**: add `jobs.claimBatch` (50), `jobs.perShopRunningCap` (5), `jobs.retainDays` (30), `jobs.pollIdleMs` (500) to the S54 validated config schema. Claim and materialiser transactions use `SET LOCAL statement_timeout = '5s'`; connection-level 30 s stays.

## R-10 Shutdown
- **Decision**: register one S54 shutdown task `jobs-worker` (timeout 25 s); stop claiming, await in-flight, then abort signals with reason `shutdown`, release fenced, await release writes. `claim` checks `running` inside the loop and again immediately before the statement (AS-36).

## Decisions recorded during implementation

- **R-03 outcome**: `cron.spec.ts` (AS-68–AS-75) was run against the `cron` library first. Everything passed except AS-70: after the first pass of a repeated hour the library returned an instant earlier than the base, which would double-fire. `cron.ts` therefore parses the expression itself and uses Luxon for zone arithmetic: explicit hours walk local calendar times (gap → first instant after the gap, repeat → first occurrence), a wildcard hour scans elapsed time (23 / 25 fires on the DST days). `cron` stays a dependency only for the every-replica ticker (`cron-module`).
- **T055 (due index)**: `Job_due_idx ("runAt") WHERE status = 'QUEUED'` is enough. AS-88 (20,000 rows by default; 200,000 on the runner) shows the claim candidate read as index scans only with fewer than 1,000 rows touched, so no `(type, runAt)` index was added.
- **R-05 jitter**: the reaper draws its jitter from `hashtextextended(job id, attempt, seed)`, with the seed a parameter of `JobReaper.reap(seed)`.
- **AS-84 window**: `aheadDays = 14` keeps `D … D+14` (15 partitions): `job_ensure_partitions(today, aheadDays + 1)`.
- **R-06 key purge**: a key is removed when it is older than the retention and its job is gone or finished before the cutoff (`JobKey` has no `finishedAt`; the job row is the source).
