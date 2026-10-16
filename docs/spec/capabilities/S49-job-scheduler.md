---
id: S49
title: Distributed job scheduler: SKIP LOCKED leases, retries, cron leader, fairness, tz-aware cron
kind: capability
status: draft
generated_at: e95ce81
depends_on: [S53, S54]
concepts: [job-scheduler-lease, idempotency-key, transaction-runner, request-context, problem-json-errors]
models: []
scope:
---
# S49 - Distributed job scheduler
## Purpose
Domains need to run background work and recurring work (cron) without owning queues, locks or retry logic. This capability stores jobs in the database, leases them to workers with row-lock skip-locked claims, and retries failures with backoff. A single elected leader turns time-zone-aware cron schedules into jobs. It caps running jobs per shop so one shop cannot starve the others.

## Entry points
- `JobsService.enqueue(type, payload, options)`: other capabilities enqueue a job and receive `{ id, created }`. Options are `runAt`, `idempotencyKey`, `shopId`, `maxAttempts`.
- `JobsService.cancel` and `cancelByKey`: cancel a `QUEUED` job.
- `upsertSchedule` and `removeSchedule`: register, change or delete a recurring schedule.
- Handler decorator (`@JobHandler`): a domain registers a handler for a job type. Handlers are discovered at boot.
- Worker claim loop, reaper and cron materialiser: background loops in the worker app. [code: packages/backend/apps/worker/src/worker.module.ts#WorkerModule]
- `JobsAdminService`: operator functions `listJobs`, `getStats`, `retryDead`, `cancel`, `listSchedules`, `setScheduleEnabled`.
- `JobsAdminService.getJob(id)`: one job as a DTO (no payload), or nothing. Together with `JobsService.enqueue`, it backs the administrator's job requests that S01 hosts (`POST /admin/jobs`, `GET /admin/jobs/:jobId`).
- Daily schedule `jobs.partition-maintenance` (`15 3 * * *` UTC, concurrency 1): creates and drops partitions and expires idempotency keys.
- Metrics: `job_queue_lag_seconds`, `job_outcomes_total`, `job_duration_ms`, `job_lease_expired_total`, `cron_fires_skipped_total`, `job_default_partition_rows`.

## Rules
- **S49.R-01** A [job](../terms/job.md) MUST have exactly one [status](../terms/job-status.md) of `QUEUED`, `RUNNING`, `SUCCEEDED`, `DEAD` or `CANCELLED`. The only [legal transitions](../terms/job-status.md) are `QUEUED→RUNNING`, `RUNNING→SUCCEEDED`, `RUNNING→QUEUED`, `RUNNING→DEAD`, `QUEUED→CANCELLED` and `DEAD→QUEUED`. [proof: S49 AS-38]
- **S49.R-02** [Enqueue](../terms/job-enqueue.md) MUST join the caller's [open transaction](../terms/active-transaction.md), so the job and its key exist if and only if the caller [commits ↗](../sw-external-terms.md#database-transaction). [proof: S49 AS-02]
- **S49.R-03** [Enqueue](../terms/job-enqueue.md) without a transaction MUST commit the job before the call returns. [proof: S49 AS-08]
- **S49.R-04** Enqueue with an existing {{concept:idempotency-key}} MUST create nothing and return the original id with [`created: false`](../terms/enqueue-created-flag.md). Under [20 concurrent calls](../terms/enqueue-created-flag.md) exactly one MUST see `created: true`. [proof: S49 AS-03, S49 AS-04]
- **S49.R-05** A key reused with a different [job type](../terms/job-type.md) MUST fail with [`IdempotencyKeyConflictError`](../terms/idempotency-key-conflict-error.md), and no job is added. [proof: S49 AS-05]
- **S49.R-06** A key MUST [dedupe](../terms/idempotency-key.md) for 30 days after its job finished. After that the key is free. [proof: S49 AS-09, S49 AS-87]
- **S49.R-07** Enqueue MUST reject unknown types, [payloads that break the contract](../terms/job-payload-contract.md), and limits violations (payload over 64 KiB, key outside 1–200 characters, [`maxAttempts`](../terms/job-max-attempts.md) outside 1–25, [`runAt`](../terms/job-run-at.md) more than 366 days ahead) and MUST persist nothing. [proof: S49 AS-06, S49 AS-07]
- **S49.R-08** Two [worker](../terms/worker-instance.md)s MUST NOT [claim](../terms/job-claim.md) the same job. Claims MUST order by `runAt`, then id, and cover only types the worker has a [handler](../terms/job-handler.md) for. [proof: S49 AS-10, S49 AS-11, S49 AS-12]
- **S49.R-09** A claim MUST set the [lease](../terms/job-lease.md) to the handler's [`leaseMs`](../terms/job-lease-ms.md) counted from the claim moment. [proof: S49 AS-15]
- **S49.R-10** [Cancel](../terms/job-cancel.md) and claim MUST be [mutually exclusive ↗](../sw-external-terms.md#mutual-exclusion) on one job: the job is cancelled or run, never both. [proof: S49 AS-41]
- **S49.R-11** Every write that ends or changes an attempt MUST be [fenced](../terms/attempt-fencing.md) by worker and [attempt number](../terms/job-attempt.md), so a [stale execution](../terms/stale-worker.md) changes nothing. [proof: S49 AS-30, S49 AS-31, S49 AS-25]
- **S49.R-12** A thrown error MUST [re-queue](../terms/job-retries.md) the job with a [full-jitter delay](../terms/jitter.md) of at most `min(15 min, 1 s × 2^attempts)`. At [`maxAttempts`](../terms/job-max-attempts.md) the job MUST become [`DEAD`](../terms/job-status.md). [proof: S49 AS-17, S49 AS-18, S49 AS-19]
- **S49.R-13** [`NonRetryableJobError`](../terms/non-retryable-job-error.md), or a stored payload that breaks the contract at [claim time](../terms/job-claim.md), MUST send the job to `DEAD` at once without further attempts. [proof: S49 AS-20, S49 AS-21]
- **S49.R-14** [The reaper](../terms/job-reaper.md) MUST re-queue (or, at `maxAttempts`, kill) [`RUNNING`](../terms/job-status.md) jobs with [expired leases](../terms/job-lease.md) exactly once, even with several reaper instances. It MUST NOT alter `attempts`. [proof: S49 AS-27, S49 AS-28, S49 AS-33]
- **S49.R-15** A shop MUST NOT have more running jobs than the [per-shop cap](../terms/per-shop-running-cap.md) (default 5) [fleet-wide](../terms/fleet-wide-limit.md). A [saturated shop](../terms/job-fairness.md) MUST NOT delay other shops, and [jobs without a shop](../terms/shopless-job.md) MUST NOT be capped. [proof: S49 AS-46, S49 AS-47, S49 AS-48, S49 AS-49, S49 AS-50]
- **S49.R-16** Only one [leader](../terms/scheduler-leader.md), chosen per [tick](../terms/scheduler-tick.md) by an [advisory lock ↗](../sw-external-terms.md#advisory-lock), MUST [materialise schedules](../terms/cron-schedule-materialisation.md). Each fire MUST use [the key `cron:<name>:<fireAt ISO-8601 UTC with milliseconds>`](../terms/cron-fire-key.md). [proof: S49 AS-53, S49 AS-54, S49 AS-55, S49 AS-56]
- **S49.R-17** [Missed fires](../terms/cron-schedule-materialisation.md) MUST collapse to one [catch-up job](../terms/cron-schedule-materialisation.md), and the next fire MUST be computed from the current time. [proof: S49 AS-57]
- **S49.R-18** With [overlap `skip`](../terms/cron-overlap-policy.md) (the default) a fire MUST be skipped while an earlier job of the schedule is [`QUEUED`](../terms/job-status.md) or `RUNNING`. Policy `allow` MUST always create the job. [proof: S49 AS-58]
- **S49.R-19** Next-fire computation MUST evaluate the [cron](../terms/time-zone-aware-cron.md) on the [wall clock ↗](../sw-external-terms.md#wall-clock) of the schedule's [IANA zone ↗](../sw-external-terms.md#iana-time-zone) and return an instant strictly after the base instant. A [non-existent local time ↗](../sw-external-terms.md#daylight-saving-time) MUST fire once after the gap. A repeated local time MUST fire once, at its first occurrence. [proof: S49 AS-68, S49 AS-69, S49 AS-70, S49 AS-73]
- **S49.R-20** A schedule that fails to materialise MUST NOT block others. After 5 consecutive [failing ticks](../terms/scheduler-tick.md) it MUST be [disabled](../terms/schedule-auto-disable.md) with [`lastError`](../terms/schedule-last-error.md) set. [proof: S49 AS-65]

## Behaviors
- **S49.B-01** Given [`runAt`](../terms/job-run-at.md) is 20:00Z and the clock is 10:00Z, when a worker runs at 19:59:59Z, then the job stays [`QUEUED`](../terms/job-status.md) with [`attempts = 0`](../terms/job-attempt.md). [proof: S49 AS-01]
- **S49.B-02** Given a [caller transaction](../terms/active-transaction.md) that [enqueues](../terms/job-enqueue.md) [key `K`](../terms/job-enqueue-key.md) and rolls back, then no job and no key exist, and `K` can be enqueued later with [`created: true`](../terms/enqueue-created-flag.md). [proof: S49 AS-02]
- **S49.B-03** Given 1,000 [due jobs](../terms/job-due.md) and 4 [parallel workers](../terms/worker-instance.md), when the queue drains, then the [handler](../terms/job-handler.md) runs 1,000 times and every job is [`SUCCEEDED`](../terms/job-status.md) with `attempts = 1`. [proof: S49 AS-10]
- **S49.B-04** Given a handler with [`fleetConcurrency: 1`](../terms/fleet-concurrency.md) and 10 jobs on 3 workers, then at most 1 job of the [type](../terms/job-type.md) is [`RUNNING`](../terms/job-status.md) at any instant. [proof: S49 AS-14]
- **S49.B-05** Given a handler throws on attempt 1 and succeeds on attempt 2, then the job is [re-queued](../terms/job-retries.md) after a [delay of at most 2 s](../terms/job-retry-delay.md) and ends `SUCCEEDED`. [proof: S49 AS-17]
- **S49.B-06** Given a handler runs past [`maxRuntimeMs: 5000`](../terms/job-max-runtime.md), then its [stop signal](../terms/job-stop-signal.md) aborts with reason `timeout`, [`lastError`](../terms/job-last-error.md) is `timeout after 5000 ms`, and the [retry path](../terms/job-retries.md) runs. [proof: S49 AS-24]
- **S49.B-07** Given a worker crashes on every attempt with [`maxAttempts = 3`](../terms/job-max-attempts.md), then the [reaper](../terms/job-reaper.md) marks the job [`DEAD`](../terms/job-status.md) after the third [expired attempt](../terms/job-lease.md). [proof: S49 AS-28]
- **S49.B-08** Given a handler runs longer than its [lease](../terms/job-lease.md) while [heartbeats](../terms/job-heartbeat.md) succeed, then the [reaper](../terms/job-reaper.md) never takes the job and it ends `SUCCEEDED`. [proof: S49 AS-29]
- **S49.B-09** Given W1 [lost its lease](../terms/attempt-fencing.md) and W2 [re-claimed](../terms/job-claim.md) the job, when W1 finishes, then [W1's write changes nothing](../terms/attempt-fencing.md) and W2's result is recorded. [proof: S49 AS-30, S49 AS-32]
- **S49.B-10** Given a worker receives [shutdown ↗](../sw-external-terms.md#graceful-shutdown) with 3 jobs finishing within [25 s](../terms/shutdown-deadline.md), then it [stops claiming](../terms/job-claim.md) and the 3 jobs end `SUCCEEDED`. [proof: S49 AS-34, S49 AS-36]
- **S49.B-11** Given a job still runs at the [drain deadline](../terms/shutdown-deadline.md), then its [signal aborts ↗](../sw-external-terms.md#abort-signal) with reason `shutdown` and the job returns to [`QUEUED`](../terms/job-status.md) with [`runAt = now`](../terms/job-run-at.md) and [the attempt refunded](../terms/job-attempt.md). [proof: S49 AS-35]
- **S49.B-12** Given the database is unreachable for 10 s, then the [claim loop](../terms/job-claim.md) logs, retries with [backoff and jitter ↗](../sw-external-terms.md#exponential-backoff), [keeps the process healthy](../terms/health-probes.md) and resumes. [proof: S49 AS-37]
- **S49.B-13** Given a `QUEUED` job, when [`cancel`](../terms/job-cancel.md) runs, then the outcome is `CANCELLED`. For [`RUNNING`](../terms/job-status.md), `SUCCEEDED`, `DEAD` or `CANCELLED` it is [`CONFLICT`](../terms/job-cancel-outcome.md) with the status. For an unknown id, or [another shop's job](../terms/shop-tenant.md), it is `NOT_FOUND`. [proof: S49 AS-39, S49 AS-40, S49 AS-43]
- **S49.B-14** Given a [`DEAD`](../terms/job-status.md) job, when an [operator](../terms/operator.md) retries it, then it is `QUEUED` with [`attempts = 0`](../terms/job-attempt.md) and an [audit log line](../terms/audit-log.md). Of two concurrent retries exactly one returns [`RETRIED`](../terms/job-retry-outcome.md). [proof: S49 AS-44, S49 AS-45]
- **S49.B-15** Given an enabled [`0 9 * * *` ↗](../sw-external-terms.md#cron-expression) Europe/Warsaw [schedule](../terms/cron-schedule-materialisation.md) due at 07:00Z, when the [leader ticks](../terms/scheduler-leader.md), then one job exists with key [`cron:s:2026-10-07T07:00:00.000Z`](../terms/cron-fire-key.md). [proof: S49 AS-53]
- **S49.B-16** Given all instances were down for 3 days over a daily schedule, then one [catch-up job](../terms/cron-catch-up.md) is created and no burst of 3 jobs occurs. [proof: S49 AS-57]
- **S49.B-17** Given 8 [replicas](../terms/worker-instance.md) call [`upsertSchedule`](../terms/upsert-schedule.md) with one definition at boot, then all succeed and one schedule row exists. [proof: S49 AS-60]
- **S49.B-18** Given an invalid cron, unknown zone, [unregistered type](../terms/job-type-registry.md), bad payload, bad name or [`maxAttempts`](../terms/job-max-attempts.md) outside 1–25, then `upsertSchedule` fails with [`InvalidScheduleError`](../terms/invalid-schedule-error.md). [proof: S49 AS-61, S49 AS-76]
- **S49.B-19** Given `0 9 * * *` in [Europe/Warsaw ↗](../sw-external-terms.md#iana-time-zone), then [the fire after](../terms/cron-schedule-materialisation.md) `2027-03-26T12:00Z` is `2027-03-27T08:00Z`, and after `2027-10-30T12:00Z` it is `2027-10-31T08:00Z`. [proof: S49 AS-68]
- **S49.B-20** Given a schedule is [disabled](../terms/schedule-enabled.md) for 2 days and re-enabled, then the next fire is computed from now with [no catch-up](../terms/cron-catch-up.md). [proof: S49 AS-62]

## Lifecycles
Statuses: `QUEUED`, `RUNNING`, `SUCCEEDED`, `DEAD`, `CANCELLED`. The claim moves `QUEUED→RUNNING`. The worker moves `RUNNING` to `SUCCEEDED`, `QUEUED` (retry or shutdown release) or `DEAD`. The reaper moves expired `RUNNING` jobs to `QUEUED` or `DEAD`. Cancel moves `QUEUED→CANCELLED`. An operator moves `DEAD→QUEUED`. No model file exists for this capability.

## Owns
- The job tables, owned by `infrastructure:jobs` in the ownership registry, with no foreign keys to domain tables. `shopId` is a plain identifier column. [code: packages/backend/db/ownership.ts#OWNERSHIP]
- Migration `packages/backend/migrations/20261001110000-create-jobs.js`.
- Daily creation-date partitions, a default partition, and idempotency keys.
- The schedule `jobs.partition-maintenance`.
- Metrics listed under Entry points.
- Configuration: job settings are read through `ApiConfigService` (`jobsConfigKeys`), including the per-shop cap (default 5). [code: packages/backend/libs/common/config/api-config.service.ts#ApiConfigService]

## Decisions
- Claims use row-lock skip-locked semantics, so workers never block each other and never claim one job twice.
- Every write is fenced by claim identity, so a worker that lost its lease cannot overwrite a newer attempt (at-least-once delivery).
- Retry delays use full jitter with a 15-minute ceiling, so retries do not arrive in waves.
- One leader per tick, chosen by a transaction-scoped advisory lock, materialises schedules; the fire key makes a duplicate harmless.
- Missed fires collapse to one catch-up job, so downtime does not cause a burst.
- A per-shop cap with no head-of-line blocking keeps one shop from starving the others.
- Job tables are owned by `infrastructure:jobs` and other capabilities use only exported services.
- The in-process local ticker (every replica runs it) MUST NOT be used for once-per-schedule work; that work is a schedule.

## Known gaps
- No test carries a scenario id for DST-sensitive behaviors beyond those listed. AS-95 (exhaustiveness) is compile-time only and is not stated as a rule.
- The specification marks AS-77 to AS-83 (metrics, logging, ambient context, admin listing and stats) as P2. This page states them only through the Entry points. No rule or behavior here cites them.
- P2 retention rules are not stated as rules: partition creation (AS-84), drop conditions (AS-85), default partition (AS-86), the 10,000-key batch (AS-87), index use (AS-88), bloat (AS-89) and the 5 s lock timeout (AS-90).
- Handler registry rules (AS-91 to AS-94), the explicit `ctx.heartbeat()` and the handler context fields (AS-22) have tests but no rule here.
- Completion retry (3 tries, AS-26) and `lastError` truncation at 2,000 characters (AS-23) have tests but no rule here.
- The code facts list only the worker module, the ownership registry, the config service and the migration. The enqueue, claim, reaper and cron code files and symbols are not listed, so most rules carry no `` link.
- The facts do not show the 2 s materialisation bound (FR-039) or the 500-schedule tick limit (FR-037) in code. AS-64 is tested but not stated as a rule.
- Rule R-08 and R-09 rest on e2e tests of the worker; a database outage during completion (AS-26) leaves the job `RUNNING` until the lease expires.

### Claims the generator could not verify (removed from the rules above)
- code ref `...` (file not found: ...)
