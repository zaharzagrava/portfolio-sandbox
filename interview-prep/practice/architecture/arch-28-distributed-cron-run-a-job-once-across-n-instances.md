# arch-28. Distributed cron: run a job once across N instances

*Reliability · Easy*

## The question

Our API runs as 6 identical ECS tasks. Every night at 02:00 Asia/Jerusalem we run "mark overdue charges", and every 5 minutes "retry stuck payouts". Each must run once per schedule, not 6 times, and must not be skipped when an instance is down. How?

**Then:** The nightly job now takes 40 minutes, and the task running it sometimes gets killed halfway by a deploy.

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Is a double run harmful or just wasteful? → assume: harmful for some steps (a late fee created twice), so effects must be idempotent anyway.
- Catch-up after a missed run? → assume: nightly must run the same day; the 5-minute job doesn't need catch-up.
- Connection pooling? → assume: PgBouncer or RDS Proxy in transaction mode (matters for advisory locks).
- Duration? → assume: nightly ~5 min today; 5-minute job ~20 s.
- Time zone and DST? → assume: business schedule in Asia/Jerusalem.

## Design

1. **One trigger source.** EventBridge Scheduler with a cron expression in time zone `Asia/Jerusalem` sends a message to SQS (or starts an ECS task). Not 6 in-process timers. The scheduler delivers at least once, so step 2 still matters.
2. **Claim by run key in Postgres:**
```sql
CREATE TABLE job_runs (
  job text NOT NULL, run_key text NOT NULL,   -- business date or schedule slot
  status text NOT NULL, owner text, attempt int NOT NULL DEFAULT 1,
  lease_until timestamptz, checkpoint jsonb,
  started_at timestamptz, finished_at timestamptz, error text,
  PRIMARY KEY (job, run_key));

INSERT INTO job_runs (job, run_key, status, owner, lease_until, started_at)
VALUES ('mark-overdue', '2026-10-25', 'running', $1, now() + interval '2 min', now())
ON CONFLICT DO NOTHING RETURNING *;
```
A returned row means you own the run; no row means someone else has it. The run key comes from the **scheduled** slot (business date `2026-10-25`, or `2026-10-25T10:05` for the 5-minute job), never from the worker's clock.
3. **Idempotent work.** `UPDATE charges SET status='overdue' WHERE due_date < $date AND status='due'` is safe to re-run; late fees use `UNIQUE (charge_id, rule_id, period)`.
4. **Leases.** The owner extends `lease_until` every 30 s. If it expires, another instance takes over: `UPDATE job_runs SET owner=$me, attempt=attempt+1, lease_until=... WHERE job=$1 AND run_key=$2 AND status='running' AND lease_until < now() RETURNING attempt`.
5. **Dead-man alert.** At 06:00, if `mark-overdue` for today isn't `succeeded`, page. For the 5-minute job, alert if no success in 20 minutes.

**Twist.** Process charges in batches of 1,000 by id, each batch its own transaction; after each batch write `checkpoint = {last_id}`. A takeover resumes from the checkpoint. On SIGTERM finish the current batch and release the lease. Better: run the nightly job as its own ECS task (RunTask), not inside API tasks, so API deploys don't touch it.

## Deep dives

**1. Postgres advisory locks.**
Problem: `pg_try_advisory_lock` looks like the obvious tool.
Approach: avoid session-level advisory locks behind a transaction-mode pooler: the lock stays on a server connection that other clients then reuse, and the unlock may run on a different connection. `pg_try_advisory_xact_lock` inside one transaction is fine for short jobs, but gives no run history and no "did today's run happen".
Chosen: the `job_runs` row: claim, history, lease and checkpoint in one place.

**2. Redis lock (SET NX PX).**
Problem: TTL-based locks expire while the holder is paused (long GC, CPU starvation) and still believes it holds the lock.
Approach: if used, the work must be idempotent or check a fencing token (the `attempt` number) on writes. Since the data is in Postgres, the Postgres row is simpler and has the same failure model.

**3. DST.**
Problem: Israel moves clocks at 02:00 local time, so on the spring-forward day 02:00 doesn't exist and on the fall-back day 01:00-02:00 happens twice.
Approach: key runs by business date, so whatever the scheduler does, there's at most one run per date; or schedule at 03:30 to stay clear of the transition.
Rejected: a UTC cron "00:00 UTC". It drifts an hour against the business day twice a year.

## Traps

- **`node-cron`/`setInterval` in every instance** with no claim: 6 runs.
- **"Exactly once" as a claim**: triggers are at-least-once; you get once by claim + idempotent effects.
- **Lock TTL shorter than the job without heartbeat**: a second runner starts halfway.
- **Session advisory locks behind PgBouncer** in transaction mode.
- **Run key from the worker's wall clock**: two instances in different seconds produce different keys.
- **No alert on "didn't run"**: missing runs are silent by nature.

## Say it (60–90 s)

I want one trigger and a claim that makes duplicates harmless. The trigger is EventBridge Scheduler with the Asia/Jerusalem time zone, sending a message to a queue or starting a task, instead of a timer in each of the six instances. Schedulers deliver at least once, so the job claims its run in Postgres: insert a row keyed by job name and the scheduled slot, like the business date, with ON CONFLICT DO NOTHING. If I get the row back, I own the run; if not, someone else does. The work itself is idempotent, an update with a status condition and unique keys for any late fees, so even a double run does nothing extra. The owner holds a lease and heartbeats it; if it dies, another instance takes over after the lease expires. Business-date keys also handle DST, since Israel changes clocks at two in the morning. A dead-man alert fires if today's run hasn't succeeded by six. For the forty-minute version, I process in batches of a thousand with a checkpoint after each, so a takeover resumes instead of restarting, and I run it as its own ECS task so API deploys don't kill it.

## Follow-ups

**Q:** Why not one dedicated "cron" instance?
**A:** It's a single point of failure and gets killed by its own deploys; you still need run history and idempotency. Fine as a trigger only if it's paired with the claim.

**Q:** What if the 5-minute job overruns into the next slot?
**A:** Before claiming a new slot, skip if a run for that job is still `running` with a valid lease.

**Q:** Kubernetes CronJob?
**A:** Fine as the trigger with `concurrencyPolicy: Forbid`, but the docs say it creates a job approximately once per schedule and jobs should be idempotent; same claim + idempotency applies.

</details>

## Theory in the notes

- [03-databases/02-transactions-isolation-locking.md](../../03-databases/02-transactions-isolation-locking.md)
- [06-distributed-systems/03-resilience-patterns.md](../../06-distributed-systems/03-resilience-patterns.md)
- [08-devops-cloud/03-aws-for-nodejs-engineers.md](../../08-devops-cloud/03-aws-for-nodejs-engineers.md)
- [02-nodejs/04-error-handling-and-graceful-shutdown.md](../../02-nodejs/04-error-handling-and-graceful-shutdown.md)
