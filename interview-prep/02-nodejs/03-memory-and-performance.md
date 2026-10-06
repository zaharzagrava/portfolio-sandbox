# Node.js Memory, GC, and Performance Profiling

---

## 1. V8 memory layout

```
process RSS
├── V8 heap
│   ├── New space (young generation, "nursery"): small (~16–64MB), Scavenger GC (fast, frequent, copying)
│   ├── Old space: objects that survived 2 scavenges. Mark-Sweep-Compact (slower, mostly concurrent/incremental)
│   ├── Large object space: objects > ~1MB, never moved
│   └── Code space, map space
├── External memory: Buffers / ArrayBuffers (process.memoryUsage().arrayBuffers)
├── Native: libuv, OpenSSL, native addons, thread stacks
```

- **Generational hypothesis**: most objects die young, so collecting the young generation is cheap.
- **Orinoco** (V8's GC) does parallel scavenges and concurrent marking, which shortens stop-the-world pauses without eliminating them. A heap close to its limit triggers repeated full GCs: CPU goes to 100% while throughput collapses (a "GC death spiral").

### Heap limit in containers
- The default old-space limit depends on available memory. Recent Node versions take the **cgroup memory limit** into account, but be explicit:
  `NODE_OPTIONS=--max-old-space-size=1536` for a 2 GiB container limit (about 75%, leaving room for buffers, native memory, and stacks).
- If the heap limit is **higher** than the container limit, the kernel **OOMKills** (exit code 137) before V8 can throw a clean `FATAL ERROR: heap out of memory`.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`FunctionSandbox`](../../packages/backend/libs/domains/shop-functions/infra/sandbox.ts#L26): FunctionSandbox enforces explicit memory caps and timeouts on isolated V8 sandboxes for seller code, similar to setting explicit heap limits. _(sandbox.ts)_
<!-- theory-links:end -->

---

## 2. Memory leaks: common causes in Node services

| Leak | Example | Fix |
|---|---|---|
| Unbounded in-memory cache | `const cache = {}` keyed by userId | LRU with max size + TTL (`lru-cache`), or Redis |
| Listeners added per request | `emitter.on('x', ...)` inside handler | `once`, remove listener, AbortSignal |
| Timers never cleared | `setInterval` per connection | clear in `close` handlers |
| Closures retaining big scopes | see JS internals doc | null out references, restructure |
| Promises that never settle | awaiting a response that never comes | timeouts everywhere |
| Global arrays for "metrics"/"debug" | `requests.push(req)` | remove |
| Unbounded queues in memory | producer faster than consumer | backpressure, bounded queue |
| High-cardinality metrics labels | `labels: { userId }` in prom-client | bounded labels |
| Buffer slices retaining parents | `bigBuf.subarray(0, 10)` stored | `Buffer.from(slice)` copy |

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`InMemoryTokenBucket`](../../packages/backend/libs/infrastructure/rate-limit/in-memory-token-bucket.ts#L7): InMemoryTokenBucket bounds its in-memory state with LRU-like eviction and a configurable capacity, avoiding an unbounded cache leak. _(in-memory-token-bucket.ts)_
> - [`SingleFlight`](../../packages/backend/libs/infrastructure/cache/single-flight.ts#L6): SingleFlight keeps a per-key map of in-flight calls that is cleaned up once each call finishes, so concurrent requests are deduplicated without growing memory. _(single-flight.ts)_
<!-- theory-links:end -->

---

## 3. Finding a leak: a method you can describe step by step

1. **Confirm it's a leak**: memory grows across GCs and doesn't drop back after load stops. Graph `heapUsed` against `rss` against `external`.
   - `heapUsed` growing: JS object leak.
   - `rss` growing while heap stays flat: native or buffer leak, or allocator fragmentation (try `jemalloc`, or check glibc arena settings with `MALLOC_ARENA_MAX`).
2. **Reproduce** under load locally or in staging (k6 / autocannon).
3. **Three-snapshot technique**: take a heap snapshot after warmup, run load, take snapshot 2, run the same load again, take snapshot 3. In Chrome DevTools, use the "Objects allocated between snapshot 1 and 2" view in snapshot 3. Objects that keep accumulating are the leak.
4. Look at **retainers**, the chain from a GC root to the object. It usually points to a Map, an emitter, or a closure.
5. In production: `--heapsnapshot-near-heap-limit=2` writes snapshots automatically before an OOM. `kill -USR2` with `--heapsnapshot-signal=SIGUSR2` takes one on demand. Snapshots **pause the process** and can be as large as the heap, so take them on a pod that's out of rotation.

---

## 4. CPU profiling

- `node --cpu-prof app.js` writes a `.cpuprofile`. Open it in DevTools or speedscope.
- `node --inspect` and attach Chrome DevTools, or in production use continuous profiling (Pyroscope, Datadog, Grafana). eBPF-based tools (e.g. Groundcover, Pixie) can profile without instrumentation.
- **Flame graph reading**: width = time on CPU, top = leaf functions. Look for wide plateaus: JSON serialization, regex, crypto, ORM hydration.
- `0x` and `clinic flame` produce flame graphs. `clinic doctor` helps classify the problem (I/O, event loop, or GC).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [load-shedding](../../docs/humans/concepts/common-load-shedding/load-shedding.md): The load-shedding module monitors Node.js event-loop delay and exposes a p99 metric, which helps spot CPU-bound hot spots.
<!-- theory-links:end -->

### Common CPU hot spots in Node APIs
- **ORM model hydration**: Sequelize or TypeORM turning thousands of rows into class instances. Use `raw: true` or a query builder for read-heavy endpoints.
- **JSON serialization** of large responses. Fastify uses `fast-json-stringify` with schemas, often 2–3× faster.
- **Validation** of huge payloads with class-validator (reflection-heavy). zod/ajv are faster, and ajv compiles schemas.
- Logging too much synchronously. Use pino (async, worker-thread transport) and don't log whole objects.
- `bcrypt` on the main thread. Use the async version (thread pool) and tune the cost factor.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`TopKTrie`](../../packages/backend/libs/domains/discovery/domain/top-k-trie.ts#L22): TopKTrie precomputes top-K completions per node so autocomplete lookups avoid CPU work at request time. _(top-k-trie.ts)_
<!-- theory-links:end -->

---

## 5. V8 optimization basics (useful context, not micro-tuning)

- **Hidden classes (Maps/shapes)**: objects with the same property order share a shape. Adding or deleting properties dynamically (`delete obj.x`) or initializing in a different order produces **polymorphic** call sites.
- **Inline caches**: a call site that sees 1 shape is monomorphic (fast), 2–4 is polymorphic, and more than 4 is megamorphic (slow).
- **Deoptimizations**: TurboFan bails out when its assumptions break (types change). `--trace-deopt` shows them.
- Practical takeaway: initialize every field in the constructor, use consistent object shapes, and don't use `delete` on hot objects (set the field to `undefined` instead).

---

## 6. Throughput levers for a Node API (in order of impact)

1. **Fix the database**: indexes, fewer queries, no N+1, connection pool sizing. This is usually 80% of the win.
2. **Cache**: Redis or in-process LRU for hot, read-mostly data; HTTP caching and CDN for public content.
3. **Avoid unnecessary work**: pagination, field selection, `raw` queries, compress responses at the proxy (nginx or ingress) instead of in Node.
4. **Connection reuse**: keep-alive agents for outbound HTTP, pool reuse.
5. **Offload**: CPU work to workers, heavy jobs to queues.
6. **Horizontal scaling**: more pods, sized for CPU (≈1 core per Node process).
7. Framework choice (Fastify vs Express) is a small win compared with the items above.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`SingleFlight`](../../packages/backend/libs/infrastructure/cache/single-flight.ts#L6): SingleFlight collapses concurrent requests for the same key into one execution, which avoids unnecessary work on hot data. _(single-flight.ts)_
> - [Cache lookup that also remembers missing links](../../docs/humans/concepts/domain-marketing/cache-with-negative-caching.md): getOrLoad caches links for an hour, serves stale copies while refreshing, and briefly caches misses. [`resolve`](../../packages/backend/libs/domains/marketing/application/share-link.service.ts#L41), [`linkCacheKey`](../../packages/backend/libs/domains/marketing/application/share-link.service.ts#L35)
> - [Bloom filter that rejects codes that never existed](../../docs/humans/concepts/domain-marketing/bloom-filter-gate.md): A Redis Bloom filter rejects lookups for codes that never existed, so they stop before the cache and DynamoDB. [`share-link.service.ts`](../../packages/backend/libs/domains/marketing/application/share-link.service.ts), [`share-link.service.ts`](../../packages/backend/libs/domains/marketing/application/share-link.service.ts)
<!-- theory-links:end -->

---

## 7. Load testing

- Tools: **k6** (JS scripts, thresholds), autocannon (quick HTTP benchmarks), Artillery.
- Test with a realistic data volume (index behavior changes with table size), realistic concurrency, and **open-model** load (arrival rate) rather than only closed-model loops, which hide latency problems (coordinated omission).
- Put thresholds in terms of SLOs: `http_req_duration: ['p(95)<300']`, `http_req_failed: ['rate<0.001']`.

```js
// k6
export const options = {
  scenarios: { steady: { executor: 'constant-arrival-rate', rate: 200, timeUnit: '1s', duration: '5m', preAllocatedVUs: 100 } },
  thresholds: { http_req_duration: ['p(95)<300', 'p(99)<800'], http_req_failed: ['rate<0.001'] },
};
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`options`](../../packages/backend/scripts/load-tests/product-detail.test.js#L39): The product-detail k6 options use a constant-arrival-rate (open-model) executor with p99 latency and error-rate thresholds. _(product-detail.test.js)_
> - [`k6Thresholds`](../../packages/backend/libs/common/telemetry/slo-rules.ts#L80): k6Thresholds derives k6 thresholds from the SLO definitions, so load tests use SLO-based limits. _(slo-rules.ts)_ · [telemetry](../../docs/humans/concepts/common-telemetry/telemetry.md)
> - [`options`](../../packages/backend/scripts/load-tests/auction.test.js#L17): The auction k6 test runs a constant-arrival-rate of 2k bids per second with a p99 latency threshold of 50ms. _(auction.test.js)_
<!-- theory-links:end -->

---

## Interview Q&A

**Q: A pod restarts every few hours with exit code 137. What's going on?**
137 = SIGKILL, usually the kernel OOMKiller. Either a real leak or a heap limit above the container limit. I check memory graphs (heap vs RSS vs external), set `--max-old-space-size` to about 75% of the limit, then hunt for the leak with heap snapshots: three-snapshot diff, then follow retainers.

**Q: How do you find which code is slow in production?**
Distributed traces to find the slow span (DB vs downstream vs in-process). For in-process CPU, continuous profiling or a `--cpu-prof` capture to get a flame graph. Then `pg_stat_statements` / `EXPLAIN ANALYZE` if the time goes to the DB.

**Q: The heap is stable but RSS keeps growing. Why?**
Off-heap memory: Buffers (`arrayBuffers`), native addons, or malloc fragmentation. Check `process.memoryUsage().external`, retained buffer slices, and stream backpressure. Try jemalloc or `MALLOC_ARENA_MAX=2`.
