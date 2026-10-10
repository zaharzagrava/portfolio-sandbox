# Contract: exported services of `@app/infrastructure/jobs` (enqueue side)

Source of truth for shapes: spec.md "Provides". No HTTP surface. Changes against today's code are marked BREAKING in questions.md.

## `JobsService`

| Method | Result | Errors |
|---|---|---|
| `enqueue(type, payload, { runAt?, idempotencyKey?, shopId?, maxAttempts? })` | `{ id, created }`; joins the CLS transaction when active, else commits alone | `UnknownJobTypeError`, `InvalidJobPayloadError{fields}`, `InvalidEnqueueOptionsError{field}`, `IdempotencyKeyConflictError{key, existingType}` |
| `cancel(jobId, { shopId? })` | `{outcome:'CANCELLED'}`, `{outcome:'NOT_FOUND'}` or `{outcome:'CONFLICT', status}` | none (another shop's job gives `NOT_FOUND`) |
| `cancelByKey(key, { shopId? })` | same | none |
| `upsertSchedule({ name, cron, timezone?, jobType, payload, enabled?, overlap?, maxAttempts? })` | `void`, idempotent, safe concurrently | `InvalidScheduleError{field}` |
| `removeSchedule(name)` | `boolean` | none |

## Registration

- `declareJobType({ name, contract, maxAttempts?, leaseMs? })` next to the `JobPayloads` augmentation; loadable without the handler.
- `@JobHandler(type, { leaseMs?, concurrency?, fleetConcurrency?, maxRuntimeMs? })`; invalid options or a duplicate provider fail startup.
- `JobContext { jobId, attempt, maxAttempts, isLastAttempt, heartbeat(), signal }`; `signal.reason` is `'timeout'`, `'lease_lost'` or `'shutdown'`.
- `NonRetryableJobError` unchanged.

## Guarantees

At-least-once; same key gives one job; single run per schedule fire; strict per-shop cap; retries ≤ `maxAttempts`; completion fenced by `(worker, attempt)`.

## Metrics (names fixed, FR-052)

`job_queue_lag_seconds{type?}`, `job_outcomes_total{type,outcome}`, `job_duration_ms{type}`, `job_dead_jobs{type}`, `job_lease_expired_total{type}`, `cron_fires_total{schedule}`, `cron_fires_skipped_total{schedule}`, `cron_leader`, `job_default_partition_rows`.
