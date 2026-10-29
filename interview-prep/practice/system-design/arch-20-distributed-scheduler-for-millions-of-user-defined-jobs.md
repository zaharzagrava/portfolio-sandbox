# arch-20. Distributed scheduler for millions of user-defined jobs

*Reliability · Medium*

## The question

"We run a workflow automation SaaS. Customers define scheduled workflows with cron expressions in their own time zone ('every weekday at 09:00 Europe/Berlin'). There are ~10M active schedules and ~50M executions a day, and a huge share fire at the top of the hour. Each run should start within a few seconds of its scheduled time and must not be silently skipped. Design the scheduler."

**Then:** "The scheduler was down for 40 minutes. What fires when it comes back? And on Monday at 09:00 US Eastern, 2M schedules are due in the same minute."

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- What does an execution do? → assume: runs a customer workflow (HTTP calls to their systems) on our worker fleet; typical runtime seconds, max 15 minutes.
- Guarantee? → assume: at-least-once start, deduplicated per (schedule, scheduled time); workflows receive an execution ID they can use as an idempotency key.
- Missed runs policy? → assume: per schedule, default "run once for the most recent missed slot"; options "skip" and "run all (max 10)".
- Edits and deletes? → assume: take effect for any run not yet started.
- Per-customer limits? → assume: max concurrent executions per workspace by plan.
- Numbers → assume: 50M/day ≈ 580/s avg. Peaks: 2M due at one minute ≈ 33k/s if all start at :00:00. Execution rows ~200 B → 10 GB/day; keep 30 days of history (partition by day, drop old partitions).

## Design

**1. Data** (Postgres)
```sql
schedules(id, workspace_id, cron text, timezone text, next_run_at timestamptz,
  version int, status text, missed_policy text)
CREATE INDEX ON schedules (next_run_at) WHERE status = 'active';
executions(schedule_id, scheduled_for timestamptz, schedule_version int,
  status text,              -- planned | running | succeeded | failed | skipped
  attempts int, lease_until timestamptz, started_at, finished_at,
  PRIMARY KEY (schedule_id, scheduled_for))         -- partitioned by day
```

**2. Planner (looks ahead 10 minutes).** 64 hash buckets of schedules, each claimed by one planner instance via a lease row (`FOR UPDATE SKIP LOCKED`, `lease_until`). Every 30 s, per bucket, in batches of 1,000:
1. Select schedules with `next_run_at < now() + interval '10 minutes'`.
2. `INSERT INTO executions … ON CONFLICT DO NOTHING` (status `planned`).
3. Compute the following `next_run_at` with a cron library in the schedule's IANA zone; update the schedule. Commit.
4. Send each execution to SQS with `DelaySeconds = seconds until scheduled_for` (SQS allows up to 900 s, which is why the look-ahead is 10 minutes).

**3. Workers** receive the message at the scheduled time and claim it:
```sql
UPDATE executions SET status = 'running', attempts = attempts + 1, lease_until = now() + interval '5 minutes'
WHERE schedule_id = $1 AND scheduled_for = $2 AND status = 'planned' RETURNING *;
```
0 rows → duplicate delivery, delete the message. Then re-check the schedule (`status = active`, `version` matches); edited or deleted → `skipped`. Run with header `X-Execution-Id: {schedule_id}:{scheduled_for}`, extending the lease and the SQS visibility timeout while running. Finish → `succeeded`/`failed`, delete the message.

**4. Repair sweeper** (every minute): `planned` executions due > 60 s ago, or `running` with an expired lease → re-enqueue. Covers a crash between commit and SQS send, and dead workers.

**5. Fairness:** a per-workspace concurrency counter (Redis or a count of running rows); over the limit → message delayed by a few seconds, not dropped.

**6. Metrics:** start delay (actual start − scheduled_for) p50/p99, planned-but-not-started count, missed runs, executions/s.

## Deep dives

**1. The 40-minute outage (twist, part 1).** On recovery, every active schedule with `next_run_at` in the past is behind. Firing every missed slot of an every-minute schedule = 40 runs at once, multiplied across millions of schedules: a self-inflicted spike that hits customers' systems too. Chosen: per-schedule `missed_policy`; default plans one execution for the most recent missed slot, marked `late`, and records the others as `skipped` (visible in history); then `next_run_at` moves to the next future slot. The planner works through the backlog in `next_run_at` order at a bounded rate. Rejected: silently skipping (customers can't tell what didn't run), replaying everything.

**2. 2M jobs at 09:00 (twist, part 2).** The look-ahead spreads the database work over the 10 minutes before 09:00; at 09:00 only SQS delivery and worker capacity matter. We know the load in advance (count of planned executions per minute), so worker autoscaling is scheduled: scale up at 08:55 based on the planned count, not reactively at 09:01. Customers who don't need the exact second get "around 09:00" by default, spreading starts over the minute. Per-workspace limits stop one customer's 100k schedules from taking the whole fleet. Rejected: polling `SELECT … WHERE next_run_at <= now()` at 09:00:00 (2M row updates in one minute on the hot index, while workers wait).

**3. Time zones and DST.** Cron runs in the schedule's zone. On the spring-forward day, 02:30 doesn't exist; on fall-back, 01:30 happens twice. Chosen and documented: a nonexistent time runs at the next valid instant (03:00), a repeated time runs once (first occurrence). Cron libraries differ here, so this is covered by tests for several zones. Rejected: storing cron in UTC (a "09:00" job moves by an hour twice a year).

**4. Why not a timer wheel in memory or Redis sorted sets?** A Redis ZSET by due time (`ZRANGEBYSCORE`) works and is fast, but Postgres already has to hold the execution history and unique key; adding Redis as a second source of "what's due" brings sync problems. SQS delay gives timing to the second without us running timers. Trigger to change: look-ahead beyond 15 minutes or sub-second precision.

## Traps

- One scheduler instance with an in-process cron: a single point of failure, and can't hold 10M schedules.
- Polling for due rows only at the moment they're due: every top-of-hour becomes a database spike.
- Assuming exactly-once execution: SQS standard and worker crashes give at-least-once; dedupe by the execution's unique key and pass an execution ID downstream.
- Computing the next run in UTC or server time: DST shifts jobs by an hour.
- Replaying every missed run after an outage.
- Ignoring edits between planning and running: the worker must re-check the schedule version.

## Say it (60–90 s)

Schedules live in Postgres with a next-run time computed in the customer's own time zone. A planner, split into sixty-four buckets claimed by leases so several instances share the work, looks ten minutes ahead: it inserts execution rows with a unique key of schedule and scheduled time, advances next-run, commits, and sends each execution to SQS with a delay equal to the seconds until it's due. SQS allows up to fifteen minutes of delay, which is why the look-ahead is ten. At the scheduled time a worker receives the message and claims the execution with a conditional update from planned to running; zero rows means it's a duplicate. It re-checks that the schedule wasn't edited, runs the workflow with an execution ID the customer can use for idempotency, and keeps a lease while running. A sweeper re-enqueues anything planned but not started, or running with an expired lease. For the forty-minute outage, each schedule runs once for its latest missed slot by default and the rest are recorded as skipped, not replayed. For two million jobs at nine, the database work already happened in the ten minutes before, and since I know the planned count, I scale workers up ahead of time.

## Follow-ups

**Q:** How accurate is SQS delay?
**A:** Messages become visible after the delay; in practice start delay is seconds. If a customer needs sub-second precision, that's a different product (in-memory timing wheel with replication).

**Q:** How do you rebalance planner buckets when instances scale?
**A:** Buckets are claimed through lease rows with expiry; a new instance takes free or expired buckets, and instances release extra buckets above `64 / live_instances`. Overlap during a handoff is harmless because execution inserts are `ON CONFLICT DO NOTHING`.

**Q:** A customer's workflow always times out at 15 minutes.
**A:** Retries with backoff up to N attempts, then `failed` with an alert to the customer; repeated failures auto-pause the schedule with a notification, so we don't burn workers forever.

</details>

## Theory in the notes

- [06-distributed-systems/01-messaging-queues-kafka-sqs.md](../../06-distributed-systems/01-messaging-queues-kafka-sqs.md)
- [03-databases/02-transactions-isolation-locking.md](../../03-databases/02-transactions-isolation-locking.md)
- [06-distributed-systems/03-resilience-patterns.md](../../06-distributed-systems/03-resilience-patterns.md)
- [08-devops-cloud/03-aws-for-nodejs-engineers.md](../../08-devops-cloud/03-aws-for-nodejs-engineers.md)
