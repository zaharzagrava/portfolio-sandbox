# arch-35. Run a scheduled job exactly once across N instances

*Reliability · Easy*

## The question

"Our clinic booking platform's API runs as 6 identical ECS tasks. Every night at 02:30 America/New_York we send SMS reminders for tomorrow's appointments, and every 5 minutes we release unconfirmed slot holds. Each job must run once per schedule, not 6 times, and must not be skipped when an instance is down. How?"

**Then:** "Reminders now take 40 minutes (2M appointments), and the task running them sometimes gets killed halfway by a deploy."

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Is a double run harmful or just wasteful? → assume: harmful: a patient gets two SMS and we pay twice. So effects must be idempotent anyway.
- Catch-up after a missed run? → assume: reminders must go out the same night; the 5-minute job doesn't need catch-up, the next run covers it.
- Connection pooling? → assume: PgBouncer or RDS Proxy in transaction mode (matters for advisory locks).
- Duration? → assume: reminders ~5 min today; the 5-minute job ~20 s.
- Time zone and DST? → assume: the business schedule is in America/New_York.

## Design

1. **One trigger source.** EventBridge Scheduler with a cron expression in time zone `America/New_York` sends a message to SQS (or starts an ECS task). Not 6 in-process timers. The scheduler delivers at least once, so step 2 still matters.
2. **Claim by run key in Postgres:**
```sql
CREATE TABLE job_runs (
  job text NOT NULL, run_key text NOT NULL,   -- business date or schedule slot
  status text NOT NULL, owner text, attempt int NOT NULL DEFAULT 1,
  expires_at timestamptz, checkpoint jsonb,
  started_at timestamptz, finished_at timestamptz, error text,
  PRIMARY KEY (job, run_key));

INSERT INTO job_runs (job, run_key, status, owner, expires_at, started_at)
VALUES ('reminders', '2026-10-27', 'running', $1, now() + interval '2 min', now())
ON CONFLICT DO NOTHING RETURNING *;
```
A returned row means you own the run; no row means someone else has it. The run key comes from the **scheduled** slot (the business date, or `2026-10-27T10:05` for the 5-minute job), never from the worker's clock.
3. **Idempotent work.** Insert `reminders(appointment_id, kind, status = 'pending')` with `UNIQUE (appointment_id, kind)` and `ON CONFLICT DO NOTHING`; then send only `pending` rows, moving each to `sending` before the SMS call and to `sent` after. Releasing holds is `UPDATE slots SET held_by = NULL WHERE held_until < now()`, safe to repeat.
4. **Lease.** `expires_at` is the owner's lease; the owner renews it every 30 s. If the lease expires, another instance takes over: `UPDATE job_runs SET owner = $me, attempt = attempt + 1, expires_at = ... WHERE job = $1 AND run_key = $2 AND status = 'running' AND expires_at < now() RETURNING attempt`.
5. **Dead-man alert.** At 06:00, if today's `reminders` run isn't `succeeded`, page. For the 5-minute job, alert if there's no success in 20 minutes.

**Twist.** Process appointments in batches of 1,000 by id, each its own transaction; after each batch write `checkpoint = {last_id}`. A takeover resumes from the checkpoint. On SIGTERM finish the current batch and release the lease. Better: run the job as its own ECS task (RunTask), not inside API tasks, so API deploys don't touch it.

## Deep dives

**1. Postgres advisory locks.**
Problem: `pg_try_advisory_lock` looks like the obvious tool.
Approach: avoid session-level advisory locks behind a transaction-mode pooler: the lock stays on a server connection that other clients then reuse, and the unlock may run on a different connection. `pg_try_advisory_xact_lock` inside one transaction is fine for short jobs, but gives no run history and no answer to "did tonight's run happen".
Chosen: the `job_runs` row: claim, history, lease and checkpoint in one place.

**2. Redis lock (SET NX PX).**
Problem: TTL-based locks (leases) expire while the holder is paused (long GC, CPU starvation) and still believes it holds the lock.
Approach: if used, the work must be idempotent or check a fencing token (the `attempt` number) on writes. The data is in Postgres, so the Postgres row is simpler with the same failure model.

**3. DST.**
Problem: New York moves clocks at 02:00 local time. On the spring-forward day 02:30 doesn't exist; on the fall-back day 01:00-02:00 happens twice. What a scheduler does with a skipped or repeated local time varies.
Approach: key runs by business date, so whatever the scheduler does there's at most one run per date, plus the dead-man alert for a skipped one; or schedule at 03:30, clear of the transition.
Rejected: a UTC cron. It drifts an hour against the local day twice a year.

## Traps

- **`node-cron` or `setInterval` in every instance** with no claim: 6 runs.
- **"Exactly once" as a claim**: triggers are at-least-once; you get once by claim + idempotent effects.
- **A lock TTL shorter than the job without a heartbeat**: a second runner starts halfway.
- **Session advisory locks behind PgBouncer** in transaction mode.
- **Run key from the worker's wall clock**: two instances in different seconds produce different keys.
- **No alert on "didn't run"**: missing runs are silent by nature.

## Say it (60–90 s)

I want one trigger and a claim that makes duplicates harmless. The trigger is EventBridge Scheduler with the New York time zone, sending a message to a queue or starting a task, instead of a timer in each of the six instances. Schedulers deliver at least once, so the job claims its run in Postgres: insert a row keyed by job name and the scheduled slot, the business date, with ON CONFLICT DO NOTHING. If I get the row back, I own the run; if not, someone else does. The work itself is idempotent: each reminder is recorded with a unique key on appointment and kind before it's sent, so even a double run sends nothing extra. The owner holds a lease and renews it with a heartbeat; if it dies, another instance takes over after the lease expires. Business-date keys also handle DST, since New York changes clocks at two in the morning and two-thirty doesn't exist one night a year. A dead-man alert fires if tonight's run hasn't succeeded by six. For the forty-minute version, I process in batches of a thousand with a checkpoint after each, so a takeover resumes instead of restarting, and I run it as its own ECS task so API deploys don't kill it.

## Follow-ups

**Q:** Why not one dedicated "cron" instance?
**A:** It's a single point of failure and gets killed by its own deploys; you still need run history and idempotency. Fine as a trigger only if paired with the claim.

**Q:** What if the 5-minute job overruns into the next slot?
**A:** Before claiming a new slot, skip if a run for that job is still `running` with an unexpired lease (`expires_at`).

**Q:** The process crashes after the SMS provider accepted a message but before we marked it sent. Duplicate?
**A:** Possibly one, on retry. Most SMS APIs won't dedupe for you, so the row has three states (`pending`, `sending`, `sent`); a retry skips `sending` rows older than a minute and reports them instead of resending. One rare missed reminder is better than a burst of duplicates.

</details>

## Theory in the notes

- [03-databases/02-transactions-isolation-locking.md](../../03-databases/02-transactions-isolation-locking.md)
- [06-distributed-systems/03-resilience-patterns.md](../../06-distributed-systems/03-resilience-patterns.md)
- [08-devops-cloud/03-aws-for-nodejs-engineers.md](../../08-devops-cloud/03-aws-for-nodejs-engineers.md)
- [02-nodejs/04-error-handling-and-graceful-shutdown.md](../../02-nodejs/04-error-handling-and-graceful-shutdown.md)
