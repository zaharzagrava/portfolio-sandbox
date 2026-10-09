# Questions and defaults: S49 — Distributed job scheduler

Every open choice was resolved by the decision policy (most production-grade option the notes and constitution support). Tags: `[BREAKING]` changes behaviour or an API/UI contract that exists today; `[CONTRACT]` decides something another capability provides or consumes; `[LOCAL]` affects only this capability. Sorted by impact, BREAKING first.

## BREAKING

- [BREAKING] `JobsService.cancel` return type → discriminated `CANCELLED | NOT_FOUND | CONFLICT(status)` plus optional `{ shopId }` scope, and new `cancelByKey` (today `Promise<boolean>`, unscoped by tenant) → callers need to tell "already running" from "unknown", and III.4 forbids id-only lookup of a tenant record; callers of `cancel` must be updated.
- [BREAKING] Enqueue of an unregistered job type, or a payload that violates the type's runtime contract, is rejected (`UnknownJobTypeError`, `InvalidJobPayloadError`) → required (today only compile-time `JobPayloads` typing; any string cast gets through) → notes' "discriminated-union job types (`JobType` → payload schema)" and IV.5 zod validation; every domain that enqueues must declare its type contract.
- [BREAKING] Schedule overlap policy `skip` is the default (today every fire is queued even if the previous run is still going) → skip with a counter, `allow` opt-in → sweeps and reconcilers must not pile up; affects every registered schedule.
- [BREAKING] Reaper marks a job `DEAD` once `attempts ≥ maxAttempts` and re-queues with backoff otherwise (today it re-queues at once forever) → a worker-killing job must terminate and not hot-loop → notes: "DEAD after N; reaper for expired leases".
- [BREAKING] Per-shop running cap becomes a strict fleet-wide invariant, including inside one claim batch and across concurrent claimers (today a batch of 50 can take 50 jobs of one shop, and two claimers can both pass the check) → III.6 (invariants by the store, not check-then-write); changes claim query and may need a per-shop lock or counter.
- [BREAKING] `@JobHandler` `concurrency` stays per worker instance and a new `fleetConcurrency` option gives fleet-wide limits; schedules and handlers that promise "concurrency 1" (S05, S34, S45) must use `fleetConcurrency: 1` → today "concurrency 1" is only per instance and two workers run it twice.
- [BREAKING] Same idempotency key with a different job type throws `IdempotencyKeyConflictError` (today the first job is silently returned) → V.6 analogue (key misuse is an error); payload differences are still ignored (see LOCAL).
- [BREAKING] Idempotency keys expire 30 days after the job finished (today `JobKey` rows live forever) → unbounded table growth otherwise; callers must not depend on a key blocking beyond 30 days.
- [BREAKING] Duplicate `@JobHandler` for one type in different providers fails startup (today logged at debug and ignored) → silent shadowing of a handler is a production bug; same provider seen twice stays ignored.
- [BREAKING] Graceful shutdown releases jobs still running after the drain deadline back to `QUEUED` with the attempt refunded (today they stay `RUNNING` until the lease expires, up to the handler lease) → faster recovery on deploys and no attempt burned by a deploy.
- [BREAKING] New hard `maxRuntimeMs` per handler (default 15 min) aborts a hung handler and retries (today a hung handler heartbeats forever) → notes ask for max runtime; handlers with legitimately longer runs (S34 1 h lease, S33 10 min) must raise it.
- [BREAKING] Handler lease is applied at claim time (today claim sets 60 s then a second statement extends) → no window where a long-lease job is reapable.
- [BREAKING] `upsertSchedule` throws typed `InvalidScheduleError` and validates zone, job type, payload and name (today a generic `Error` and only cron+zone checks); also adds `overlap` and `maxAttempts`; `removeSchedule` added → callers catching `Error` text break; S08's renamed schedules need `removeSchedule` for the old names.
- [BREAKING] DST semantics fixed: nonexistent local time fires once after the gap, ambiguous local time fires once at first occurrence, wildcard-hour schedules fire every elapsed hour → today's behaviour is whatever the `cron` library does and is unverified; implementation must verify and wrap.
- [BREAKING] Partition drop moves into a database function resolving names from the catalog, and keeps partitions holding `DEAD` jobs finished within retention (today `DROP TABLE "${name}"` is built in application SQL and recent `DEAD` rows can be dropped) → IX.5 forbids dynamically built table names; operators lose evidence otherwise.
- [BREAKING] Other domains' e2e specs stop querying `"Job"` directly (`onboarding.e2e-spec.ts`, `webhooks.e2e-spec.ts`, `notifications.e2e-spec.ts`) and use `JobsAdminService` or a test probe → IX.4/IX.6; those three specs must be updated.
- [BREAKING] `JobContext` gains `jobId`, `maxAttempts`, `isLastAttempt` (additive) and the stop signal now aborts with typed reasons `timeout | lease_lost | shutdown` → additive, existing handlers keep working; listed so tests are updated.

## CONTRACT

- [CONTRACT] S15 needs enqueue in the caller's transaction with key, `attempt` and `maxAttempts` in the handler, backoff with jitter, delayed `runAt`, cooperative stop → all provided under the same names (`JobsService.enqueue`, `JobContext`, `signal`).
- [CONTRACT] S27 needs a permanent-failure outcome and a single-run sweep → `NonRetryableJobError` kept with the same name; `stories.publish-due-sweep` is a normal schedule.
- [CONTRACT] S26 (community) owns no SQL table and needs jobs usable without a SQL transaction → enqueue without a caller transaction commits on its own (AS-08); its durable event recording stays in its own store and is not S49's concern.
- [CONTRACT] S23 notes "S49's schedule granularity is minutes" → differ: schedules support a seconds field and resolve in 1 s (AS-67); S23 may still keep its 1 s publisher as an in-process loop, which is the recommended choice; no change needed from S23.
- [CONTRACT] S05, S11, S21 want 10 s and 30 s periodic jobs → supported via six-field cron; tick period 1 s, materialised within 2 s of due.
- [CONTRACT] S14 wants retries ≤ 3 on its jobs → schedules and enqueues accept `maxAttempts` 1–25; S14 sets 3.
- [CONTRACT] S33 lease 600,000 ms and S34 lease 1 h, concurrency 1 → `leaseMs` allowed up to 4 h; S34 uses `fleetConcurrency: 1`.
- [CONTRACT] S01 hosts the operator HTTP routes (list, stats, retry, cancel, schedules) over `JobsAdminService`, ADMIN role only → S49 does not own HTTP routes because infrastructure libs must not import identity (X.5); S01 must add them. This is new work for S01.
- [CONTRACT] Job names and cron expressions belong to the registering capability, not S49 → S49 provides generic registration; the table in the spec lists the names other specs declared, and the names must match exactly.
- [CONTRACT] S54 provides the injectable clock, metrics registry, request context with originating trace, shutdown registry and config validation keys `jobs.perShopRunningCap`, `jobs.claimBatch`, `jobs.retainDays` → named in Requires.
- [CONTRACT] S53 owns the outbox poller, which stays on the every-replica local ticker (`CronService`), not on this scheduler → documented in FR-060 so nobody moves it by mistake.

## LOCAL

- [LOCAL] Delivery guarantee → at-least-once, no exactly-once claim → notes.
- [LOCAL] Per-transition history table → none; job row, metrics and logs carry the history → the IX.3 technical-table allowlist is closed and a history row doubles writes; deviation from III.7 noted in `plan.md` Complexity Tracking.
- [LOCAL] Same key with different payload → first job wins, no error → retries of an enqueue may regenerate payload details.
- [LOCAL] Limits → payload 64 KiB, key 200 characters, `maxAttempts` 1–25 (default 8), `runAt` ≤ 366 days ahead → bounded rows; far-future work is the managed-scheduler next step.
- [LOCAL] Retention → 30 days after finish; keys purged in batches of 10,000.
- [LOCAL] Retry delay → full jitter, ceiling `min(15 min, 1 s × 2^attempts)`.
- [LOCAL] Per-shop cap → 5 by default via config, one value for all shops; per-shop overrides deferred.
- [LOCAL] Claim batch → 50 by default via config; idle poll 500 ms.
- [LOCAL] Lease range → 5 s – 4 h; default 60 s; heartbeat at half the lease.
- [LOCAL] Drain deadline → 25 s, matches the shutdown registry timeout.
- [LOCAL] Cron dialect → 5 fields plus optional leading seconds; no `L`/`W`/`#`.
- [LOCAL] Materialiser batch → 500 due schedules per tick; auto-disable after 5 consecutive failing ticks.
- [LOCAL] Catch-up after outage → one job, key from the first missed fire.
- [LOCAL] Clock skew → assume NTP within 1 s across replicas; minimum lease 5 s.
- [LOCAL] Schedule name pattern → `^[a-z0-9]+([._-][a-z0-9]+)*$`, max 100; job type pattern `<domain>.<action>` kebab-case.
- [LOCAL] Admin list limit → default 50, max 100, keyset on creation time then id.
- [LOCAL] `CronService` (every-replica ticker) → kept for pollers only; whether `identity/users.module.ts` still needs `CronModule` is for implementation to check and drop if unused.
- [LOCAL] Offload beyond 5–10k jobs/s → documented next step, not built.

## BLOCKER (implementation, found while writing `jobs-retention.e2e-spec.ts`)

- **AS-89 (HOT update ratio ≥ 90%) cannot hold together with AS-88 / FR-050 on the current table design.** Measured on the test database (PostgreSQL 18.6): `UPDATE scratch SET status = 'RUNNING'` on a table with `CREATE INDEX ON t ("runAt") WHERE status = 'QUEUED'` produced 0 heap-only updates; the same update with no index that mentions `status` produced heap-only updates up to the free space of the page. The jobs e2e `S49 AS-89` row (500 claim-and-complete cycles, 1,000+ updates) measured exactly 0% heap-only. Cause: PostgreSQL treats every column that appears in an index key **or in a partial-index predicate** as indexed. Both halves of a cycle change such columns: the claim sets `status` (predicate of `Job_due_idx`, `Job_running_*_idx`, `Job_cron_active_idx`), `lockedUntil` (key of `Job_running_lease_idx`) and the completion sets `status` again. The claim path needs the partial `Job_due_idx ... WHERE status = 'QUEUED'` (AS-88: cost independent of finished history), so a claim can never be heap-only. The comment in `20261001110000-create-jobs.js` ("fillfactor 70 ... so status/lock updates are HOT updates") is therefore wrong for status changes; fillfactor 70 only helps updates of columns that no index mentions (`attempts`, `lastError`, `lockedBy`).
- What I did: left the AS-89 test in place, unchanged, so it fails honestly (not skipped, not weakened). Everything else of S49 is built and green.
- Options for the human (pick one; none is a code-only fix):
  1. Keep AS-88, replace AS-89 by a property the design can meet: dead-tuple bloat stays bounded (autovacuum keeps `n_dead_tup` of the live partitions below a fraction of live rows after N cycles) and the per-partition `fillfactor` stays 70. My preference.
  2. Move the queue state out of `Job` into a narrow, separately vacuumed structure (needs a constitution IX.3 amendment for a new technical table); `Job` keeps cold columns and could then be updated heap-only.
  3. Drop the partial due index and accept a full `runAt` index with a status filter: AS-88 then fails once finished rows pile up.
- The numbers: partial index on status, status update: 0 HOT of 200; no status index: 54 HOT of the next 200 (page space bound).
