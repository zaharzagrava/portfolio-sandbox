# Redis and Caching Strategies

Redis data structures, caching patterns, failure modes, locks, and rate limiting.

---

## 1. Redis fundamentals

- Single-threaded command execution (I/O threads since Redis 6), so **each command is atomic**. A slow command (`KEYS *`, `HGETALL` on a huge hash, `SMEMBERS` on a big set, big Lua scripts) blocks **every** client.
- In-memory, with optional persistence:
  - **RDB**: periodic snapshots. Fast restart, but you can lose minutes of data.
  - **AOF**: append-only log, `appendfsync everysec` loses at most about 1 s. AOF rewrite compacts the log.
  - Both together is common.
- **Replication** is async, so a failover can lose acknowledged writes. `WAIT numreplicas timeout` narrows the window but doesn't give you strong consistency.
- **Sentinel**: HA for a single primary (failover). **Cluster**: sharding across 16,384 hash slots. Multi-key operations need all keys in the same slot, which you force with **hash tags**: `{user:42}:cart`, `{user:42}:profile`.
- Licensing context: Redis moved to source-available licenses in 2024, and the Linux Foundation fork **Valkey** appeared (AWS ElastiCache and Memorystore offer Valkey). Redis 8 added AGPL as an option. Worth knowing if they ask.

---

## 2. Data structures → use cases

| Structure | Use cases |
|---|---|
| String | cache values, counters (`INCR`), locks (`SET NX PX`), idempotency keys |
| Hash | object fields (session, multi-step form state per question), partial updates `HSET` |
| List | simple queues (`LPUSH`/`BRPOP`), recent items (`LTRIM`) |
| Set | unique membership, tags, dedupe |
| Sorted Set | leaderboards, rate-limit sliding windows, delayed jobs (score = timestamp), time-ordered feeds |
| Stream | durable-ish log with consumer groups (`XADD`, `XREADGROUP`, `XACK`, `XAUTOCLAIM`) |
| HyperLogLog | approximate unique counts (12 KB per counter) |
| Bitmap | daily active flags per user ID |
| Pub/Sub | fire-and-forget broadcast (no persistence, offline subscribers miss messages) |
| Geo | nearby search |

**Pub/Sub vs Streams**: Pub/Sub has *at-most-once* delivery with no history. Streams keep history, support consumer groups, track pending entries, and allow *at-least-once* processing.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`boardKey`](../../packages/backend/libs/domains/seller-insights/infra/leaderboard-keys.ts#L6): boardKey is a Redis sorted set holding a period's seller leaderboard scores. _(leaderboard-keys.ts)_
> - [`geoKey`](../../packages/backend/libs/domains/fulfilment/infra/courier-keys.ts#L7): geoKey is a Redis GEO set indexing available couriers by city. _(courier-keys.ts)_
> - [`RealtimePublisher`](../../packages/backend/libs/infrastructure/realtime/realtime-publisher.service.ts#L13): RealtimePublisher publishes realtime messages to Redis with a replay buffer. _(realtime-publisher.service.ts)_
<!-- theory-links:end -->

---

## 3. Caching patterns

| Pattern | Read | Write | Notes |
|---|---|---|---|
| **Cache-aside** (lazy loading) | app checks cache → miss → read DB → populate | write DB → **invalidate** (delete) cache key | most common; app owns logic |
| **Read-through** | cache library loads from DB on miss | — | same as cache-aside but abstracted |
| **Write-through** | — | write cache **and** DB synchronously | cache always warm; slower writes |
| **Write-behind (write-back)** | — | write cache, **asynchronously** flush to DB later (batched) | huge write reduction; **risk of data loss** if cache dies before flush |
| **Refresh-ahead** | refresh hot keys before expiry | — | avoids miss latency spikes |

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`CacheService`](../../packages/backend/libs/infrastructure/cache/cache.service.ts#L48): CacheService is a multi-level cache (L1 in-process LRU plus L2 Redis) with getOrLoad-style cache-aside reads. _(cache.service.ts)_
> - [`WriteBehindCounter`](../../packages/backend/libs/infrastructure/cache/write-behind-counter.ts#L18): WriteBehindCounter batches hot increments in Redis and drains them periodically to the database. _(write-behind-counter.ts)_
> - [`ProductCacheInvalidator`](../../packages/backend/libs/domains/catalog/infra/product-cache-invalidator.projector.ts#L14): ProductCacheInvalidator consumes Kafka product events to invalidate product cache keys. _(product-cache-invalidator.projector.ts)_
<!-- theory-links:end -->

### Why "delete on write" instead of "update on write"
Two concurrent writers updating the cache can interleave and leave **stale data in the cache indefinitely**. With delete, the next read repopulates from the source of truth. A race remains (reader loads old value → writer updates DB → writer deletes → reader sets old value). Mitigate with short TTLs, versioned values, or **delayed double delete**.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`ProductCacheInvalidator`](../../packages/backend/libs/domains/catalog/infra/product-cache-invalidator.projector.ts#L14): Product cache entries are invalidated by event rather than updated in place. _(product-cache-invalidator.projector.ts)_
> - [`shouldRecomputeEarly`](../../packages/backend/libs/infrastructure/cache/xfetch.ts#L9): shouldRecomputeEarly probabilistically refreshes values before TTL expiry to soften the stale-read race. _(xfetch.ts)_
<!-- theory-links:end -->

### Example: staging multi-step form state in Redis (write-behind)
- Scenario: a long multi-step form or questionnaire. Writing every answer to Postgres makes the database the bottleneck.
- Intermediate answers go to a Redis hash per session (`HSET form:{sessionId} q17 "B"`) with a TTL (e.g. 24–72 h, refreshed on activity).
- On completion: read the hash, validate, **one bulk INSERT in a transaction**, then delete the key.
- Questions to expect about this design, and good answers:
  - *What if Redis loses data?* Intermediate state is **recoverable or low-value**: the worst case is the user re-answers some questions. The final submission is always durable in Postgres. AOF `everysec` + replica limits the loss. If partial progress had real business value, you'd periodically checkpoint to the DB (for example every N answers).
  - *Double submit / retries?* Idempotency on the final submission (unique constraint on `session_id` in the results table, or an idempotency key).
  - *Memory sizing?* Average state size × concurrent sessions, TTLs, and `maxmemory-policy volatile-lru` (only evicts keys that have a TTL; better still to size memory so eviction never happens, and alert on `evicted_keys > 0`).
  - *Analytics on drop-off?* Use separate event tracking. Don't count on Redis state for it.
  - *Why not just write to Postgres?* Every answer was a write (plus index updates and WAL). With N questions × users, the write load dominated, and nothing read the intermediate state relationally.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`OnboardingSessionService`](../../packages/backend/libs/domains/seller-onboarding/application/onboarding-session.service.ts#L20): OnboardingSessionService keeps questionnaire drafts and handles the final submission workflow. _(onboarding-session.service.ts)_
> - [`WriteBehindCounter`](../../packages/backend/libs/infrastructure/cache/write-behind-counter.ts#L18): WriteBehindCounter stages hot writes in Redis and drains them to Postgres in batches. _(write-behind-counter.ts)_
<!-- theory-links:end -->

---

## 4. Cache failure modes and fixes

### Cache stampede (dogpile / thundering herd)
A hot key expires and 1,000 concurrent requests all miss and hit the DB at once.
- **Single-flight / mutex**: the first request takes a short lock (`SET lock:key NX PX 5000`) and recomputes. Others wait briefly and re-read, or serve stale data.
- **Stale-while-revalidate**: store `{value, softExpiry}` with a longer hard TTL. After the soft expiry, serve the stale value and refresh in the background.
- **Probabilistic early expiration** (XFetch): each request recomputes early with a probability that rises as expiry nears.
- In-process **promise coalescing**: concurrent misses inside one Node process share one promise.
  ```ts
  const inflight = new Map<string, Promise<unknown>>();
  async function getOrLoad<T>(key: string, load: () => Promise<T>, ttl = 60): Promise<T> {
    const cached = await redis.get(key);
    if (cached) return JSON.parse(cached);
    if (inflight.has(key)) return inflight.get(key) as Promise<T>;
    const p = (async () => {
      try { const v = await load(); await redis.set(key, JSON.stringify(v), 'EX', ttl + Math.floor(Math.random() * 10)); return v; }
      finally { inflight.delete(key); }
    })();
    inflight.set(key, p);
    return p;
  }
  ```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`SingleFlight`](../../packages/backend/libs/infrastructure/cache/single-flight.ts#L6): SingleFlight runs the loader once per key for concurrent requests. _(single-flight.ts)_
> - [`shouldRecomputeEarly`](../../packages/backend/libs/infrastructure/cache/xfetch.ts#L9): shouldRecomputeEarly refreshes a hot value before it expires. _(xfetch.ts)_
> - [`GetOrLoadOptions`](../../packages/backend/libs/infrastructure/cache/cache.service.ts#L26): GetOrLoadOptions configures the stale-while-revalidate window and TTL. _(cache.service.ts)_
<!-- theory-links:end -->

### Cache avalanche
Many keys expire at the same moment (all set at deploy time with TTL 3600). **Add jitter to TTLs.**

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`jitterTtl`](../../packages/backend/libs/infrastructure/cache/xfetch.ts#L21): jitterTtl adds relative jitter to TTLs so keys do not expire together. _(xfetch.ts)_
<!-- theory-links:end -->

### Cache penetration
Requests for keys that don't exist (often malicious, e.g. random IDs) always miss and always hit the DB. Fixes: **cache negative results** (a short TTL "null" marker), a Bloom filter, input validation, and rate limiting.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [Look up a code through Bloom filter, cache and DynamoDB](../../docs/humans/concepts/domain-marketing/resolve-pipeline.md): resolve checks a code's format, a Bloom filter, the cache and then DynamoDB, and returns nothing for unknown codes. [`resolve`](../../packages/backend/libs/domains/marketing/application/share-link.service.ts#L41), [`RedisBloomFilter`](../../packages/backend/libs/domains/marketing/application/share-link.service.ts#L9)
> - [Bloom filter that rejects codes that never existed](../../docs/humans/concepts/domain-marketing/bloom-filter-gate.md): A Redis-backed Bloom filter rejects short codes that never existed before they reach the cache or DynamoDB. [`share-link.service.ts`](../../packages/backend/libs/domains/marketing/application/share-link.service.ts), [`share-link.service.ts`](../../packages/backend/libs/domains/marketing/application/share-link.service.ts)
> - [Cache lookup that also remembers missing links](../../docs/humans/concepts/domain-marketing/cache-with-negative-caching.md): getOrLoad briefly caches a not-found result for a code, which is negative caching. [`resolve`](../../packages/backend/libs/domains/marketing/application/share-link.service.ts#L41), [`linkCacheKey`](../../packages/backend/libs/domains/marketing/application/share-link.service.ts#L35)
<!-- theory-links:end -->

### Hot keys
One key gets enormous QPS and one shard (or one CPU) saturates. Fixes: an in-process L1 cache with a short TTL, key replication (`key:{0..N}` and read a random copy), and client-side caching (Redis 6 tracking).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`HotKeyDetector`](../../packages/backend/libs/infrastructure/cache/hot-key-detector.ts#L7): HotKeyDetector samples access and promotes frequently read keys to the in-process L1 cache. _(hot-key-detector.ts)_
> - [`QUEUE_SHARDS`](../../packages/backend/libs/domains/launch-events/application/waiting-room.service.ts#L9): QUEUE_SHARDS splits a waiting-room queue into sub-queues to avoid a single hot Redis key. _(waiting-room.service.ts)_
<!-- theory-links:end -->

### Big keys
A 50 MB value or a hash with millions of fields blocks Redis on read or delete. Use `UNLINK` (asynchronous delete), split the data, and find offenders with `redis-cli --bigkeys` / `MEMORY USAGE`.

---

## 5. Eviction policies (`maxmemory-policy`)

- `noeviction` (the default): writes fail when memory is full. Right when Redis is a **datastore or queue** (BullMQ requires it).
- `allkeys-lru` / `allkeys-lfu`: a pure cache. LFU is better when access frequency is skewed.
- `volatile-lru` / `volatile-lfu` / `volatile-ttl`: evict only keys that have a TTL. Use it for mixed workloads.
- **Don't mix the queue and the cache on one instance with an `allkeys-*` policy**, or your job data can get evicted.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`InMemoryTokenBucket`](../../packages/backend/libs/infrastructure/rate-limit/in-memory-token-bucket.ts#L7): InMemoryTokenBucket uses LRU-like eviction, an in-process eviction analogue (not Redis maxmemory-policy). _(in-memory-token-bucket.ts)_
<!-- theory-links:end -->

---

## 6. Distributed locks

```ts
// acquire
const token = randomUUID();
const ok = await redis.set(`lock:${resource}`, token, 'PX', 30_000, 'NX');
// release — only if we still own it (atomic via Lua)
const RELEASE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
await redis.eval(RELEASE, 1, `lock:${resource}`, token);
```

Limitations, which a senior answer should mention:
- A **GC pause or network delay** can outlast the TTL, so two holders end up thinking they own the lock.
- **Redlock** (majority across N independent Redis nodes) is debated. Kleppmann's critique: it relies on timing assumptions.
- For correctness (not just efficiency), use **fencing tokens**: a monotonically increasing number issued with the lock, which the protected resource checks (`UPDATE ... WHERE fence < $token`).
- Often the better tool is a **database lock** (`SELECT ... FOR UPDATE`, advisory locks) or a unique constraint, when the resource lives in the DB anyway.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`offerLockKey`](../../packages/backend/libs/domains/fulfilment/infra/courier-keys.ts#L9): offerLockKey is the Redis key for an atomic offer lock per courier per city. _(courier-keys.ts)_
> - [`SeatHoldService`](../../packages/backend/libs/domains/launch-events/application/seat-hold.service.ts#L44): SeatHoldService manages seat holds, confirms and releases with multi-layer consistency. _(seat-hold.service.ts)_
> - [redis](../../docs/humans/concepts/platform-redis/redis.md): The redis platform module acquires and renews distributed leases to split periodic work across instances.
<!-- theory-links:end -->

---

## 7. Rate limiting in Redis

```lua
-- Token bucket (atomic Lua). KEYS[1]=bucket, ARGV: capacity, refill_per_sec, now_ms, cost
local b = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(b[1]) or tonumber(ARGV[1])
local ts = tonumber(b[2]) or tonumber(ARGV[3])
local elapsed = math.max(0, tonumber(ARGV[3]) - ts) / 1000
tokens = math.min(tonumber(ARGV[1]), tokens + elapsed * tonumber(ARGV[2]))
local allowed = tokens >= tonumber(ARGV[4])
if allowed then tokens = tokens - tonumber(ARGV[4]) end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', ARGV[3])
redis.call('PEXPIRE', KEYS[1], math.ceil(tonumber(ARGV[1]) / tonumber(ARGV[2]) * 1000))
return allowed and 1 or 0
```
Other algorithms: fixed window (`INCR` + `EXPIRE`, which allows bursts at window edges), sliding log (a ZSET of timestamps, exact but memory-heavy), sliding window counter (weighted average of two windows, a good compromise). See the API doc for details.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`RateLimiterService`](../../packages/backend/libs/infrastructure/rate-limit/rate-limiter.service.ts#L15): RateLimiterService enforces distributed rate limits with Redis, local caching and fallback. _(rate-limiter.service.ts)_
> - [`TOKEN_BUCKET`](../../packages/backend/libs/infrastructure/rate-limit/lua.ts#L13): TOKEN_BUCKET is the Lua script for the token bucket algorithm. _(lua.ts)_
> - [`SLIDING_WINDOW`](../../packages/backend/libs/infrastructure/rate-limit/lua.ts#L49): SLIDING_WINDOW is the Lua script for the sliding window counter with a weighted estimate. _(lua.ts)_
<!-- theory-links:end -->

---

## 8. Operational and Node-specific notes

- Clients: `ioredis` (cluster and sentinel support, mature) or `node-redis` v4+. Use **pipelining** (`redis.pipeline()`) to batch round trips; `MULTI/EXEC` gives atomicity without rollback.
- **Lua scripts / Functions** for atomic read-modify-write.
- `SCAN` instead of `KEYS`. Never use `KEYS` in production.
- Set **timeouts** and **retry strategies**. Decide what happens when Redis is down: for a cache, **fail open** (go to the DB, with care so the DB doesn't overload); for a rate limiter, choose fail open or closed deliberately; for a session store, it's a hard dependency.
- Monitoring: `used_memory`, `evicted_keys`, `keyspace_hits/misses` (hit ratio), `connected_clients`, `instantaneous_ops_per_sec`, slowlog, replication lag.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`RedisService`](../../packages/backend/libs/infrastructure/redis/redis.service.ts#L16): RedisService provides the shared Redis client with auto-pipelining enabled. _(redis.service.ts)_ · [redis](../../docs/humans/concepts/platform-redis/redis.md)
> - [Redis balance projection from ledger events](../../docs/humans/concepts/domain-payments/balance-projection.md): BalanceProjector uses a Lua script for an atomic read-modify-write on a Redis hash. [`BalanceProjector`](../../packages/backend/libs/domains/payments/infra/balance.projector.ts#L26)
<!-- theory-links:end -->

---

## 9. Cache invalidation strategies, summarized

1. TTL only. Simple, and you accept bounded staleness.
2. Explicit delete on write (cache-aside).
3. Event-driven invalidation: publish a change event (outbox/CDC) that consumers use to invalidate. Works across services.
4. Versioned keys: `product:42:v17`. Bump the version in the DB, and old keys age out.
5. Tag-based invalidation (Next.js `revalidateTag`, or a set of keys per tag).

**Senior framing:** decide per data type *how stale is acceptable*. Financial balances: no cache, or read-through with validation. Product catalog: minutes. Static config: hours.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`ProductCacheInvalidator`](../../packages/backend/libs/domains/catalog/infra/product-cache-invalidator.projector.ts#L14): ProductCacheInvalidator does event-driven invalidation from Kafka product events. _(product-cache-invalidator.projector.ts)_
> - [`productCacheKey`](../../packages/backend/libs/domains/catalog/infra/product-cache.ts#L2): productCacheKey builds versioned keys in the form product:v1:{id}. _(product-cache.ts)_
> - [`CloudflarePurger`](../../packages/backend/libs/domains/content/infra/cache-invalidation.ts#L14): CloudflarePurger invalidates CDN cache by tag, in batches of 30 tags. _(cache-invalidation.ts)_
<!-- theory-links:end -->

---

## Interview Q&A

**Q: How do you keep cache and DB consistent?**
Postgres is the source of truth. Use cache-aside with delete-on-write plus TTL as a safety net. For cross-service setups, invalidate from change events (outbox/CDC) so the invalidation itself is reliable. For data that needs stronger consistency, use versioned keys or skip caching it. There's always a staleness window, and the point is to make it explicit and bounded.

**Q: A hot key expires and the DB falls over. How do you prevent it?**
Single-flight recompute (a lock or in-process promise coalescing), stale-while-revalidate, TTL jitter, and probabilistic early refresh.

**Q: Is a Redis lock safe?**
For efficiency (avoiding duplicate work), yes, with token-checked release. For correctness, no on its own: pauses and failovers can produce two holders. Use fencing tokens, or let the database enforce it with constraints or row locks.
