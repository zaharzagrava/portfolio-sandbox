# arch-27. Background job system: Postgres-as-queue vs SQS

*Reliability · Medium*

## The question

We need a background job system for ~2M jobs/day: send receipts, sync PMS records, call PSP APIs, generate exports. Jobs take 100 ms to 10 minutes. Some must retry with backoff for up to 24 hours, failures must be visible to ops, and some jobs must be created atomically with a DB write. Postgres-as-queue or SQS? Design it.

**Then:** A job that calls the PSP keeps crashing the worker process (OOM) mid-call. What happens to that job, and how do you make sure the PSP charge isn't made twice?

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Peak rate? → assume: ~23 jobs/s average, ~10× on the 1st: ~250 jobs/s.
- Ordering? → assume: none globally; some jobs must not run concurrently for the same account.
- Delayed jobs? → assume: yes, retries hours later and scheduled sends.
- Payload size? → assume: small (ids); large data stays in S3/Postgres.
- Consumers? → assume: Node services owned by us; no other team consumes these jobs.
- Ops tooling? → assume: needed: list failed jobs, retry, discard, see why.

## Design

**Choice:** Postgres jobs table as the default (pg-boss or graphile-worker, or ~200 lines of our own). SQS for fan-out-heavy or cross-service work, fed by an outbox.
```sql
CREATE TABLE jobs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  queue text NOT NULL, payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued',      -- queued|running|succeeded|dead
  run_at timestamptz NOT NULL DEFAULT now(),
  attempts int NOT NULL DEFAULT 0, max_attempts int NOT NULL DEFAULT 12,
  concurrency_key text,                        -- e.g. 'account:77'
  locked_by text, locked_until timestamptz, last_error text,
  dedupe_key text UNIQUE
);
CREATE INDEX jobs_ready ON jobs (queue, run_at) WHERE status = 'queued';
CREATE UNIQUE INDEX jobs_one_running ON jobs (concurrency_key)
  WHERE status = 'running' AND concurrency_key IS NOT NULL;
```
1. **Enqueue** in the same transaction as the business write (`INSERT INTO payments ...; INSERT INTO jobs ...`). No outbox needed for jobs that stay in this DB.
2. **Claim** (short transaction, commit before running the job):
```sql
UPDATE jobs SET status='running', attempts = attempts + 1,
       locked_by=$1, locked_until = now() + interval '5 minutes'
WHERE id = (SELECT id FROM jobs j WHERE queue=$2 AND status='queued' AND run_at <= now()
              AND NOT EXISTS (SELECT 1 FROM jobs r WHERE r.status='running'
                              AND r.concurrency_key = j.concurrency_key)
            ORDER BY run_at LIMIT 1 FOR UPDATE SKIP LOCKED)
RETURNING *;
```
The `NOT EXISTS` skips keys already running; the partial unique index catches the race where two workers claim the same key at once (one gets a unique violation and retries).
3. **Run** outside any transaction. Long jobs heartbeat `locked_until` every minute.
4. **Finish:** success → `succeeded`. Retryable failure (5xx, timeout, 429) → `queued`, `run_at = now() + random(0, min(2h, 30s × 2^attempts))` (full jitter). Non-retryable (validation, 4xx) → `dead` at once. `attempts ≥ max_attempts` → `dead`. 12 attempts with a 2 h cap cover ~24 h.
5. **Reaper** every minute: `running` and `locked_until < now()` → back to `queued`.
6. **Table hygiene:** delete `succeeded` after 7 days in batches, or partition by day and drop; lower autovacuum thresholds on this table (high churn).
7. **Ops:** a dead-jobs page (error, attempts, payload, retry/discard buttons); alert on **oldest ready job age** per queue and dead count.

## Deep dives

**1. Postgres vs SQS.**
Problem: atomic enqueue, visibility, retries up to 24 h.
Approach: Postgres. The job commits with the business row; "why is job X stuck" is a SELECT; per-account serialization is a partial unique index; 250 jobs/s is easy. Costs: dead tuples from churn, polling load, a few connections per worker.
Rejected as default: SQS. It needs an outbox for atomic enqueue (the send can't join the DB transaction), `DelaySeconds` caps at 15 minutes, visibility timeout at 12 hours, retention at 14 days, and finding one job means console digging. Use it where it shines: high fan-out (1M PDF renders), Lambda consumers, other services consuming, or rates beyond a few thousand/s.

**2. The crash loop (twist, part 1).**
Problem: an OOM kills the process; no `catch` runs.
Approach: `attempts` is incremented at **claim**, not on failure, so every crash counts. The reaper returns the job after the lease expires; after `max_attempts` it goes `dead` instead of crashing workers forever. Log the job id at claim so the OOM is traceable.
Rejected: incrementing attempts in the error handler: a poison job crash-loops the fleet indefinitely.

**3. Not charging twice (twist, part 2).**
Problem: crash after the PSP accepted the charge, before we recorded it.
Approach: claim → call → record, with the PSP idempotency key = the **payment id** (stable across job retries and re-enqueues), not the job id. Before re-calling on a retry, look up the payment at the PSP (by our reference/metadata). Idempotency keys at PSPs expire (Stripe documents at least 24 h), so a retry days later must not rely on the key alone.
Rejected: holding a DB transaction open across the PSP call: idle-in-transaction connections, blocked vacuum, and it still doesn't prevent the double call.

## Traps

- **Running a 10-minute job inside the claim transaction**: holds locks and a connection, blocks vacuum.
- **Incrementing attempts only in `catch`**: crashes never count.
- **No jitter on backoff**: all failed jobs retry in the same second.
- **Job id as the external idempotency key**: a re-enqueued job gets a new id and charges again.
- **SQS visibility timeout shorter than the job**: the message reappears and a second worker runs it concurrently.
- **Polling with `ORDER BY created_at` without a partial index**: scans of millions of finished rows.

## Say it (60–90 s)

At two million jobs a day, about two hundred fifty a second at peak, I'd use Postgres as the default queue, because many jobs must be created atomically with a business write, and with a jobs table that's just an insert in the same transaction. Workers claim with an update over a SELECT FOR UPDATE SKIP LOCKED, set a lease and increment attempts at claim time, commit, and run the job outside any transaction, extending the lease for long jobs. Retryable failures go back with exponential backoff and full jitter, capped at two hours, so twelve attempts cover a day; validation errors go straight to dead. A reaper requeues expired leases. A partial unique index on a concurrency key stops two jobs for the same account running at once. Ops get a dead-jobs page with retry and discard, and the alert is on the age of the oldest ready job. I'd use SQS, fed by an outbox, for big fan-outs or other services. For the OOM case: because attempts count at claim, the crash loop ends in dead after twelve tries. And the PSP call uses the payment id as idempotency key, with a status lookup before retrying.

## Follow-ups

**Q:** How do you shut down workers during a deploy?
**A:** On SIGTERM stop claiming, finish in-flight jobs within the grace period (ECS `stopTimeout` is at most 120 s); longer jobs rely on lease expiry plus idempotency.

**Q:** Polling latency?
**A:** Each worker polls about every second when idle; `LISTEN/NOTIFY` can wake workers sooner, with polling kept as the fallback.

**Q:** When does Postgres stop being enough?
**A:** Sustained thousands of jobs/s, or vacuum can't keep up with churn. Then move high-volume queues to SQS behind the outbox and keep the rest.

</details>

## Theory in the notes

- [06-distributed-systems/01-messaging-queues-kafka-sqs.md](../../06-distributed-systems/01-messaging-queues-kafka-sqs.md)
- [03-databases/02-transactions-isolation-locking.md](../../03-databases/02-transactions-isolation-locking.md)
- [06-distributed-systems/03-resilience-patterns.md](../../06-distributed-systems/03-resilience-patterns.md)
- [02-nodejs/04-error-handling-and-graceful-shutdown.md](../../02-nodejs/04-error-handling-and-graceful-shutdown.md)
