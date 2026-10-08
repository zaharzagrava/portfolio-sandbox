# Feature Specification: S49 — Distributed job scheduler

**Feature Branch**: `S49-job-scheduler` (spec directory only; no branch is created by this run)

**Created**: 2026-10-06

**Status**: Draft

**Domain**: `infrastructure` (lib `libs/infrastructure/jobs`; technical tables `Job` with its partitions, `JobKey`, `JobSchedule`, owner `infrastructure:jobs`, allowlisted by constitution IX.3)

**Input**: "Distributed job scheduler: SKIP LOCKED leases, retries, cron leader, fairness, tz-aware cron"

## Summary

Every other capability needs work to happen later, once, or on a clock: close an auction at 20:00:00, release an unpaid hold, charge a renewal, send a digest at 09:00 local time, re-crawl a competitor every 6 hours. This capability is the one place that does it. It offers three things to the rest of the platform:

1. **Delayed one-off jobs**: "run this at time T, at most once per key, retried safely if it fails", enqueued in the same transaction as the business change that causes it.
2. **Recurring schedules**: "run this on a cron expression in a time zone, once per fire across all replicas", with daylight-saving handling that keeps local wall-clock time.
3. **A fair, observable worker fleet**: workers claim due jobs without stepping on each other, one shop's backlog cannot starve the others, a crashed worker's jobs are recovered, and operators can see lag, failures and dead jobs.

Delivery is **at-least-once**. A job can run more than once (a worker can crash after doing the work and before recording it), so every handler is idempotent, and this capability supplies the keys and fencing that make that cheap.

## Scope

In scope:

- Enqueue, cancel, retry of dead jobs, and the job lifecycle (`QUEUED`, `RUNNING`, `SUCCEEDED`, `DEAD`, `CANCELLED`).
- Handler registration, per-type payload contracts, lease, heartbeat, concurrency limits, retry policy, non-retryable failure.
- Worker claim loop, reaper of expired leases, graceful shutdown.
- Recurring schedules: registration, validation, time-zone-aware next-fire computation, single-run materialisation under leader election, missed-fire and overlap policy.
- Per-shop fairness at claim time.
- Table retention: daily partitions created ahead and dropped when finished; idempotency-key expiry.
- Metrics, logs and trace propagation for jobs; an operator-facing service for listing, statistics, retry and cancel.

Out of scope (owned elsewhere, named so nobody re-specifies them):

- The business logic of any job (each domain owns its handler). This capability never reads a domain's tables.
- HTTP routes for the operator console and its UI. This capability provides the exported service they call (R1); the routes live with the platform-admin surface (S01) and the admin page is a later web capability (SD-29 "FE visualisation, phase 2").
- The outbox poller. It is a two-second poller on every replica, not a job; it stays on the local ticker (see FR-060) and belongs to S53.
- Offloading far-future one-off jobs to a managed scheduler beyond 5–10k jobs/s. Documented as the next step, not built (Assumptions).
- Metrics registry, clock, config validation, graceful-shutdown registry, request context: provided by S54 and consumed here.

## User Scenarios & Testing *(mandatory)*

Actors: **a domain service** (enqueues and registers), **a worker instance** (claims and runs), **the cron leader** (the single instance that materialises schedules on a given tick), **a platform operator** (watches lag, retries dead jobs), **a shop** (a tenant whose jobs are capped so it cannot starve others).

### User Story 1 - Enqueue delayed work safely (Priority: P1)

A domain service enqueues "close auction A at 20:00:00" inside the same transaction that creates the auction. If the transaction rolls back there is no job; if the service retries the enqueue there is still one job.

**Why this priority**: every other capability depends on it; it is the contract surface.

**Independent Test**: enqueue with `runAt`, an idempotency key and a shop inside a transaction; roll back once, commit once; replay with the same key; assert persisted rows.

**Acceptance Scenarios**:

1. **AS-01** — **Given** the clock is `2026-10-06T10:00:00Z`, **When** a service enqueues `jobs.noop` with `runAt = 2026-10-06T20:00:00Z`, **Then** `enqueue` returns `{ id, created: true }`, one job exists with status `QUEUED`, `attempts = 0`, `runAt = 20:00:00Z`; **When** a worker runs at `19:59:59Z`, **Then** the job is not claimed; **When** a worker runs at `20:00:00Z`, **Then** it is claimed.
2. **AS-02** — **Given** a caller transaction that enqueues a job with key `K` and then rolls back, **Then** no job row and no key row exist and the key `K` can be enqueued again later with `created: true`; **Given** the same transaction committing, **Then** the job and its key exist together.
3. **AS-03** — **Given** a job exists for key `K`, **When** the same key is enqueued again (same type), **Then** the result is `{ id: <existing id>, created: false }`, still one job, and the stored `runAt` and payload are those of the first call.
4. **AS-04** — **Given** 20 concurrent enqueues (`Promise.all`) of the same key `K` from separate connections, **Then** exactly one result has `created: true`, all 20 results carry the same `id`, and one job exists.
5. **AS-05** — **Given** a job of type `a.x` exists for key `K`, **When** type `b.y` is enqueued with key `K`, **Then** the call fails with `IdempotencyKeyConflictError` (carries the key and the existing type) and no job is added.
6. **AS-06** — **Given** a type with a registered payload contract, **When** the payload violates it, **Then** the call fails with `InvalidJobPayloadError` listing the offending fields and nothing is persisted; **When** the type is not registered, **Then** it fails with `UnknownJobTypeError` and nothing is persisted.
7. **AS-07** — **Given** the limits (payload ≤ 64 KiB serialised, key 1–200 characters, `maxAttempts` 1–25, `runAt` a valid date no more than 366 days ahead), **When** each limit is violated in turn, **Then** each call fails with `InvalidEnqueueOptionsError` naming the field, and nothing is persisted. A `runAt` in the past is accepted and runs as soon as possible.
8. **AS-08** — **Given** a caller with no SQL transaction (a store with no relational transaction, e.g. S26 community), **When** it enqueues, **Then** the job is created on its own and committed before the call returns.
9. **AS-09** — **Given** key `K` belongs to a job that finished more than the retention period (30 days) ago and whose partition was dropped, **When** `K` is enqueued, **Then** a new job is created with `created: true`; **Given** the job finished 29 days ago, **Then** the call returns `created: false`.

---

### User Story 2 - Workers run each due job once, in order, without stepping on each other (Priority: P1)

Many worker instances run in parallel. Each due job is claimed by exactly one of them and the handler runs for one claim at a time.

**Why this priority**: it is the core promise of a `SKIP LOCKED` job table.

**Independent Test**: seed 1,000 due jobs, start four workers, drain, count handler invocations per job.

**Acceptance Scenarios**:

1. **AS-10** — **Given** 1,000 due jobs of one type and 4 workers claiming in parallel, **When** the queue drains, **Then** the handler was invoked exactly 1,000 times with 1,000 distinct job ids, every job is `SUCCEEDED` with `attempts = 1`, `finishedAt` set, and no lock fields remain.
2. **AS-11** — **Given** due jobs with `runAt` 10:00, 10:05 and 10:03 and one with `runAt` in the future, **When** a worker claims a batch of 2, **Then** it receives the 10:00 and 10:03 jobs (oldest `runAt` first, ties by id) and the future job is untouched.
3. **AS-12** — **Given** a due job whose type has no handler in this worker, **When** the worker claims, **Then** the job is not claimed and stays `QUEUED` untouched (another worker, or a later deploy, may run it).
4. **AS-13** — **Given** a handler registered with `concurrency: 3` and 20 due jobs, **When** one worker runs them, **Then** at no instant are more than 3 of that type in flight in that worker, and all 20 complete.
5. **AS-14** — **Given** a handler registered with `fleetConcurrency: 1` and 10 due jobs of that type across 3 workers, **When** they drain, **Then** at no instant is more than 1 job of that type `RUNNING` in the fleet (sampled continuously), and all 10 complete.
6. **AS-15** — **Given** a handler registered with `leaseMs: 600000`, **When** a worker claims its job, **Then** the persisted lease expiry is the claim time plus 600 s from the moment of the claim (never a shorter default that is extended afterwards).
7. **AS-16** — **Given** a handler that returns normally, **Then** the job becomes `SUCCEEDED`, `finishedAt` is set, `lastError` is empty, lock owner and lease are cleared, and the outcome counter for `succeeded` increments by one.

---

### User Story 3 - Failures retry with backoff, then die loudly (Priority: P1)

A handler that throws is retried later with exponentially growing, jittered delay; after the attempt limit the job is `DEAD` and stays visible.

**Why this priority**: retry storms and silent loss are the two classic scheduler failures.

**Independent Test**: handler fails N times; assert `runAt` windows, attempts, final state.

**Acceptance Scenarios**:

1. **AS-17** — **Given** a handler that throws on attempt 1, **When** the job fails at time `t`, **Then** the job is `QUEUED` with `attempts = 1`, `lastError` set, lock cleared, and `runAt` within `[t, t + 2 s]` (full jitter, ceiling `min(15 min, 1 s × 2^attempts)`); the same handler succeeding on attempt 2 ends `SUCCEEDED` with `attempts = 2`.
2. **AS-18** — **Given** the delay ceiling table (attempt 1 → 2 s, 2 → 4 s, 3 → 8 s, … 10 → 900 s, 11 → 900 s), **Then** for a random source fixed at 0, 0.5 and 0.999 the computed delays are 0, half the ceiling and ceiling − 1 ms respectively, and never exceed 15 minutes.
3. **AS-19** — **Given** `maxAttempts = 3` and a handler that always throws, **When** attempt 3 fails, **Then** the job is `DEAD`, `finishedAt` set, `runAt` unchanged from the last attempt, `lastError` holds the last message, and the outcome counter for `dead` increments; it is never claimed again.
4. **AS-20** — **Given** a handler that throws `NonRetryableJobError("entity gone")` on attempt 1, **Then** the job is `DEAD` immediately with `attempts = 1` and `lastError = "entity gone"`.
5. **AS-21** — **Given** a stored payload that no longer satisfies the type's payload contract (an old job after a contract change), **When** it is claimed, **Then** the handler is not invoked and the job is `DEAD` on attempt 1 with `lastError` starting `invalid payload`.
6. **AS-22** — **Given** `maxAttempts = 3`, **Then** the handler context shows `{ attempt: 1, maxAttempts: 3, isLastAttempt: false }`, then `attempt: 2`, then `{ attempt: 3, isLastAttempt: true }`.
7. **AS-23** — **Given** an error message longer than 2,000 characters, **Then** the stored `lastError` is truncated to 2,000 characters; **And** no log line contains the job payload or any field of it.
8. **AS-24** — **Given** a handler registered with `maxRuntimeMs: 5000` that never returns, **When** 5 s pass, **Then** the handler's stop signal is aborted with reason `timeout`, the attempt is recorded as a retryable failure with `lastError = "timeout after 5000 ms"`, and the heartbeat stops.
9. **AS-25** — **Given** the handler of AS-24 returns successfully 2 s after the timeout, **Then** its late completion changes nothing (fenced by the claim) and the job's state is whatever the retry path produced.
10. **AS-26** — **Given** the database refuses the completion write twice with a transient error and accepts the third, **Then** the completion is applied on the third try; **Given** all three fail, **Then** the job stays `RUNNING` until its lease expires, is then reaped and run again (at-least-once), and an `error` log with the job id is written.

---

### User Story 4 - A dead worker's jobs come back, and a zombie cannot overwrite them (Priority: P1)

Workers die. Leases expire, a reaper returns the jobs, and a worker that was only slow cannot clobber the new owner's result.

**Why this priority**: without it, a crash loses jobs or double-completes them.

**Independent Test**: simulate a worker that stops heartbeating; reap; run elsewhere; let the zombie complete.

**Acceptance Scenarios**:

1. **AS-27** — **Given** a `RUNNING` job whose lease expired at `t` and `attempts = 1 < maxAttempts`, **When** the reaper runs, **Then** the job is `QUEUED`, lock cleared, `lastError` ends with `[lease expired]`, `runAt` is within the backoff window of AS-17, attempts still `1` (the lost attempt counts), and another worker runs it to `SUCCEEDED` with `attempts = 2`.
2. **AS-28** — **Given** a job that kills its worker every time (`maxAttempts = 3`), **When** it is reaped after each crash, **Then** after the third expired attempt the reaper marks it `DEAD` instead of re-queueing; it never loops forever.
3. **AS-29** — **Given** a handler running longer than its lease (lease 2 s, runs 7 s, heartbeat at half the lease), **Then** the job is never reaped while heartbeats succeed and ends `SUCCEEDED`; a handler can also call `ctx.heartbeat()` explicitly to extend the lease.
4. **AS-30** — **Given** worker W1's lease expired, the reaper re-queued the job, and worker W2 claimed it (attempt 2), **When** W1's old handler finally completes or fails, **Then** W1's write affects nothing: the job remains `RUNNING` under W2 and W2's result is what is recorded.
5. **AS-31** — **Given** the same worker process reaped and re-claimed its own job (new attempt) while the old execution is still running, **When** the old execution completes, **Then** its write is rejected as well (the fence identifies the claim, not just the worker).
6. **AS-32** — **Given** W1 sends a heartbeat after losing the lease, **Then** the heartbeat affects nothing and W1's handler stop signal is aborted with reason `lease_lost`.
7. **AS-33** — **Given** two instances run the reaper in the same instant over 100 expired jobs, **Then** each job is re-queued (or killed) exactly once and `attempts` is not altered by the reaper.
8. **AS-34** — **Given** a worker receiving shutdown with 3 jobs in flight that finish within the 25 s drain deadline, **Then** it stops claiming, the 3 jobs end `SUCCEEDED`, and the process stops.
9. **AS-35** — **Given** a job still running when the drain deadline passes, **Then** its stop signal is aborted with reason `shutdown`, and the job is released immediately: `QUEUED`, `runAt = now`, lock cleared, and the attempt is refunded (`attempts` decremented), so another worker picks it up without waiting for the lease.
10. **AS-36** — **Given** shutdown has begun, **Then** no new job is claimed by that worker even if jobs are due.
11. **AS-37** — **Given** the database is unreachable for 10 s during the claim loop, **Then** the loop logs the error, retries with backoff and jitter, does not exit, and resumes claiming when the database returns; the process's liveness probe stays healthy.

---

### User Story 5 - Cancel and retry follow a strict state machine (Priority: P2)

Callers cancel work that is no longer wanted ("auction was withdrawn"); operators retry dead jobs. Only legal transitions apply, and races end with exactly one winner.

**Why this priority**: callers rely on "cancelled means it never runs".

**Independent Test**: try every transition from every status; race cancel against claim.

**Acceptance Scenarios**:

1. **AS-38** — **Given** the status model, **Then** the only legal transitions are: `QUEUED → RUNNING` (claim), `RUNNING → SUCCEEDED`, `RUNNING → QUEUED` (retry, reap, release), `RUNNING → DEAD`, `QUEUED → CANCELLED`, `DEAD → QUEUED` (operator retry); every other pair (e.g. `SUCCEEDED → QUEUED`, `CANCELLED → RUNNING`, `RUNNING → CANCELLED`) is rejected by the transition function.
2. **AS-39** — **Given** a `QUEUED` job, **When** `cancel(jobId)` is called, **Then** the outcome is `CANCELLED`, `finishedAt` is set, and the job never runs.
3. **AS-40** — **Given** a job in `RUNNING`, `SUCCEEDED`, `DEAD` or `CANCELLED`, **When** `cancel(jobId)` is called, **Then** the outcome is `CONFLICT` carrying the current status and nothing changes; **Given** an unknown id, **Then** `NOT_FOUND`.
4. **AS-41** — **Given** a due `QUEUED` job, **When** `cancel` and a worker claim race (`Promise.all`), **Then** exactly one wins: either the job is `CANCELLED` and its handler never ran, or it is `RUNNING` and `cancel` returned `CONFLICT`; never both.
5. **AS-42** — **Given** a job created with key `K`, **When** `cancelByKey("K")` is called, **Then** it behaves as `cancel` for that job; an unknown key gives `NOT_FOUND`.
6. **AS-43** — **Given** shop A's `QUEUED` job, **When** shop B's service calls `cancel(jobId, { shopId: B })`, **Then** the outcome is `NOT_FOUND` (not `CONFLICT`, existence is hidden) and the job is unchanged; **When** called with `{ shopId: A }`, **Then** it is `CANCELLED`.
7. **AS-44** — **Given** a `DEAD` job with `attempts = 8`, **When** an operator retries it, **Then** it is `QUEUED`, `attempts = 0`, `runAt = now`, `finishedAt` cleared, `lastError` kept, and an audit log line records job id, previous status and actor id; **Given** a job in any other status, **Then** the outcome is `CONFLICT` with the status and nothing changes.
8. **AS-45** — **Given** two operators retry the same `DEAD` job concurrently (`Promise.all`), **Then** exactly one gets `RETRIED`, the other `CONFLICT`, and the job is claimed once.

---

### User Story 6 - One shop's backlog cannot starve the others (Priority: P2)

A shop that enqueues a million jobs gets at most N running at a time; other shops' jobs keep flowing.

**Why this priority**: noisy-neighbour protection is the multi-tenant requirement of the notes.

**Independent Test**: flood shop A, enqueue shop B, sample running counts.

**Acceptance Scenarios**:

1. **AS-46** — **Given** shop A with 200 due jobs, a per-shop cap of 5 and 4 workers, **When** they run with handlers that take 200 ms, **Then** at no sampled instant do more than 5 of shop A's jobs run fleet-wide, and all 200 eventually succeed.
2. **AS-47** — **Given** shop A is saturated at its cap, **When** shop B enqueues 3 jobs, **Then** they are claimed on the next poll (within one idle poll interval), not after A's backlog.
3. **AS-48** — **Given** one claim call with batch size 50 and 50 due jobs of shop A, none running, cap 5, **Then** at most 5 jobs are claimed in that call (the cap counts jobs claimed in the same batch).
4. **AS-49** — **Given** 4 workers claiming at the same instant (`Promise.all` of four claims) against shop A's 100 due jobs, **Then** the number of shop A jobs `RUNNING` never exceeds 5.
5. **AS-50** — **Given** jobs with no shop (platform jobs), **Then** they are never limited by the shop cap.
6. **AS-51** — **Given** shop A is at its cap and one of its jobs finishes, **Then** the next due job of shop A becomes claimable on the next poll.
7. **AS-52** — **Given** among unsaturated shops several due jobs, **Then** selection stays oldest-`runAt`-first (fairness never reorders by shop name or id).

---

### User Story 7 - Recurring schedules run once per fire, whichever replica is alive (Priority: P1)

Domains register recurring schedules ("every minute", "daily 03:15 UTC", "Monday 06:00 Europe/Warsaw"). Exactly one instance (the leader of that tick) turns due schedules into jobs, and the idempotency key `cron:<name>:<fireAt>` makes even a double run produce one job.

**Why this priority**: the notes' headline: never run cron in every replica.

**Independent Test**: N instances tick at once against due schedules; kill the leader mid-tick.

**Acceptance Scenarios**:

1. **AS-53** — **Given** an enabled schedule `s` (`0 9 * * *`, `Europe/Warsaw`) whose next fire is `2026-10-07T07:00:00Z`, **When** the leader ticks at `07:00:00Z`, **Then** exactly one job of the schedule's type exists with idempotency key `cron:s:2026-10-07T07:00:00.000Z`, `runAt = 07:00:00Z`, the schedule's payload, `lastFiredAt = 07:00:00Z`, and the next fire is `2026-10-08T07:00:00Z`.
2. **AS-54** — **Given** 5 instances each running a materialiser tick at the same instant, **Then** exactly one of them materialises (the others report 0 and do not touch schedule rows), exactly one job per due schedule exists, and the leader gauge is 1 on exactly one instance.
3. **AS-55** — **Given** the leader's transaction is aborted after creating the job but before advancing the schedule (process killed), **Then** neither the job nor the schedule change persists; **When** another instance ticks, **Then** it materialises the same fire once, with the same key, and one job exists.
4. **AS-56** — **Given** the same fire is materialised twice by a faulty second path (same key), **Then** one job exists (the key dedupes).
5. **AS-57** — **Given** all instances were down for 3 days over a daily schedule, **When** one starts, **Then** exactly one catch-up job is created (key uses the first missed fire time), the next fire is computed from the current time and lies in the future, and no burst of 3 jobs occurs.
6. **AS-58** — **Given** a schedule with overlap policy `skip` (the default) and a job of that schedule still `QUEUED` or `RUNNING`, **When** the next fire is due, **Then** no job is created, `cron_fires_skipped_total{schedule}` increments, and the next fire still advances; **Given** policy `allow`, **Then** the new job is created regardless.
7. **AS-59** — **Given** `upsertSchedule` with a definition identical to the stored one, **Then** nothing changes (`nextFireAt` and `lastFiredAt` kept); **Given** a changed cron or time zone, **Then** `nextFireAt` is recomputed from now; **Given** a changed payload or job type only, **Then** `nextFireAt` is kept.
8. **AS-60** — **Given** 8 replicas all calling `upsertSchedule` with the same definition at boot at once, **Then** all calls succeed, one schedule row exists, no deadlock or unique violation surfaces.
9. **AS-61** — **Given** an invalid cron expression, an unknown IANA time zone, an unregistered job type, a payload violating the type's contract, a name not matching `^[a-z0-9]+([._-][a-z0-9]+)*$` (max 100), or `maxAttempts` outside 1–25, **Then** `upsertSchedule` fails with `InvalidScheduleError` naming the field and an existing schedule of that name is left unchanged.
10. **AS-62** — **Given** a schedule is disabled, **Then** it never fires; **When** it is enabled again after 2 days, **Then** its next fire is computed from the current time (no catch-up of the disabled period).
11. **AS-63** — **Given** `removeSchedule(name)`, **Then** the schedule row is gone and jobs it already materialised stay as they are; `removeSchedule` of an unknown name returns `false`.
12. **AS-64** — **Given** 1,200 schedules due at once, **Then** all are materialised within 3 ticks, none is lost or duplicated.
13. **AS-65** — **Given** one schedule whose job creation fails persistently (e.g. its type's contract was removed) and 5 healthy schedules due on the same tick, **Then** the 5 healthy ones fire, the failing one is skipped with an error log and counted, and after 5 consecutive failing ticks it is disabled with `lastError` set and a metric incremented.
14. **AS-66** — **Given** a schedule with `maxAttempts: 3`, **Then** the jobs it creates have `maxAttempts = 3`; **Given** none set, the type default applies, else 8.
15. **AS-67** — **Given** a schedule `*/10 * * * * *` (six fields, seconds), **Then** it fires every 10 s and each fire carries its own key.

---

### User Story 8 - Cron means local wall-clock time, across daylight saving (Priority: P1)

"09:00 Europe/Warsaw" is 09:00 on a Warsaw clock all year, even though the UTC instant moves twice a year. Pure, table-driven.

**Why this priority**: digests and billing runs that drift an hour twice a year are a visible bug.

**Independent Test**: compute next fire instants around DST for several zones.

**Acceptance Scenarios**:

1. **AS-68** — **Given** `0 9 * * *` in `Europe/Warsaw`, **Then** the fire after `2027-03-26T12:00Z` is `2027-03-27T08:00Z`, the next is `2027-03-28T07:00Z` (the day clocks go forward, 09:00 CEST), and the fire after `2027-10-30T12:00Z` is `2027-10-31T08:00Z` (09:00 CET after the clocks go back).
2. **AS-69** — **Given** `30 2 * * *` in `Europe/Warsaw` on 2027-03-28 (02:30 does not exist), **Then** it fires exactly once that day, at the first instant after the gap, `01:00:00Z` (03:00 local), and the following day at `00:30Z` (02:30 CEST).
3. **AS-70** — **Given** `30 2 * * *` in `Europe/Warsaw` on 2027-10-31 (02:30 occurs twice), **Then** it fires exactly once, at the first occurrence `00:30Z` (02:30 CEST), not again at `01:30Z`.
4. **AS-71** — **Given** `0 * * * *` (every hour, wildcard hour field) in `Europe/Warsaw`, **Then** it fires at every elapsed hour: 25 times on 2027-10-31 and 23 times on 2027-03-28.
5. **AS-72** — **Given** `0 0 31 * *` in `UTC`, **Then** it fires only in months with 31 days (after 2027-04-01 the next is 2027-05-31); `0 0 29 2 *` fires only in leap years (after 2026-03-01 the next is 2028-02-29).
6. **AS-73** — **Given** the base instant equals a fire instant exactly, **Then** the next fire is strictly after it (never the same instant twice).
7. **AS-74** — **Given** zones `Asia/Kolkata` (+05:30, no DST), `America/Sao_Paulo` (no DST since 2019) and `Australia/Lord_Howe` (30-minute DST shift), **Then** `0 9 * * *` fires at 03:30Z, 12:00Z and 22:00Z/22:30Z respectively on a winter and a summer day for each, matching the IANA rules.
8. **AS-75** — **Given** the schedule time zone is changed from `UTC` to `Europe/Warsaw` for `0 9 * * *` after the 07:00Z fire, **Then** the next fire is recomputed in the new zone (08:00Z or 07:00Z per the date).
9. **AS-76** — **Given** an invalid expression (`61 * * * *`, `* * * *`) or zone (`Mars/Base`, `""`), **Then** validation returns invalid and no schedule can be stored with it.

---

### User Story 9 - Operators see lag, failures and dead jobs (Priority: P2)

Queue lag drives worker autoscaling; failures and duration percentiles drive alerts; dead jobs can be listed and retried.

**Why this priority**: an unobservable queue is a silent outage.

**Independent Test**: seed jobs of known ages and outcomes; read metrics and the operator service.

**Acceptance Scenarios**:

1. **AS-77** — **Given** the oldest due `QUEUED` job has `runAt` 42 s before now, **Then** `job_queue_lag_seconds` is 42 overall and per type; **Given** only future jobs or none, **Then** 0.
2. **AS-78** — **Given** outcomes of two successes, one retry and one dead for type `x`, **Then** `job_outcomes_total{type="x"}` shows `succeeded 2, retry 1, dead 1`, `job_duration_ms{type="x"}` has 4 observations (so p50/p95/p99 are derivable), and the dead-job gauge for `x` is 1.
3. **AS-79** — **Given** reaped leases and skipped cron fires, **Then** `job_lease_expired_total{type}` and `cron_fires_skipped_total{schedule}` increase by the counts.
4. **AS-80** — **Given** a job executes, **Then** every log line about it is structured JSON carrying `jobId`, `type`, `attempt`, `shopId` (when set) and `requestId = "job:<id>"`, plus `enqueuedByRequestId` and the originating trace id when the enqueuer had them; no secrets or payload fields appear.
5. **AS-81** — **Given** a handler running a job with a shop, **Then** the ambient request context holds that shop, principal type `service`, the job's request id and the originating trace; two concurrent jobs never see each other's context.
6. **AS-82** — **Given** `JobsAdminService.listJobs({ status: "DEAD", limit: 2 })` over 5 dead jobs, **Then** it returns 2 items newest first and an opaque cursor; following cursors visits all 5 exactly once even if new jobs are enqueued meanwhile; a tampered cursor fails with `InvalidCursorError`; `limit` over 100 is clamped to 100.
7. **AS-83** — **Given** mixed jobs, **Then** `JobsAdminService.getStats()` returns per type counts by status, the oldest due `runAt` and the lag in seconds, consistent with the persisted rows.

---

### User Story 10 - The tables stay small and fast (Priority: P2)

Finished jobs are dropped by whole daily partitions, idempotency keys expire with them, and the claim path stays on a small index.

**Why this priority**: 50M outstanding and 5k jobs/s do not survive row-by-row deletes and bloat.

**Independent Test**: run partition maintenance against crafted partitions; inspect catalog and plans.

**Acceptance Scenarios**:

1. **AS-84** — **Given** partitions exist for days D−1 … D+14, **When** the maintenance job runs with `aheadDays = 14` twice, **Then** no new partition is created the second time, and a run on day D+1 adds exactly D+15.
2. **AS-85** — **Given** partitions 40 days old (all jobs `SUCCEEDED`), 40 days old holding one `QUEUED` job, 40 days old holding a `DEAD` job finished 5 days ago, and 10 days old, **When** maintenance runs with `retainDays = 30`, **Then** only the first is dropped; the other three remain.
3. **AS-86** — **Given** an inserted job whose creation day has no partition (maintenance fell behind), **Then** the insert succeeds (default partition), a metric `job_default_partition_rows` is raised on the next maintenance run, and a log line warns.
4. **AS-87** — **Given** idempotency keys of jobs finished more than 30 days ago, **When** maintenance runs, **Then** those keys are removed (in batches of at most 10,000 per statement) and keys of newer jobs are kept (AS-09).
5. **AS-88** — **Given** 200,000 seeded jobs of which 100 are due, **When** a worker claims a batch, **Then** the claim's query plan uses the due-jobs partial index and reads fewer than 1,000 heap rows (it does not scan the table).
6. **AS-89** — **Given** 5,000 claim-and-complete cycles, **Then** at least 90% of updates to the job table are in-page (heap-only) updates.
7. **AS-90** — **Given** maintenance drops a partition, **Then** it does so with a catalog-resolved name (no string-built identifier from caller input) and the drop completes within `lock_timeout` 5 s or fails without leaving a partial state.

---

### User Story 11 - Handlers and job types are declared once and checked at boot (Priority: P2)

Each job type is a discriminated union member: name, payload contract, defaults. Handlers are discovered; mistakes fail at startup, not at 3 a.m.

**Why this priority**: patterns P0110 and P0114.

**Independent Test**: boot a module with duplicate or malformed registrations.

**Acceptance Scenarios**:

1. **AS-91** — **Given** two different providers both declaring a handler for `x.do`, **Then** application startup fails naming both providers; **Given** the same provider instance discovered twice (monolith imports), **Then** it registers once without error.
2. **AS-92** — **Given** a handler for a type with no declared payload contract, a type name not matching `^[a-z0-9]+(-[a-z0-9]+)*\.[a-z0-9]+(-[a-z0-9]+)*$`, `leaseMs` outside 5,000–14,400,000, `concurrency` below 1, `maxRuntimeMs` below `leaseMs`, **Then** startup fails with a message naming the type and the field.
3. **AS-93** — **Given** a type declared with a payload contract and defaults (`maxAttempts`, `leaseMs`), **Then** enqueue accepts exactly the payload shape (compile-time: the wrong shape does not type-check; run-time: AS-06) and the worker supplies the parsed payload to the handler.
4. **AS-94** — **Given** the enqueuing app has not loaded the handler's module but the type declaration is shared, **Then** enqueue works (declaration and handler registration are separate).
5. **AS-95** — **Given** the type-to-payload map, **Then** every `switch` over job statuses or types in this capability ends in an exhaustiveness check (a new member makes compilation fail).

---

### Edge Cases

All edge cases are acceptance scenarios; the index maps them:

| Edge case | Scenario |
|---|---|
| Idempotent replay of enqueue | AS-03, AS-04, AS-05, AS-09 |
| Duplicate cron fire | AS-54, AS-56 |
| Concurrency: claim, cancel, retry, reap, upsert | AS-10, AS-41, AS-45, AS-33, AS-49, AS-60 |
| Illegal state transitions | AS-38, AS-40, AS-44 |
| Cross-tenant access | AS-43 |
| Limits | AS-07, AS-48, AS-61, AS-64, AS-82, AS-92 |
| Timeouts | AS-24, AS-25, AS-90 |
| Out-of-order / late completion | AS-30, AS-31, AS-25 |
| Crash recovery | AS-27, AS-28, AS-55, AS-57 |
| Dependency outage | AS-26, AS-37 |
| Clock: DST gap, overlap, month-end, leap day | AS-69, AS-70, AS-71, AS-72 |

## Requirements *(mandatory)*

### Functional Requirements

**Enqueue and lifecycle**

- **FR-001**: The system MUST let any domain enqueue a job by type, payload and options `{ runAt?, idempotencyKey?, shopId?, maxAttempts? }`, returning `{ id, created }` (AS-01).
- **FR-002**: Enqueue MUST join the caller's open database transaction when there is one, so the job exists if and only if the caller's change commits; when there is none it MUST commit on its own (AS-02, AS-08).
- **FR-003**: Enqueue with an existing idempotency key MUST create nothing and return the original job's id with `created: false`, including under concurrent calls; exactly one concurrent caller sees `created: true` (AS-03, AS-04).
- **FR-004**: A key reused with a different job type MUST fail with `IdempotencyKeyConflictError` (AS-05).
- **FR-005**: Idempotency keys MUST expire 30 days after their job finished, together with the job's retention; before that they dedupe, after that the key is free (AS-09, AS-87).
- **FR-006**: Enqueue MUST validate type, payload contract and options, rejecting with `UnknownJobTypeError`, `InvalidJobPayloadError`, `InvalidEnqueueOptionsError`, persisting nothing (AS-06, AS-07). Limits: payload ≤ 64 KiB, key 1–200 characters, `maxAttempts` 1–25, `runAt` ≤ 366 days ahead; a past `runAt` is allowed.
- **FR-007**: A job MUST have exactly one status of `QUEUED`, `RUNNING`, `SUCCEEDED`, `DEAD`, `CANCELLED`, and every transition MUST be a conditional change from a named prior status; the legal set is the one in AS-38 and any other pair MUST be rejected (AS-38).
- **FR-008**: `cancel(jobId, { shopId? })` MUST cancel only a `QUEUED` job and return a discriminated outcome `CANCELLED | NOT_FOUND | CONFLICT(status)`; with `shopId` the lookup MUST include it so another shop's job is `NOT_FOUND` (AS-39, AS-40, AS-43). `cancelByKey(key, { shopId? })` MUST behave the same (AS-42).
- **FR-009**: Cancel and claim MUST be mutually exclusive on one job: a job is cancelled or run, never both (AS-41).
- **FR-010**: An operator retry MUST move only a `DEAD` job to `QUEUED` with `attempts = 0`, `runAt = now`, record an audit log with actor, and be safe under concurrent calls (AS-44, AS-45).

**Claiming, leases, execution**

- **FR-011**: Workers MUST claim due jobs (`QUEUED`, `runAt ≤ now`) in batches with row-lock skip-locked semantics so concurrent workers never claim the same job, ordered by `runAt` then id, and only of types they have handlers for (AS-10, AS-11, AS-12).
- **FR-012**: A claim MUST set the lease to the handler's `leaseMs` from the claim moment and increment `attempts` (AS-15, AS-27).
- **FR-013**: Each handler MUST declare `concurrency` (per worker instance, default 10) and MAY declare `fleetConcurrency` (maximum `RUNNING` jobs of that type across all workers, default unlimited); both MUST hold under concurrency (AS-13, AS-14).
- **FR-014**: A worker MUST extend the lease automatically at half the lease interval and expose `ctx.heartbeat()`; extension MUST succeed only for the current claim (AS-29, AS-32).
- **FR-015**: Every write that ends or changes a running attempt (complete, fail, extend, release) MUST be fenced by the claim identity (worker and attempt number), so a stale worker changes nothing (AS-30, AS-31).
- **FR-016**: When the lease is lost or the worker shuts down, the handler's stop signal MUST be aborted with reason `lease_lost` or `shutdown`; on exceeding `maxRuntimeMs` with reason `timeout` and the attempt MUST count as a retryable failure (AS-24, AS-32, AS-35).
- **FR-017**: The handler context MUST expose `jobId`, `attempt`, `maxAttempts`, `isLastAttempt`, `heartbeat()`, `signal` (AS-22).
- **FR-018**: A completion write that fails transiently MUST be retried up to 3 times with exponential backoff and full jitter; if all fail the job is left to the reaper (AS-26).
- **FR-019**: A payload that violates the type's contract at claim time MUST end the job `DEAD` without invoking the handler (AS-21).

**Retry**

- **FR-020**: A thrown error MUST re-queue the job with `runAt = now + full-jitter delay`, ceiling `min(15 min, 1 s × 2^attempts)`, until `attempts ≥ maxAttempts`, then `DEAD` (AS-17, AS-18, AS-19).
- **FR-021**: `NonRetryableJobError` MUST send the job to `DEAD` at once (AS-20).
- **FR-022**: `maxAttempts` resolution order MUST be: enqueue option, schedule setting, type default, 8 (AS-66).
- **FR-023**: Stored `lastError` MUST be truncated to 2,000 characters; payloads and secrets MUST NOT be logged (AS-23).

**Reaper and shutdown**

- **FR-024**: A reaper MUST find `RUNNING` jobs whose lease expired and, if `attempts < maxAttempts`, re-queue them with the AS-17 backoff, else mark them `DEAD`; it MUST be safe to run on several instances at once (AS-27, AS-28, AS-33).
- **FR-025**: On shutdown a worker MUST stop claiming, let in-flight jobs finish up to 25 s, then abort and release unfinished jobs back to `QUEUED` with the attempt refunded (AS-34, AS-35, AS-36).
- **FR-026**: A database outage MUST NOT stop or crash the claim, reaper or materialiser loops; they MUST retry with backoff and jitter (AS-37).

**Fairness**

- **FR-027**: A per-shop running cap (default 5, configurable at startup) MUST hold fleet-wide at every instant, including within one batch and between concurrent claimers (AS-46, AS-48, AS-49).
- **FR-028**: A shop at its cap MUST NOT delay other shops' jobs (no head-of-line blocking), and jobs without a shop MUST NOT be capped (AS-47, AS-50, AS-51, AS-52).

**Schedules and leader**

- **FR-029**: `upsertSchedule({ name, cron, timezone?, jobType, payload, enabled?, overlap?, maxAttempts? })` MUST create or update by unique `name`, idempotently and safely under concurrent calls; `timezone` defaults to `UTC`; `overlap` defaults to `skip` (AS-59, AS-60).
- **FR-030**: Validation MUST reject an invalid cron (five or six fields), an unknown IANA zone, an unregistered type, a payload violating the contract, a malformed name, or out-of-range `maxAttempts` with `InvalidScheduleError`, leaving existing data untouched (AS-61, AS-76).
- **FR-031**: Changing cron or zone MUST recompute the next fire; changing only payload, type or flags MUST keep it (AS-59, AS-75).
- **FR-032**: Schedules MUST be materialised into jobs by one leader at a time, chosen per tick by a transaction-scoped advisory lock; non-leaders MUST do nothing for schedules on that tick; leader loss mid-tick MUST leave no partial effect (AS-54, AS-55).
- **FR-033**: Each fire MUST use the idempotency key `cron:<name>:<fireAt ISO-8601 UTC with milliseconds>` so a duplicate materialisation yields one job (AS-53, AS-56).
- **FR-034**: Missed fires MUST collapse to one catch-up job; the next fire MUST be computed from the current time (AS-57).
- **FR-035**: With overlap `skip`, a fire MUST be skipped (counted, next fire advanced) while an earlier job of that schedule is `QUEUED` or `RUNNING`; `allow` MUST always create (AS-58).
- **FR-036**: Disabling a schedule MUST stop its fires; enabling MUST compute the next fire from now (AS-62). `removeSchedule(name)` MUST delete the schedule and keep already-created jobs (AS-63).
- **FR-037**: The leader MUST process at most 500 due schedules per tick and the rest on following ticks, ordered by due time (AS-64).
- **FR-038**: A schedule that fails to materialise MUST NOT block the others; after 5 consecutive failing ticks it MUST be disabled with the error recorded (AS-65).
- **FR-039**: Schedule resolution is one second: six-field expressions with a seconds field MUST be accepted; a fire MUST be materialised within 2 s of its due time under normal load (AS-67).

**Time zones**

- **FR-040**: Next-fire computation MUST evaluate the expression on the wall clock of the schedule's IANA zone and return a UTC instant strictly after the base instant (AS-68, AS-73).
- **FR-041**: A local time that does not exist (DST gap) MUST fire once at the first instant after the gap; a local time that occurs twice MUST fire once, at its first occurrence; a wildcard hour field MUST fire at every elapsed hour (AS-69, AS-70, AS-71).
- **FR-042**: Day-of-month and month fields MUST skip dates that do not exist (31st in short months, 29 Feb outside leap years) (AS-72). Zones with fractional offsets or no DST MUST follow the IANA rules (AS-74).
- **FR-043**: Computation MUST be pure: it takes the base instant as input and never reads the clock (testable without sleeping).

**Registry**

- **FR-044**: A job type MUST be declared once with name, payload contract and optional defaults (`maxAttempts`, `leaseMs`); the declaration MUST be loadable by enqueuing apps independently of the handler (AS-93, AS-94).
- **FR-045**: Handlers MUST be discovered at boot; a second provider for the same type, a missing contract, a bad name, or out-of-range options MUST fail startup with a message naming type and cause; re-discovery of the same provider is ignored (AS-91, AS-92). Allowed ranges: `leaseMs` 5 s–4 h, `concurrency` ≥ 1, `maxRuntimeMs` ≥ `leaseMs` (default 15 min).
- **FR-046**: Status and job-type handling MUST be exhaustive and fail the build when a member is added without handling (AS-95).

**Retention**

- **FR-047**: The system MUST keep daily creation-date partitions ahead of time (default 14 days) and create missing ones idempotently (AS-84).
- **FR-048**: Maintenance MUST drop a partition only when it is older than the retention (default 30 days), holds no `QUEUED` or `RUNNING` job, and no `DEAD` job finished within the retention (AS-85); it MUST remove idempotency keys of jobs older than retention in bounded batches (AS-87) and MUST NOT build table names from untrusted input (AS-90).
- **FR-049**: A job with no matching partition MUST still be stored, and the condition MUST be reported (AS-86).
- **FR-050**: The claim path MUST remain index-assisted: cost independent of the number of finished jobs (AS-88); updates on the job table MUST be mostly in-page (AS-89).
- **FR-051**: Partition maintenance MUST itself run as a schedule of this capability (`jobs.partition-maintenance`, daily `15 3 * * *` UTC, concurrency 1) (AS-84).

**Observability and context**

- **FR-052**: The system MUST publish `job_queue_lag_seconds` (overall and per type), `job_outcomes_total{type,outcome}` (`succeeded|retry|dead|timeout|released`), `job_duration_ms{type}`, a dead-jobs gauge per type, `job_lease_expired_total{type}`, `cron_fires_total{schedule}`, `cron_fires_skipped_total{schedule}`, a leader gauge, `job_default_partition_rows` (AS-77–AS-79, AS-86).
- **FR-053**: Each job MUST run with an ambient request context (`requestId = job:<id>`, `shopId`, principal type `service`, originating request id and trace) isolated per job; logs MUST carry `jobId`, `type`, `attempt`, `shopId` (AS-80, AS-81).
- **FR-054**: Enqueue MUST record the originating request id and trace context when present (AS-80).
- **FR-055**: `JobsAdminService` MUST offer `listJobs` (filters `status`, `type`, `shopId`; keyset pagination ordered by creation time then id; opaque cursor; limit 1–100, default 50), `getStats`, `retryDead`, `cancel`, `listSchedules`, `setScheduleEnabled` (AS-44, AS-82, AS-83).
- **FR-056**: All database access MUST be bounded by timeouts (statement timeout, lock timeout on migrations), and no network call MUST run inside a claim or enqueue transaction (AS-37, AS-90).

**Boundaries**

- **FR-057**: Other capabilities MUST use jobs only through exported services (R1): `JobsService`, `JobsAdminService`, the handler decorator and type declarations. No other module reads or writes the job tables, models or SQL (IX.4, IX.6).
- **FR-058**: The job tables MUST be owned by `infrastructure:jobs` in the ownership registry with no foreign keys to any domain table; `shopId` is a plain identifier column (IX.4).
- **FR-059**: Test code MUST inspect jobs through `JobsAdminService` (or a test-only probe exported for tests), not by SQL on the table, outside the capability's own specs.
- **FR-060**: The in-process local ticker (every replica runs it) MUST NOT be used for work that must run once per schedule; it exists only for per-replica pollers (the outbox poller). Single-run work MUST be a schedule (VIII.6).

### Key Entities

- **Job**: one unit of work. Type, payload, status, `runAt`, `attempts`, `maxAttempts`, lease owner and expiry, `lastError`, optional `shopId`, optional idempotency key, creation and finish times, originating request id and trace. Retained 30 days after finishing, dropped with its daily partition.
- **Job key**: maps an idempotency key to the job it created; the global uniqueness anchor across partitions; expires with the job.
- **Job schedule**: a named recurring definition. Cron expression, IANA time zone, job type, payload, `enabled`, `overlap`, `maxAttempts`, `nextFireAt`, `lastFiredAt`, consecutive failure count and last error.
- **Job type declaration**: name, payload contract, default `maxAttempts` and `leaseMs`. A discriminated-union member shared by enqueuers and handlers.
- **Handler registration**: type, `leaseMs`, `concurrency`, `fleetConcurrency`, `maxRuntimeMs`.
- **Claim**: the identity (worker, attempt) that currently holds a `RUNNING` job; the fence for all later writes.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With four workers draining 1,000 due jobs, every job's effect happens exactly once and none is lost, in 100% of runs (AS-10).
- **SC-002**: Doubling workers from 1 to 2 to 4 roughly halves drain time of a no-op backlog (within 30% of linear), with zero re-executions (load proof `pnpm loadtest:jobs`: operations artifact, not a required e2e row).
- **SC-003**: A job that was running on a crashed worker is running again within lease length plus 2 s, and a repeatedly crashing job stops after its attempt limit (AS-27, AS-28).
- **SC-004**: A shop with a 200-job backlog never has more than its cap running, and another shop's new job starts within 1 s of being due (AS-46, AS-47).
- **SC-005**: Across five simultaneous instances, a daily schedule produces exactly one job per day, and across both DST changes it fires at the same local wall-clock hour (AS-54, AS-68).
- **SC-006**: A scheduled fire materialises within 2 s of its due time, and enqueue plus claim of a delayed job starts it within 1 s of `runAt`, under normal load.
- **SC-007**: Queue lag is visible within 10 s of becoming non-zero and reads 0 when nothing is due (AS-77).
- **SC-008**: Retention keeps the job table's live size proportional to unfinished plus the last 30 days of jobs, never to history (AS-85, AS-88).
- **SC-009**: Every other capability's registered jobs (Cross-capability contracts, Requires) run under single-run semantics without per-capability locking code.

## Assumptions

- **At-least-once, handlers idempotent.** Exactly-once effect is the handler's job using the key and attempt number this capability supplies. No exactly-once claim is made.
- **Postgres is the queue.** The notes size a skip-locked job table at thousands of jobs per second. Beyond ~5–10k jobs/s the documented next step is a managed scheduler for far-future jobs and a queue for bulk near-term work; not built here.
- **No per-transition history table.** Constitution III.7 asks for a history row per state change; the job tables are an allowlisted technical set that cannot gain a table without an amendment, and a history row would double the write cost (the capacity model is ~2 writes per job). The job row keeps `attempts`, `lastError`, `finishedAt`; transitions are also emitted as metrics and structured logs. Recorded in `questions.md`.
- **Clock.** All time comparisons use one injected clock (S54) passed into the queries, so tests freeze time. Replicas are assumed NTP-synchronised within 1 s; the minimum lease of 5 s is far above that.
- **Per-shop cap** default 5, configured at startup, one value for all shops. Per-shop overrides are out of scope.
- **Retention** 30 days after finish; idempotency keys expire with it; far-future jobs stay in their creation-day partition until done.
- **Retry backoff** base 1 s, cap 15 min, full jitter, default 8 attempts; schedules or enqueuers can lower it (S14 jobs use 3).
- **Overlap default `skip`** because most recurring jobs are sweeps and reconcilers where a second concurrent run adds nothing; `allow` is opt-in.
- **Cron dialect** is the standard five fields plus an optional leading seconds field; no `L`, `W`, `#` extensions.
- **Operator HTTP routes** are provided by the platform-admin surface (S01) over `JobsAdminService`; this capability specifies the service, not routes. No UI journey belongs to S49.
- **`CronService` (every-replica local ticker)** stays for per-replica pollers only (FR-060).
- **Decision policy.** Where today's behaviour and the production-grade option differ, the spec takes the production-grade option and tags it `[BREAKING]` in `questions.md`.

## Cross-capability contracts

### Provides

All exports come from `@app/infrastructure/jobs` (R1: callers inject exported services; nobody touches the tables).

- **`JobsModule`** (enqueue side, global; any app) and **`JobsWorkerModule`** (execution side, `apps/worker` only).
- **`JobsService.enqueue<T>(type: T, payload: JobPayloads[T], options?: { runAt?: Date; idempotencyKey?: string; shopId?: string; maxAttempts?: number }): Promise<{ id: string; created: boolean }>`**. Joins the caller's transaction when one is active (CLS); works with none. Errors: `UnknownJobTypeError`, `InvalidJobPayloadError`, `InvalidEnqueueOptionsError`, `IdempotencyKeyConflictError`. Guarantee: same key → one job.
- **`JobsService.cancel(jobId: string, scope?: { shopId?: string }): Promise<{ outcome: 'CANCELLED' } | { outcome: 'NOT_FOUND' } | { outcome: 'CONFLICT'; status: JobStatus }>`** and **`cancelByKey(key: string, scope?: { shopId?: string })`** (same result type).
- **`JobsService.upsertSchedule<T>({ name, cron, timezone?, jobType, payload, enabled?, overlap?: 'skip' | 'allow', maxAttempts? }): Promise<void>`**; **`removeSchedule(name: string): Promise<boolean>`**. Error: `InvalidScheduleError`. Guarantee: single-run per fire across replicas; idempotent at boot.
- **`@JobHandler(type, { leaseMs?, concurrency?, fleetConcurrency?, maxRuntimeMs? })`** on a provider method `(payload, ctx) => Promise<void>`. Defaults: lease 60 s, concurrency 10, fleet unlimited, max runtime 15 min.
- **`JobContext`**: `{ jobId: string; attempt: number; maxAttempts: number; isLastAttempt: boolean; heartbeat(): Promise<void>; signal: AbortSignal }`.
- **`NonRetryableJobError(message)`**: permanent failure → `DEAD` immediately (S27 AS-47, S15).
- **`JobPayloads`** (module augmentation map, one entry per job type) plus a runtime job-type declaration (`name`, payload contract, `maxAttempts?`, `leaseMs?`) loadable without the handler.
- **`JobsAdminService`**: `listJobs(filter, page)`, `getStats()`, `retryDead(jobId, actorId)`, `cancel(jobId)`, `listSchedules()`, `setScheduleEnabled(name, enabled)`; returns DTOs, never rows. For S01's admin routes.
- **Built-in types**: `jobs.partition-maintenance` (`{ aheadDays?: number; retainDays?: number }`), `jobs.noop`.
- **Metrics**: names in FR-052 (S54 registry lists them).
- **Guarantees to all registrants**: at-least-once; single-run per schedule fire; idempotent materialisation; strict per-shop cap; retries ≤ `maxAttempts`; fenced completion.

### Requires

| Needs | Owner | Exact shape assumed |
|---|---|---|
| Clock | S54 | `Clock.now(): Date` injectable and freezable in tests |
| Metrics registry | S54 | meter creation by name; names in FR-052 registered |
| Request context | S54 | `RequestContext.run({ requestId, shopId?, principalType, traceparent? }, fn)`; isolated per async chain |
| Graceful-shutdown registry | S54 | `register({ name, order, run, timeoutMs })` honoured in the shutdown order of VIII.4 |
| Config validation | S54 | startup-validated keys: `jobs.perShopRunningCap` (int ≥ 1, default 5), `jobs.claimBatch` (default 50), `jobs.retainDays` (default 30) |
| Structured logger with redaction | S54 | pino-style, fields `jobId`, `type`, `attempt` |
| Full-jitter backoff helper | `@app/common/core/backoff` | `fullJitterBackoff(attempt, { baseMs, maxMs }, random?)` |
| Admin role check and routes over `JobsAdminService` | S01 | `ADMIN` platform role; routes call the service (not specified here) |
| Database | S53 (`database`) | statement timeout per connection role; CLS-bound transactions |

**Registrations other capabilities need from S49** (names are exact; the owner registers them, S49 runs them):

| Capability | Jobs (schedule) | Needs from S49 |
|---|---|---|
| S01 | `auth.rotate-signing-keys` (daily) | single-run daily |
| S03 | `tenancy.purge-deleted-shops` (hourly), `tenancy.purge-expired-invites` (daily) | single-run |
| S05 | `products.flush-view-counts` (10 s, concurrency 1), `products.purge-stock-operations` (daily), `products.backfill-shop-ids` | fleet concurrency 1; seconds-level cron |
| S06 | `drafts.release-stale-publishing` (1 min), `drafts.purge-superseded-snapshots` (daily) | single-run |
| S07 | `catalog-sync.recover-stalled-imports` (1 min), `catalog-sync.expire-pending-imports` (5 min), `catalog-sync.purge-imports` (daily) | single-run, idempotent |
| S08 | `catalog-sync.sync-all` (5 min), `catalog-sync.reconcile-all` (03:40 UTC), `catalog-sync.purge-integration-data` (daily) | leases; a skipped tick is harmless |
| S09 | `catalog-sync.redrive-stale-ops`, `…compact-change-log`, `…purge-sync-operations` | single-run with leases |
| S11 | `flash-sale.load` (`runAt = startsAt − 60 s`), `flash-sale.end`, `flash-sale.reconcile`, `flash-sale.verify` (30 s) | delayed per-key jobs, dead-letter state |
| S12 | `orders.recover-stalled-exports` (1 min), `orders.expire-exports` (15 min), `orders.purge-exports` (daily) | single-run with leases |
| S14 | `payments.reconcile-daily` (02:30 UTC), `ledger.sweep-hot-accounts` (hourly), `ledger.verify-invariants` (02:15 UTC), `ledger.ensure-partitions` (Mon 03:00 UTC), `ledger.backfill-balances` (one-off, batched) | single-run, retries ≤ 3 (`maxAttempts: 3`) |
| S15 | `payouts.run-weekly` (Mon 06:00 `Europe/Warsaw`), `payouts.send`, `payouts.resolve-in-doubt`, `payouts.audit-daily` | tz-aware cron; enqueue in caller transaction with key; `attempt`/`maxAttempts` in context; cooperative stop |
| S18 | `billing.usage-reconcile` (`15 3 * * *` UTC) | single-run |
| S20 | `fulfilment.compute-surge`, `fulfilment.recover-deliveries`, `fulfilment.apply-order-lifecycle` | single-run |
| S21 | `auctions.open`, `auctions.close` (per `(auction, endsAt)`), `auctions.sweep-due` (30 s) | delayed per-key jobs; enqueue in transaction |
| S23 | `launch-events.live-reconcile` (30 s) | single-run; the 1 s publisher stays an in-process loop (schedule granularity here is 1 s but is not meant for sub-second ticks) |
| S24 | `chat.partition-maintenance` (daily, concurrency 1) | single-run |
| S26 | community jobs | usable with no SQL transaction (AS-08) |
| S27 | `stories.publish` (`{storyId, scheduledAt}`, key `story-publish:<storyId>:<scheduledAt>`, concurrency 5), `stories.publish-due-sweep` (1 min) | `NonRetryableJobError`, delayed enqueue with key |
| S28 | `notifications.deliver`, unread reconciliation (5 min) | `enqueue` with `runAt` and key; handler decorator |
| S29 | `media.expire-pending-uploads`, `media.requeue-stuck`, `media.purge` | single-run |
| S30 | `media.video-expire-uploads` (5 min), `media.video-requeue-stuck` (1 min), `media.video-purge` (5 min) | single-run |
| S32 | `search.reindex`, `search.retire-previous-index`, `search.refresh-popularity`, `search.backfill-shop-state`, `search.backfill-embeddings`, `search.purge-tombstones` | single-run |
| S33 | `search.build-autocomplete` (hourly, lease 600,000 ms) | lease honoured |
| S34 | `recommendations.build-bought-together` (`17 3 * * *`, lease 1 h, concurrency 1) | fleet concurrency 1; lease up to 4 h |
| S36 | `ads.bill-hour` (minute 5 hourly), `ads.reconcile-day` (02:30 UTC) | single-run |
| S37 | share-links filter rebuild | single-run |
| S41 | `crawler.schedule-due`, `crawler.purge-targets` | single-run |
| S45 | `shop-functions.recover-stuck-versions` (60 s, concurrency 1) | fleet concurrency 1 |

All other capabilities registering jobs follow the same pattern: declare type, register handler, `upsertSchedule` at module boot.

## Pattern coverage (pattern-map rows whose Specs column names S49)

| Pattern | Where specified |
|---|---|
| P0104 Dates and time zones (UTC storage, DST, month-end anchors) | FR-040–FR-043, AS-68–AS-76 |
| P0110 Discriminated unions + exhaustive state machines | FR-007, FR-044, FR-046, AS-38, AS-93, AS-95 |
| P0114 Module augmentation (job registry) | FR-044, `JobPayloads` in Provides, AS-93, AS-94 |
| P0217 Cron with replicas (leader election) | FR-032–FR-038, AS-54, AS-55 |
| P0304 Partial indexes | FR-050, AS-88 |
| P0309 MVCC / VACUUM, HOT updates | FR-050, AS-89 |
| P0312 Row locks, `SKIP LOCKED`, advisory locks | FR-011, FR-027, FR-032, AS-10, AS-46–AS-49, AS-54 |
| P0318 Table partitioning | FR-047–FR-049, AS-84–AS-87, AS-90 |
