# arch-30. Caching a slow third-party metadata API

*Scaling · Easy*

## The question

"Our streaming app's title page shows cast, synopsis and ratings from a third-party metadata partner. Their API takes 1.5-3 s per call and allows 20 requests/s. Title pages get 300 requests/s at peak, and the metadata for a title changes a few times a month. Design the caching."

**Then:** "The partner API goes down for 2 hours on the evening a big season launches. Also, the cached entry for that show expires and 500 requests miss at the same moment."

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Which data? → assume: display-only metadata. Anything that decides what a user may watch (licensing windows, region availability, age rating enforcement) comes from our own DB, never from this cache.
- How stale is acceptable? → assume: 15 min normally; hours during a partner outage.
- Does the partner send change notifications? → assume: yes, a webhook per title, but they can be lost.
- Per-user or shared data? → assume: shared per title and locale; the page's personal parts (progress, entitlement) come from a separate call.
- How many titles? → assume: ~200k titles × 10 locales; ~5 KB each, so ~10 GB if everything were cached. Hot set is a few thousand.
- Redis available? → assume: ElastiCache.

## Design

1. **Cache-aside in Redis.** Key `meta:{partner}:title:{id}:{locale}:v2` (`v2` = payload schema version, so a deploy that changes the shape never reads old entries). Value: `{ data, fetchedAt, freshUntil, staleUntil }`.
2. **Read path:**
   - now < `freshUntil` → return.
   - `freshUntil` ≤ now < `staleUntil` → return stale data now; trigger a background refresh.
   - Missing or past `staleUntil` → fetch synchronously (single-flight), return.
3. **TTLs:** fresh 15 min, stale 24 h, Redis key TTL 7 days. ±10% jitter so entries written together don't expire together.
4. **Single-flight.** An in-process `Map<key, Promise>` dedupes within a pod. Across pods, `SET lock:{key} <id> NX PX 10000`: the winner fetches; others serve stale data, or on a cold miss wait up to ~200 ms for the winner's result.
5. **All partner calls go through one shared rate limiter**, with background refreshes at lower priority than synchronous misses.
6. **Invalidation.** A partner webhook "title changed" writes `invalidatedAt` for that key; the next read treats the entry as stale and refreshes. TTL remains the safety net for lost webhooks.
7. **Negative cache.** A 404 is cached for 1 min. Errors are never cached as data.
8. **L1.** A bounded in-process LRU (e.g. 10k entries, 5 s TTL) in front of Redis absorbs the hottest keys.
9. **Partner down.** A circuit breaker opens; serve stale data past `staleUntil`, up to the 7-day key TTL; no synchronous calls while open.

Numbers: at a ~99% hit rate, 300 req/s becomes ~3 partner calls/s, well under 20.

## Deep dives

**1. Stampede (twist, part 2).**
Problem: 500 concurrent misses = 500 partner calls, 25× the limit, each 1.5-3 s.
Approach: with stale-while-revalidate, most "expiries" are served stale with one background refresh; single-flight (in-process promise + Redis `NX` lock with TTL) collapses the rest to one call; jittered TTLs keep popular keys from expiring together.
Rejected: probabilistic early expiration alone. Good for hot keys, but it doesn't help cold misses or outages.

**2. Invalidation race.**
Problem: a refresh starts at 10:00:00, the webhook invalidates at 10:00:01, the refresh finishes at 10:00:02 and writes the old data back as fresh.
Approach: store `invalidatedAt`; a refresh writes as fresh only if its `fetchStartedAt > invalidatedAt`, otherwise it marks the entry stale. Or compare the partner's version or ETag if they expose one.
Rejected: delete-on-webhook alone. The race re-inserts old data for 15 minutes.

**3. Outage (twist, part 1).**
Problem: a 2-hour outage at peak.
Approach: stale-if-error: serve the last good value for as long as the key exists; the breaker stops piling up 3-second timeouts that would hold Node sockets and slow every page. Playback doesn't depend on this data, so the launch still works.
Rejected: short TTLs "for freshness". They turn a partner outage straight into our outage.

## Traps

- **No stale-if-error**: the partner's outage becomes ours.
- **The same TTL for everything written at once**: synchronized expiry.
- **A lock without a TTL**: a crashed holder blocks the key forever.
- **Using cached partner data for decisions** (what a user may watch).
- **Caching errors as data**: one partner blip is served for 15 minutes.
- **An unbounded in-process cache**: the Node heap grows until the pod is OOM-killed.

## Say it (60–90 s)

This data is display-only and changes a few times a month, so I'd cache it in Redis with stale-while-revalidate. Each entry stores the data, when it was fetched, a fresh-until of about fifteen minutes and a stale-until of a day, with jitter so popular keys don't expire together. A fresh entry is returned directly. A stale entry is returned immediately and refreshed in the background. Only a true miss waits for the partner. Refreshes are single-flight: a promise map inside each pod and a Redis NX lock with a TTL across pods, so five hundred simultaneous misses become one partner call, and every partner call goes through a shared rate limiter. Partner webhooks mark entries invalidated, and a refresh that started before the invalidation can't write old data back as fresh. The TTL stays as the safety net for lost webhooks. A small in-process LRU in front of Redis takes the hottest keys. If the partner is down, a circuit breaker stops calls and we serve the last good data for up to days. At a ninety-nine percent hit rate, three hundred requests a second become about three partner calls.

## Follow-ups

**Q:** What if Redis is down?
**A:** L1 keeps serving hot keys; misses go to the partner through the rate limiter; a circuit breaker on Redis avoids paying a timeout on every request.

**Q:** Could a CDN cache this instead?
**A:** For this part, yes: metadata is the same for every user in a locale, so our `/titles/:id/metadata?locale=` response can be cached at CloudFront with `s-maxage` and `stale-while-revalidate`. That removes most traffic before it reaches us. The personal parts stay on a separate, uncached call. Redis still protects the partner from CDN misses across edge locations.

**Q:** What do you monitor?
**A:** Hit ratio, share of stale responses, age of served data (p95), refresh failures, partner latency and 429s, breaker state.

</details>

## Theory in the notes

- [03-databases/04-redis-and-caching.md](../../03-databases/04-redis-and-caching.md)
- [06-distributed-systems/03-resilience-patterns.md](../../06-distributed-systems/03-resilience-patterns.md)
- [02-nodejs/03-memory-and-performance.md](../../02-nodejs/03-memory-and-performance.md)
- [10-system-design/04-web-platform-architectures.md](../../10-system-design/04-web-platform-architectures.md)
