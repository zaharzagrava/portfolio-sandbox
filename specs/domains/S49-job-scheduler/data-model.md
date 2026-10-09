# Data Model: S49

Owner `infrastructure:jobs` for `Job` (plus partitions via parent), `JobKey`, `JobSchedule`; no foreign keys to domain tables; `shopId` is a plain UUID. No new table (IX.3 allowlist closed).

## Migration `<ts>-jobs-hardening.js` (expand-only, `SET LOCAL lock_timeout='5s'`, idempotent `IF NOT EXISTS`)

| Object | Change | Gap / FR |
|---|---|---|
| `Job."enqueuedByRequestId"` TEXT NULL, `Job."traceparent"` TEXT NULL | add | G-07, FR-054 |
| `Job."scheduleName"` TEXT NULL | add; set by materialiser | R-07, FR-035 |
| `Job."type"`-bearing `JobKey."type"` TEXT NULL | add; written at enqueue; null for legacy rows (conflict check falls back to the job row) | G-03, FR-004 |
| `JobKey."createdAt"` TIMESTAMPTZ NOT NULL DEFAULT now() (if absent) + index `JobKey_createdAt_idx` | add | G-04, FR-005 |
| `JobSchedule."overlap"` TEXT NOT NULL DEFAULT 'skip' CHECK in (`skip`,`allow`); `"maxAttempts"` INT NULL CHECK 1–25; `"consecutiveFailures"` INT NOT NULL DEFAULT 0; `"lastError"` TEXT NULL | add | G-28, G-29, G-30 |
| Index `Job_running_type_idx ("type") WHERE status='RUNNING'` | add | G-12, G-27 |
| Index `Job_running_shop_idx ("shopId") WHERE status='RUNNING' AND "shopId" IS NOT NULL` | add | G-24b |
| Index `Job_list_idx ("status","type","createdAt" DESC,"id" DESC)` | add | G-27, FR-055 |
| Index `Job_cron_active_idx ("scheduleName") WHERE status IN ('QUEUED','RUNNING') AND "scheduleName" IS NOT NULL` | add | R-07 |
| `Job_due_idx` | keep; AS-88 plan test decides whether `(type, runAt)` is needed | G-27 |
| SQL function `job_drop_expired_partitions(int,int)` | add | G-24, R-06 |
| SQL function/query for default-partition row count | add | G-34 |

Indexes on partitioned `Job` are created on the parent (partitions inherit); no `CONCURRENTLY` possible on the parent, so the migration creates them on the parent with `lock_timeout` and the table is small at deploy time; a note in the migration documents the per-partition `CONCURRENTLY` path for a large table. Contract step (dropping nothing) is not needed.

## Entities

**Job**: `id` (uuidv7), `createdAt` (partition key; the fence uses the exact text value), `type`, `payload` JSONB, `status` ∈ {QUEUED, RUNNING, SUCCEEDED, DEAD, CANCELLED}, `runAt`, `attempts`, `maxAttempts`, `lockedBy`, `lockedUntil`, `lastError` (≤ 2,000), `shopId`, `idempotencyKey`, `finishedAt`, `enqueuedByRequestId`, `traceparent`, `scheduleName`.

Transitions (`job-state.ts`, pure; every SQL change is a conditional update from one named status):

```text
QUEUED -claim-> RUNNING -complete-> SUCCEEDED
RUNNING -retry|reap|release-> QUEUED      RUNNING -fail(last)|reap(last)|invalid payload|NonRetryable-> DEAD
QUEUED -cancel-> CANCELLED                DEAD -operator retry-> QUEUED (attempts=0, runAt=now, finishedAt cleared)
```

**JobKey**: `idempotencyKey` (PK, 1–200 chars), `jobId`, `type`, `createdAt`. Purged 30 days after the job finished, batches of 10,000.

**JobSchedule**: `name` (PK, pattern, ≤ 100), `cron`, `timezone`, `jobType`, `payload`, `enabled`, `overlap`, `maxAttempts`, `nextFireAt`, `lastFiredAt`, `consecutiveFailures`, `lastError`. Rules: cron/zone change recomputes `nextFireAt` from now; enable computes from now; 5 consecutive failing ticks disable.

**Job type declaration (in memory)**: `{ name, contract: ZodType, maxAttempts?, leaseMs? }`. **Handler registration (in memory)**: `{ type, leaseMs 5s–4h, concurrency ≥ 1, fleetConcurrency?, maxRuntimeMs ≥ leaseMs default 15 min }`.

**Claim identity**: `(id, createdAt, lockedBy, attempts)`.

## Validation limits (enqueue-options.ts)

payload ≤ 64 KiB serialised; key 1–200; `maxAttempts` 1–25 (default: option, schedule, type default, 8); `runAt` valid date ≤ now + 366 d (past allowed).

## Ownership registry

`db/ownership.ts` already lists `Job`, `JobKey`, `JobSchedule` as `infrastructure:jobs` (lines 179–181). P9 confirms `Job_default` / `Job_YYYYMMDD` are covered through the parent and records `check:table-ownership --strict` output.
