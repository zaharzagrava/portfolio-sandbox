# arch-31. Caching a slow partner API

*Scaling · Easy*

## The question

The resident dashboard shows unit and building details from a PMS partner API that takes 1.5-3 s per call and allows 20 req/s. The dashboard gets 300 req/s at peak; the data changes a few times a month. Design the caching.

**Then:** The partner API goes down for 2 hours on rent day. Also, a cached entry for a popular building expires and 500 requests miss at the same moment.

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Which data? → assume: display-only unit and building details. Anything that decides money (amounts to charge, payout details) comes from our own DB, never from this cache.
- How stale is acceptable? → assume: 15 min normally; hours during a partner outage, shown with an "updated X ago" label.
- Does the partner send change webhooks? → assume: yes, but they can be lost.
- Per-user or shared data? → assume: shared per unit; access is checked against our DB before reading the cache.
- Redis available? → assume: ElastiCache.

## Design

1. **Cache-aside in Redis.** Key `pms:{partner}:{account}:unit:{unitId}:v2` (`v2` = payload schema version, so a deploy that changes the shape doesn't read old entries). Value: `{ data, fetchedAt, freshUntil, staleUntil }`.
2. **Read path:**
   - now < `freshUntil` → return.
   - `freshUntil` ≤ now < `staleUntil` → return stale data now; trigger a background refresh.
   - Missing or past `staleUntil` → fetch synchronously (single-flight), return.
3. **TTLs:** fresh 15 min, stale 24 h, Redis key TTL 7 days. Add ±10% jitter so entries written together don't expire together.
4. **Single-flight.** In-process `Map<key, Promise>` dedupes within a pod. Across pods, `SET lock:{key} <id> NX PX 10000`: the winner fetches; others serve stale data, or on a cold miss wait up to ~200 ms for the winner's result.
5. **Refreshes go through the shared partner rate limiter** at lower priority than synchronous misses.
6. **Invalidation.** A partner webhook "unit changed" writes `invalidatedAt` for that key; the next read treats the entry as stale and refreshes. TTL remains the safety net for lost webhooks.
7. **Negative cache.** 404 cached 1 min. Errors are never cached as data.
8. **L1.** A bounded in-process LRU (e.g. 10k entries, 5 s TTL) in front of Redis absorbs the hottest keys.
9. **Partner down.** Circuit breaker opens; serve stale data past `staleUntil` up to the 7-day key TTL with an "as of" label; no synchronous calls while open.

Numbers: at a ~99% hit rate, 300 req/s becomes ~3 partner calls/s, well under 20.

## Deep dives

**1. Stampede (twist, part 2).**
Problem: 500 concurrent misses = 500 partner calls, 25× the limit, all slow.
Approach: stale-while-revalidate means most "expiries" are served stale with one background refresh; single-flight (in-process promise + Redis `NX` lock with TTL) collapses the rest to one call; jittered TTLs keep popular keys from expiring together.
Rejected: probabilistic early expiration alone (refresh slightly before expiry with rising probability). Good for hot keys, but it doesn't help cold misses or outages.

**2. Invalidation race.**
Problem: a refresh starts at 10:00:00, the webhook invalidates at 10:00:01, the refresh finishes at 10:00:02 and writes the old data back as fresh.
Approach: store `invalidatedAt`; a refresh writes only if its `fetchStartedAt > invalidatedAt`, otherwise it marks the entry stale. Or compare the partner's version/ETag if they expose one.
Rejected: delete-on-webhook alone. The race above re-inserts stale data for 15 min.

**3. Outage (twist, part 1).**
Problem: a 2-hour outage on rent day.
Approach: stale-if-error: serve the last good value for as long as the key exists; the breaker stops piling up 3-second timeouts; the UI shows "as of". Payments don't depend on this data, so rent day keeps working.
Rejected: short TTLs "for freshness". They turn a partner outage directly into a dashboard outage.

## Traps

- **No stale-if-error**: the partner's outage becomes ours.
- **Same TTL for everything written at once**: synchronized expiry.
- **A lock without TTL**: a crashed holder blocks the key forever.
- **Using cached partner data for money decisions.**
- **Cache key without org/account**: one customer sees another's data.
- **Unbounded in-process cache**: Node heap grows until the pod is OOM-killed.

## Say it (60–90 s)

This data is display-only and changes a few times a month, so I'd cache it in Redis with stale-while-revalidate. Each entry stores the data, when it was fetched, a fresh-until of about fifteen minutes and a stale-until of a day, with jitter so popular keys don't expire together. A fresh entry is returned directly. A stale entry is returned immediately and refreshed in the background. Only a true miss waits for the partner. Refreshes are single-flight: a promise map inside each pod and a Redis NX lock with a TTL across pods, so five hundred simultaneous misses become one partner call, and every partner call goes through the shared rate limiter. Partner webhooks mark entries invalidated, and a refresh that started before the invalidation can't write old data back as fresh. TTL stays as the safety net for lost webhooks. A small in-process LRU in front of Redis takes the hottest keys. If the partner is down, a circuit breaker stops calls and we serve the last good data, up to days, with an updated-at label. With a ninety-nine percent hit rate, three hundred requests a second become about three partner calls.

## Follow-ups

**Q:** What if Redis is down?
**A:** L1 keeps serving hot keys; misses go to the partner through the rate limiter; a breaker on Redis avoids paying a timeout on every request.

**Q:** What do you monitor?
**A:** Hit ratio, share of stale responses, refresh failures, age of served data (p95), partner latency and 429s.

**Q:** Why not a CDN?
**A:** Responses are authenticated and per-org; a CDN would need per-user cache keys or would risk serving one org's data to another.

</details>

## Theory in the notes

- [03-databases/04-redis-and-caching.md](../../03-databases/04-redis-and-caching.md)
- [06-distributed-systems/03-resilience-patterns.md](../../06-distributed-systems/03-resilience-patterns.md)
- [02-nodejs/03-memory-and-performance.md](../../02-nodejs/03-memory-and-performance.md)
- [04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md](../../04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md)
