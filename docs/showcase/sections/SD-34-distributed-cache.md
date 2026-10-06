# SD-34 — Distributed Cache Toolkit (L1/L2, stampede, SWR, write-behind, hot keys)

Status: ☑ done (typechecked; spec + k6 written, not run) · Phase 0 · Depends on: F-01 · Used by: product pages, SD-08, 11, 19, 21, 38 · README showcases #21, #22, #23

## Marketplace adaptation
Product detail, seller profile, seat-map summaries and flag rulesets are read 1000× more than written. Building a Redis cluster from scratch isn't useful; building the **client-side caching layer** that makes Redis survive market traffic is — plus consistent hashing where we genuinely route by key ourselves (SD-16 room routing).

## Patterns showcased
| Pattern | Lesson |
|---|---|
| Cache-aside with **delete-on-write** (invalidation via CQRS events, F-05) | 03/04 §3 |
| **Two-level cache**: L1 in-process LRU (bounded by size, `lru-cache`) + L2 Redis; L1 invalidated through Redis pub/sub broadcast | 03/04, 10/09 #34, 02/03 (bounded memory) |
| **Stampede prevention**: single-flight per key in-process + Redis lock (`SET NX PX`) for cross-instance recompute, **probabilistic early expiration (XFetch)** | 03/04 §4 |
| **Stale-while-revalidate**: serve stale + background refresh; `Cache-Control: s-maxage, stale-while-revalidate` for Cloudflare | 03/04, README #23 |
| **Jittered TTLs** against avalanche | 03/04 §4 |
| **Negative caching** + **Bloom filter** against penetration (non-existent product IDs) | 03/04 §4 |
| **Hot-key detection** (sampled counter) → auto-promote to L1 with short TTL | 03/04 §4 |
| **Write-behind counters**: product view counts / likes `INCR` in Redis, flushed in bulk every N s via `GETDEL` pipeline into ClickHouse/Postgres | 03/04 §3, README #22 |
| Redis distributed lock caveats: fencing tokens for the lock-protected write | 03/04 §6 |
| HTTP caching: ETag / `If-None-Match` → 304 for product API | 04/01 §3 |

## Steps
- [x] `libs/common/src/cache/` — `CacheService.getOrLoad(key, loader, { ttl, swr, l1, negativeTtl })`, `SingleFlight`, `XFetch`, `L1Cache` + invalidation subscriber, `BloomFilter` (Redis `BF.*` if RedisBloom available, else bitset in Redis `SETBIT`), `HotKeyDetector`, `WriteBehindCounter`.
- [x] Apply to product read API (`GET /products/:id` — currently search only; add detail endpoint backed by Redis read model from F-05).
- [x] ETag interceptor.
- [x] Unit tests with fake Redis (`ioredis-mock`) + fake clock: single-flight coalescing, SWR serves stale once, XFetch probability, bloom false-negative never.

## Scale
- Target: product detail 100k RPS, p99 < 20 ms at origin (CDN absorbs most; origin sees misses + personalised calls).
- Hot path: L1 hit (~µs) → L2 Redis GET (~0.5 ms) → loader (read model, never primary DB on hit path).
- First bottleneck & fix: hot keys on a single Redis shard → L1 promotion; recompute storms → single-flight + XFetch.
- Capacity model: 90% L1 hit for top-1k products → Redis sees ~10k RPS of the 100k; 3-shard cluster with replicas for reads.
- Proof: k6 Zipf-distributed product IDs at 1/2/4 instances; thresholds p99 < 20 ms, loader invocations per key per TTL ≤ 1 (stampede metric).

## FE visualisation (phase 2)
—

## Implementation notes (2026-10-01)
- `libs/common/src/cache/`: `CacheService.getOrLoad` (L1 LRU for hot keys or always → L2 Redis envelope `{v, exp, hard, delta}` → loader; single-flight + Redis `SET NX PX` lock with waiting followers; XFetch early refresh; SWR; jittered TTL; negative caching; Redis-down degradation), `invalidate` (DEL + pub/sub → every instance's L1), `SingleFlight`, `xfetch.ts`, `HotKeyDetector` (sampled), `RedisBloomFilter` (bitmap, double hashing, sized from n/p — used by SD-08/SD-35), `WriteBehindCounter` (HINCRBY + atomic Lua drain + restore), `VersionEtagInterceptor`.
- Products: `GET /api/products/:id` (cache-aside, SWR 5 min, negative 10 s, ETag/304, rate-limited), migration `20261001120000-product-view-count`, write-behind views flushed every 10 s by job `products.flush-view-counts` (one `UPDATE ... FROM unnest()` per flush, restore on failure) in `apps/worker`; `ProductCacheInvalidator` projector (own consumer group) in `apps/projector`; product outbox rows now carry `aggregateId` (per-product Kafka ordering).
- Bloom filter not wired into product detail: negative caching covers penetration there; the Bloom filter is used where membership checks are the hot path (SD-08 short codes, SD-35 crawler).
- Consistent hashing is implemented with SD-16 (room routing), where we route keys to instances ourselves.
- Test cleanup: `RedisModule` registers `flushdb` with `TestCleanupRegistry`.
- Spec `cache/cache.e2e-spec.ts`; k6 `product-detail.test.js` (Zipf popularity; `pnpm loadtest:product-detail`; search seeder now also writes `data/catalog.json`).
