# arch-41. Black Friday: a 10x traffic spike

*Scaling · Hard*

## The question

"Our e-commerce site normally serves ~800 API requests/s and ~300 orders/min. On Black Friday traffic is 10x for about 12 hours, with doorbuster deals dropping at 00:00 and 09:00. Last year at 00:00 the Postgres primary hit 100% CPU, the services ran out of database connections, and checkout was down for 40 minutes. Design for this year."

**Then:** "This year the payment provider starts returning 429s at 60% of the authorization rate you planned for. What do you do?"

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Traffic mix? → assume: ~70% browsing (product, category, search), ~15% cart, ~5% checkout, the rest account and order history; plus internal work: confirmation emails, warehouse export, marketplace feed sync.
- What must be synchronous? → assume: card authorization at checkout. Capture happens at shipment (normal for physical goods); emails, exports and loyalty points are async.
- Payment provider limit? → assume: we negotiated 100 authorizations/s. Defaults are provider-specific; confirm and request increases weeks ahead.
- Database? → assume: one Aurora PostgreSQL writer; readers can be added.
- Targets? → assume: checkout p99 < 1.5 s and no lost orders; browse pages may be a minute stale; stock badges on product pages may be approximate.
- Clients? → assume: the mobile app retries failed calls. That must not become a retry storm.

## Design

**Principle: protect checkout, make spiky work flat and queued, and keep the database for what only it can do.**

1. **Cache anonymous browsing at the edge.** Product, category and search pages for anonymous users go through CloudFront with `s-maxage=60, stale-while-revalidate=300`. Price and stock badges come from a small separate call cached 5-10 s in Redis. Numbers: 8,000 req/s × 70% = 5,600 browse req/s; at a 95% CDN hit rate ~280 reach us.
2. **Traffic classes with bulkheads.** Checkout, cart, browse-origin, account and back office run as separate services (or at least separate worker pools), each with its own DB connection budget, so a slow category query can't take checkout's connections.
3. **Connection budget.** RDS Proxy or PgBouncer (transaction mode) in front of the writer. Per-service caps with `pool.max × max_tasks ≤ budget`, e.g. checkout 40 tasks × 5 = 200, cart 100, everything else ≤ 100. Autoscaling max is set from this budget, not from CPU alone.
4. **Async after the order commits.** Order row + outbox in one transaction; emails, warehouse export, loyalty points and feed sync go through SQS with fixed worker concurrency. Captures run as a batch after the peak.
5. **Reads off the writer.** Order history and account pages read from Aurora readers. The confirmation page reads the new order by ID from the writer (read-your-writes).
6. **Pre-scale.** Scheduled scaling at 23:00 and 08:00 for ECS tasks and Aurora readers; reactive autoscaling lags by minutes. Any writer instance-class change happens a week before (it's a failover). Reserve ALB capacity (LCU reservation) for the drops.
7. **Admission control.** A waiting room in front of checkout lets users in at the rate the DB and payment provider sustain; the rest see a queue position instead of errors.
8. **Load shedding, in order:** recommendations off (flag) → reviews from cache only → back-office reports paused → exports deferred → checkout last. Overload responses are `503`/`429` with `Retry-After`; clients use jittered backoff; create-order takes an idempotency key.
9. **Verify.** Fix last year's top queries from `pg_stat_statements`. Load test at 12x on production-sized data with the payment provider mocked at latencies sampled from live calls. Runbook, dashboards and kill-switch flags ready; a game day the week before.

## Deep dives

**1. Why connections ran out.** Autoscaling took the API from 10 to 60 tasks with a pool of 20: 1,200 connections. Each Postgres connection is a backend process with its own memory, and many active ones fight over CPU and locks, so throughput drops as connections rise. Chosen: a pooler plus per-service budgets. Caveat: transaction pooling breaks session state (`SET`, session advisory locks, `LISTEN`); prepared statements need a pooler that supports them (PgBouncer 1.21+), and RDS Proxy pins a client to one connection when it sees session state, which removes the benefit. Rejected: raising `max_connections`; more processes on a CPU-bound primary make it slower.

**2. Most of last year's load was avoidable.** Every product page queried Postgres for price, stock and reviews, at 10x. The stock number on a product page doesn't need to be exact: correctness is enforced when checkout reserves stock. So browse pages are cached and approximate, and the database only serves carts and orders. Rejected: "just add readers". It helps, but the same expensive queries still cost CPU and the readers lag under write load.

**3. Retry storms.** At 10x a slow DB makes clients time out and retry, which doubles load at the worst moment. Server side: shed early with `Retry-After`, circuit breaker on the payment provider. Client side: backoff with jitter, capped attempts. Idempotency keys make the retries that do happen safe.

## Traps

- "Just autoscale": it scales the thing that kills the database.
- Raising `max_connections` instead of pooling and budgeting.
- Product pages hitting the primary for every view.
- Sending emails, exports and captures synchronously inside checkout.
- Retrying 429/5xx immediately and without jitter, from clients or workers.
- Load testing against a near-empty database: plans and cache hit rates are nothing like production.

## Say it (60–90 s)

Black Friday is predictable, so I plan for it instead of reacting. Most traffic is anonymous browsing, so product, category and search pages are cached at CloudFront with stale-while-revalidate, and price and stock badges come from a short Redis cache. At ten times traffic that turns five and a half thousand browse requests a second into a few hundred. Stock on a product page can be approximate, because checkout enforces it. Then I separate traffic classes: checkout, cart, browse and back office each get their own pools and database connection budget, behind RDS Proxy or PgBouncer, so nothing can starve checkout. Last year's outage was connection count: autoscaling times pool size. So autoscaling limits come from the connection budget. Everything after the order commits goes through an outbox and queues with fixed concurrency: emails, warehouse export, and card captures after the peak. I pre-scale tasks and readers an hour before each drop. A waiting room admits checkouts at the rate the database and payment provider can take. If we still overload, we shed in order: recommendations, reviews, reports, exports, checkout last, with Retry-After so clients back off. And the week before, I load test at twelve times on production-sized data.

## Follow-ups

**Q:** Then: the payment provider returns 429 at 60% of plan. What now?
**A:** First, take every non-checkout call off the provider: captures, refunds, saved-card checks and subscription renewals wait until after the peak (capture within the authorization's validity, which varies by network). Second, one shared token bucket for authorizations that adapts: halve on 429, increase slowly, respect `Retry-After`. Third, size the checkout waiting room to the new rate, so customers wait before entering checkout instead of failing at the pay button. If we have a second provider, route a share there. Afterwards, get the limit raised before next year.

**Q:** Why not just buy a much bigger database?
**A:** Do it as well if it's cheap, but most of the load was avoidable work, and a resize is a failover, so it's planned days ahead.

**Q:** How do you protect inventory under doorbuster contention?
**A:** That's its own design: atomic conditional decrements or reservations with expiry per SKU, so the hot rows stay short-lived. Here the point is that only carts and checkout touch those rows; browse never does.

</details>

## Theory in the notes

- [06-distributed-systems/03-resilience-patterns.md](../../06-distributed-systems/03-resilience-patterns.md)
- [06-distributed-systems/01-messaging-queues-kafka-sqs.md](../../06-distributed-systems/01-messaging-queues-kafka-sqs.md)
- [03-databases/04-redis-and-caching.md](../../03-databases/04-redis-and-caching.md)
- [08-devops-cloud/03-aws-for-nodejs-engineers.md](../../08-devops-cloud/03-aws-for-nodejs-engineers.md)
- [10-system-design/07-commerce-and-transactions.md](../../10-system-design/07-commerce-and-transactions.md)
