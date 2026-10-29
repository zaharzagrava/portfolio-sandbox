# fin-18. Shared rate limit for a third-party API across many workers

*Fintech pack · Integrations · Medium*

## The question

A PMS partner's API allows 100 requests/second per API key, and we have one key. 40 sync workers across 8 ECS tasks call it for 2,000 landlord accounts, plus a nightly backfill. Exceeding the limit returns 429, and repeated violations get our key suspended for an hour. Design the client-side limiting.

**Then:** One landlord with 50k units starts a full resync and every other landlord's sync slows to a crawl. Also, the partner sometimes returns 429 at 70 req/s.

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Exact limit semantics: per-second fixed window, sliding, burst allowance, headers? → assume: 100/s, window type undocumented, `Retry-After` on 429.
- Per key only, or also per partner customer? → assume: per key (twist may add per-customer).
- Priority classes? → assume: live (user actions, webhook follow-ups) > scheduled sync > backfill.
- Do all endpoints cost the same? → assume: yes for now.
- Redis available? → assume: ElastiCache in the same AZs.
- Latency tolerance? → assume: live < 5 s; backfill can take hours.

## Design

1. **Target 80 req/s,** not 100. Headroom covers unknown window alignment, retries and timeouts that the partner still counts.
2. **Global token bucket in Redis,** one key per partner API key, updated by an atomic Lua script: refill by elapsed time using Redis `TIME` (not worker clocks), take a token or return how many ms to wait. Rate 80/s, burst 10, so a fixed-window counter on their side can't see 100 in one second. Each check is a sub-millisecond round trip; workers take tokens in small batches to cut calls.
3. **Priority by reserve:** live requests can take any token; scheduled sync only when ≥ 20% of the bucket is left; backfill only when ≥ 50% is left. Idle capacity is still used, and live traffic always finds tokens.
4. **Fair scheduling across accounts.** Workers don't pull from one FIFO. Work items live per account; the claim query picks the account whose oldest ready item has waited longest, with a cap of 2 in-flight requests per account:
```sql
SELECT account_id FROM sync_work w
WHERE run_at <= now() AND status = 'queued'
  AND (SELECT count(*) FROM sync_work r WHERE r.account_id = w.account_id
       AND r.status = 'running') < 2
ORDER BY run_at LIMIT 1 FOR UPDATE SKIP LOCKED;
```
5. **429 handling:** on any 429, set `paused_until = now + Retry-After` in Redis; every worker checks it before taking tokens, so all 40 stop, not just the one that saw it. Then **AIMD**: halve the rate, add +5 req/s per minute without a 429, up to 80.
6. **Circuit breaker** on 5xx/timeouts per partner; timeouts consume tokens too.
7. **Redis down:** fall back to a static share per task (80 / 8 = 10 req/s), fail safe, not fail open.
8. **Metrics:** granted tokens/s by class, wait time, 429 count (page on any sustained 429s: suspension risk), per-account backlog age.

## Deep dives

**1. Where the limit lives.**
Problem: 40 workers, autoscaling, one quota.
Approach: Redis token bucket: one shared counter, atomic, works with any number of workers.
Rejected: static split (100 / 40 = 2.5 req/s each): idle workers waste their share and the split is wrong after every scale-out. Rejected (viable): one dispatcher process that owns the quota and hands out work. Simple and exact, but a single point of failure that needs leader election.

**2. Fairness (twist, part 1).**
Problem: a 50k-unit resync floods the queue; FIFO makes everyone wait behind it.
Approach: per-account in-flight cap + oldest-waiting-account-first claim + backfill runs only on spare capacity. The big landlord's resync takes longer; nobody else notices.
Rejected: a separate queue per account with its own rate. 2,000 queues and still no global cap.

**3. 429 below the documented limit (twist, part 2).**
Problem: the real limit is lower or counted differently (per their customer, per endpoint, sliding window).
Approach: treat 429 as the source of truth: global pause, AIMD finds the real ceiling, record observed limits per partner, raise it with the partner. If they also limit per their customer, add a second bucket per `(key, partner_customer)` and require tokens from both.
Rejected: per-worker exponential backoff alone. 40 independent backoffs still put 40 requests in flight right after each pause, and a key suspension costs an hour of all syncs.

## Traps

- **In-memory limiter per worker**: correct per process, wrong in total.
- **Retrying 429 immediately or ignoring `Retry-After`.**
- **Running at exactly the documented limit**: retries and window alignment push you over.
- **One FIFO for all accounts**: head-of-line blocking behind the biggest customer.
- **Using worker clocks in a shared bucket**: clock skew breaks the refill math.
- **Counting only successful calls**: timeouts and errors used partner quota too.

## Say it (60–90 s)

One API key means one quota, so the limit has to be global, not per worker. I'd run a token bucket in Redis, updated by an atomic Lua script that uses Redis's own clock, set to about eighty requests a second with a small burst, leaving headroom for retries and for not knowing exactly how they count. Every worker takes a token before each call. Priority is done with reserves: live requests can always take a token, scheduled sync only when a fifth of the bucket is left, backfill only when half is left, so spare capacity is used but live traffic never starves. Work is claimed per account, oldest waiting account first, with at most two in-flight requests per account, so one landlord's big resync can't block the other two thousand. On any 429 I set a shared pause in Redis for the Retry-After time so all workers stop together, then halve the rate and increase it slowly, which also finds the real limit when it's lower than documented. If Redis is down, each task falls back to a fixed tenth of the quota. I alert on sustained 429s, because suspension stops every sync for an hour.

## Follow-ups

**Q:** Why a token bucket and not a sliding window?
**A:** It allows short bursts while holding the average, and with a small burst it stays under any window type the partner might use.

**Q:** What if we get more API keys?
**A:** A bucket per key and a fixed assignment of accounts to keys. Never rotate keys to dodge limits; partners treat that as abuse.

**Q:** Isn't a Redis call per request expensive?
**A:** Sub-millisecond in-AZ, against partner calls of hundreds of ms. Taking tokens in batches of 5 per worker cuts it further.

</details>

## Theory in the notes

- [04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md](../../04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md)
- [03-databases/04-redis-and-caching.md](../../03-databases/04-redis-and-caching.md)
- [06-distributed-systems/03-resilience-patterns.md](../../06-distributed-systems/03-resilience-patterns.md)
- [12-domain-rental-payments/01-pms-and-rent-payments.md](../../12-domain-rental-payments/01-pms-and-rent-payments.md)
