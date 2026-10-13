# RedisMemoryHigh

**Severity:** page · **Owner:** platform · **Dashboards:** *Flash sales & checkout* → Redis memory

## What it means
Redis is > 85% of maxmemory. Next comes eviction (cache: OK; stock, locks, rate limits, streams: NOT OK) or OOM write errors.

## Triage (≤ 5 min)
1. What grew? `redis-cli --bigkeys` (replica!), `MEMORY USAGE <key>`, `INFO keyspace`.
2. Usual suspects: Redis Streams without trimming (realtime topics, assistant generations), keys without TTL from a new feature, a stampede filling caches.
3. Eviction policy of the cluster: stock/locks clusters must be `noeviction`.

## Mitigate
- **Unbounded stream:** `XTRIM <key> MAXLEN ~ 10000`; ship the missing MAXLEN.
- **Keys without TTL:** delete by pattern with `SCAN` + `UNLINK` (never `KEYS` in prod).
- **Legitimate growth:** scale the node type / add shards (ElastiCache online resharding).
- Cache-only data can be flushed (`UNLINK` the cache prefix); the app falls back to the DB (expect a latency bump).

## Verify
Memory < 70% for 30 min, `evicted_keys` not increasing.
