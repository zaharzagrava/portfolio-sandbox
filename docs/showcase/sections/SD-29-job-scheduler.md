# SD-29 — Distributed Job Scheduler / Background Jobs

Status: ☑ done (typechecked; spec + benchmark written, not run) · Phase 0 · Depends on: F-01 · Used by: SD-19 (hold expiry), 21, 22 (auction close), 24 (billing runs, dunning), 17 (scheduled sends), 35, 36, 41 (period close)

## Marketplace adaptation
"Close the iPhone-17 drop auction at 20:00:00", "charge Marketplace Plus renewals", "release unpaid seat holds", "send the price-drop digest at 9am local time", "re-crawl competitor URLs every 6 h". One job system with one-off delayed jobs + cron schedules.

## Existing code
`cron/` module (`@nestjs/schedule` — runs in every replica → wrong at scale), outbox poller with `SKIP LOCKED`.

## Patterns showcased
| Pattern | Lesson |
|---|---|
| Jobs table + `FOR UPDATE SKIP LOCKED` claim in batches, lease (`locked_until`), heartbeat extension | 10/09 #29, 03/02 §5 |
| Retries with exponential backoff + jitter → `DEAD` after N; reaper for expired leases | 06/03 §2 |
| Idempotency per job (`idempotency_key` unique) and per cron fire (`UNIQUE(schedule_id, fire_at)`) | 10/09 #29 |
| **Leader election with Postgres advisory lock** for the cron materialiser (one active instance) | 03/02 §5, 02/05 |
| Per-tenant fairness: max concurrent jobs per shop (claim query excludes saturated shops) | 10/04 #2 noisy neighbours |
| Partitioned `Job` table by `run_at` (daily range partitions, drop old partitions instead of DELETE) | 03/03 §4, README #11 |
| Metrics: queue lag (now − oldest due run_at), failures by type, duration percentiles | 07/02 |
| Time-zone-aware cron (Luxon) — DST-safe next-fire computation | 01/01 §10 |
| Handler registry with discriminated-union job types (`JobType` → payload schema) | 01/02 §2 |

## Steps
- [x] Migration: `Job` (partitioned by `runAt`), `JobSchedule` (cron expr, tz, next_fire_at), `JobScheduleFire`.
- [x] `libs/common/src/jobs/` — `JobsService.enqueue(type, payload, { runAt, idempotencyKey, shopId })`, `@JobHandler('auction.close')` decorator + discovery (`DiscoveryService`), `JobWorker` (claim loop, concurrency, heartbeat, graceful drain), `JobReaper`, `CronMaterializer` (advisory-lock leader).
- [x] `apps/worker/` — dedicated worker app running job workers + projectors? (keep projectors in `apps/projector`; jobs here). Scaled on queue lag.
- [x] Partition maintenance job (creates future partitions, drops > 30 days).
- [x] Migrate existing `cron/` usages onto it. → only user is the outbox poller (2 s cadence, a poller not a job) - intentionally left on `CronService`.
- [x] Shared-logic specs (real Postgres): 4 workers claim 1,000 due jobs in parallel → each executed exactly once; expired lease reaped; cron next-fire across DST (pure).

## Scale
- Target: 5k jobs/s execution, 50M scheduled jobs outstanding.
- Hot path: enqueue = 1 insert (or batched insert); claim = 1 indexed `SKIP LOCKED` query per 100 jobs per worker. Workers are stateless and horizontal.
- First bottleneck & fix: claim contention on one table → partition by `runAt` + partial index `WHERE status='QUEUED'`; past ~5–10k jobs/s, overflow far-future jobs to **EventBridge Scheduler** (AWS) and near-term bulk work to SQS (D18). Documented as next step.
- Partitioning: range by `runAt` (daily); shard key `shopId` for fairness.
- Capacity model: 1 claim query (~2 ms) per 100 jobs → one worker loop ≈ 50k claims/s theoretical; DB write cost of status updates is the real limit (~2 writes/job) → 5k jobs/s ≈ 10k writes/s on a db.r6g.xlarge-class primary.
- Proof: k6 enqueues 50k jobs due now; drain time at 1/2/4 workers (linear), no job executed twice (idempotency counter check).

## FE visualisation (phase 2)
Admin: job queue lag, dead jobs with retry button.

## Implementation notes (2026-10-01)
- Migration `20261001110000-create-jobs`: `Job` partitioned by **createdAt** (daily; retries never move rows between partitions, which would break concurrent `SKIP LOCKED`), `Job_default` catch-all, partial indexes (due / expired leases / running per shop), fillfactor 70 (HOT updates), `JobKey` (global idempotency PK across partitions), `JobSchedule`, `job_ensure_partitions()`.
- `libs/common/src/jobs/`: `JobPayloads` extended per domain via **module augmentation**; `JobsService.enqueue` (single statement dedupe+insert, joins caller tx via CLS → transactional enqueue, race-safe fallback read), `cancel`, `upsertSchedule`; `@JobHandler(type, { leaseMs, concurrency })` + `JobRegistry` (DiscoveryService); `JobWorker` (claim batch with per-shop running cap, lease heartbeat, fenced completion `lockedBy = me`, full-jitter backoff, DEAD, AbortSignal on shutdown, CLS context per job, metrics); `JobMaintenance` (advisory-xact-lock cron materializer with `cron:<name>:<fireAt>` keys, missed fires collapsed, reaper, `job_queue_lag_seconds` gauge, partition create/drop job, `jobs.noop`); `cron.ts` (DST-safe next fire via `CronTime`).
- `JobsModule` (enqueue, any app) vs `JobsWorkerModule` (execution, `apps/worker` only). New app `apps/worker` (`start:dev:worker`).
- Spec `jobs/jobs.e2e-spec.ts`: 4 parallel workers × 400 jobs exactly once; retries; DEAD; concurrent idempotent enqueue; lease reaping; concurrent cron ticks → one job; DST (expected values verified against the real `cron` lib).
- Benchmark `scripts/load-tests/jobs-drain.js` (`pnpm loadtest:jobs`): drain time/throughput at 1/2/4 workers + re-execution count.
