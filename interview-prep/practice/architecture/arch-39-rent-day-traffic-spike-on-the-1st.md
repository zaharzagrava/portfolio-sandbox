# arch-39. Rent-day traffic spike on the 1st

*Scaling · Hard*

## The question

"Normal load is ~150 API req/s and ~2k payments an hour. On the 1st, for about 6 hours, it's 10x: tenants log in to pay, autopay runs for 200k leases, and landlords refresh their dashboards. Last month, at 09:00 on the 1st, the Postgres primary hit 100% CPU and the services ran out of DB connections. Design for rent day."

**Then:** "This month the PSP starts returning 429s at 60% of the rate you planned for. What do you do?"

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- What is the traffic made of? → assume: ~40% landlord dashboard reads, ~30% tenant checkout, plus the internal autopay batch and notifications.
- When must autopay charge? → assume: any time on the due date in the property's time zone; bank-debit files have provider cutoff times, so submit well before them.
- PSP rate limit? → assume: we negotiated 50 charge-creations/s. Defaults are provider-specific: Stripe currently documents 100 req/s global in live mode, 25 req/s per endpoint unless noted, and 50 concurrent requests, and asks for large increases weeks in advance. Confirm before planning.
- Database? → assume: one Aurora/RDS PostgreSQL writer, readers can be added.
- Targets? → assume: checkout p99 < 1 s; all autopay submitted by 14:00 local; dashboards may be a minute stale.
- Client behaviour? → assume: the mobile app retries failed calls. That must not turn into a retry storm.

## Design

**Principle: protect the money path, and make the batch load flat instead of spiky.**

1. **Traffic classes with separate budgets.** Checkout (interactive, highest priority), autopay (batch), dashboards (reads, can be stale), notifications (bulk). Each has its own worker pool and DB connection pool: a bulkhead, so dashboards can't take checkout's connections.
2. **Autopay through a queue with fixed concurrency.** The scheduler enqueues 200k charge commands the night before with staggered `ready_at`. Workers pull at a rate set by the PSP budget, using a shared token bucket (arch-26): 50 req/s ≈ 180k/hour, so ~70 minutes. Queue depth absorbs the burst; workers do **not** autoscale past the DB and PSP budget.
3. **Connection budget.** RDS Proxy or PgBouncer (transaction mode) in front of the writer. Per-service caps: `pool.max × max_tasks ≤ budget`. Example: checkout API 40 tasks × 5 = 200, autopay workers 10 × 5 = 50, everything else ≤ 100.
4. **Take reads off the writer.** Landlord dashboards read a precomputed `landlord_summary` table updated from payment events, served from a reader and cached 60 s in Redis. Lists go to a reader; the UI says "updated 30 s ago". A tenant who just paid reads their own payment by ID from the writer (read-your-writes).
5. **Pre-scale.** Scheduled scaling at 06:00 local on the 1st for API tasks and Aurora readers; reactive autoscaling lags by minutes. Any instance-class change on the writer happens days before (it's a failover).
6. **Load shedding, in order:** exports and analytics off → dashboards served from cache only → notifications deferred → checkout last. Overload responses are `503`/`429` with `Retry-After`; clients use jittered exponential backoff; idempotency keys make retries safe.
7. **Verify.** Find last month's top queries in `pg_stat_statements`, fix them. Load test at 12x with k6 against a prod-sized copy the week before, with the PSP mocked at latencies sampled from live calls (PSP sandboxes have lower limits and different latency). Rent-day dashboard, runbook and kill-switch flags ready.

## Deep dives

**1. Why connections ran out.** Autoscaling took the API from 10 to 60 tasks with pool size 20 = 1,200 connections. Each Postgres connection is a backend process with its own memory, and many active ones fight over CPU and locks. Chosen: a pooler plus per-service budgets. Caveat: transaction pooling breaks session state (`SET`, session advisory locks, `LISTEN`); prepared statements need a pooler that supports them (PgBouncer added protocol-level support in 1.21), and RDS Proxy "pins" a client to one connection when it sees session state, which removes the benefit. Rejected: raising `max_connections`. More processes on a CPU-bound primary makes it slower.

**2. Batch vs interactive.** Last month autopay ran as a cron loop with `Promise.all` at midnight local time, competing with tenants paying by hand at 09:00. Chosen: queue + fixed concurrency + priority for checkout. The trade-off is that autopay finishes later in the day, which the business accepts because only the date matters.

**3. Dashboards were the CPU.** Aggregates over the payments table per landlord on every refresh, 10x on the 1st. Precompute the summary on write (small update per payment event) and serve it from cache. Rejected: just add readers. It helps, but the same expensive query on a reader still costs a lot, and it lags under write load.

**4. Retry storms.** At 10x, a slow DB makes clients time out and retry, which doubles load at the worst moment. Server-side: shed early with `Retry-After`, circuit breaker on the PSP. Client-side: backoff with jitter, capped attempts.

## Traps

- "Just autoscale": it scales the thing that kills the database.
- Raising `max_connections` instead of pooling and budgeting.
- Firing 200k autopay charges at 00:00 in one loop.
- Running dashboard aggregates on the primary.
- Retrying 429/5xx immediately and without jitter, from clients or workers.
- Load testing against a near-empty database: plans and cache hit rates are nothing like production.

## Say it (60–90 s)

Rent day is predictable, so I plan for it instead of reacting. First I separate traffic classes: checkout, autopay, dashboards and notifications each get their own workers and their own database connection budget, so dashboards can't starve checkout. Autopay doesn't run as a burst at midnight: the scheduler enqueues the charges the night before, and workers pull them at a fixed rate set by the PSP's limit through a shared token bucket. At 50 per second, 200,000 charges take about 70 minutes, and the queue absorbs the rest. The connection problem came from autoscaling: more tasks times pool size means more Postgres connections than it can handle. So I put RDS Proxy or PgBouncer in front and give each service a hard cap. Dashboards were the CPU problem, so I precompute a per-landlord summary on each payment event, serve it from a reader and cache it for a minute. I pre-scale API tasks and readers at 6 a.m. instead of waiting for autoscaling. If we still overload, we shed in order: exports, then live dashboards, then notifications, with checkout last, returning Retry-After so clients back off with jitter. And the week before, I load test at 12x on production-sized data.

## Follow-ups

**Q:** Then: the PSP returns 429 at 60% of plan. What now?
**A:** The shared bucket adapts: halve the rate on 429, increase slowly, respect `Retry-After`. Reserve a fixed share (say 30%) for interactive checkout, so autopay absorbs the cut. Workers don't retry immediately: they return the message to the queue with a delay (SQS `ChangeMessageVisibility`). The PSP now allows ~30 req/s; with 30% reserved for checkout, autopay gets ~20 req/s and still finishes 200k in under 3 hours, before the cutoff. After the day, ask the PSP for a higher limit before next month.

**Q:** Why not just buy a much bigger database?
**A:** It may be the cheapest short-term fix and is fine to do as well. But most of the load was avoidable work (dashboard aggregates, a midnight burst), and a resize on RDS is a failover, so plan it days ahead.

**Q:** Does Aurora Serverless v2 solve it?
**A:** It adjusts writer capacity automatically, but you'd still set a high minimum capacity before the 1st, and it doesn't fix connection counts or the expensive queries.

</details>

## Theory in the notes

- [06-distributed-systems/03-resilience-patterns.md](../../06-distributed-systems/03-resilience-patterns.md)
- [06-distributed-systems/01-messaging-queues-kafka-sqs.md](../../06-distributed-systems/01-messaging-queues-kafka-sqs.md)
- [03-databases/04-redis-and-caching.md](../../03-databases/04-redis-and-caching.md)
- [03-databases/01-postgres-indexing-and-query-planning.md](../../03-databases/01-postgres-indexing-and-query-planning.md)
- [08-devops-cloud/03-aws-for-nodejs-engineers.md](../../08-devops-cloud/03-aws-for-nodejs-engineers.md)
