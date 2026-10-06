# Node.js Runtime: Event Loop, libuv, Threads

---

## 1. Architecture in one picture

```
 Your JS code
     │
 ┌───▼──────────────┐     ┌───────────────────────────────────┐
 │ V8 (JS engine)   │     │ Node bindings (C++)               │
 │ call stack, heap │◄───►│ fs, net, crypto, zlib, http ...   │
 └──────────────────┘     └───────────────┬───────────────────┘
                                          │
                          ┌───────────────▼───────────────────┐
                          │ libuv                             │
                          │  - event loop                     │
                          │  - OS async I/O (epoll/kqueue/IOCP)│ ← network sockets
                          │  - thread pool (default 4)        │ ← fs, dns.lookup, crypto, zlib
                          └───────────────────────────────────┘
```

Two points people often get wrong:
1. **Network I/O does not use the thread pool.** It goes through the OS's non-blocking multiplexing (epoll on Linux).
2. **The thread pool** (`UV_THREADPOOL_SIZE`, default 4, max 1024) handles: **all `fs` operations**, **`dns.lookup`** (because `getaddrinfo` is blocking), **async `crypto`** (`pbkdf2`, `scrypt`, `randomBytes`, `generateKeyPair`), and **`zlib`** async compression.

**Real-world failure mode:** 4 slow `bcrypt`/`scrypt` hashes, or slow DNS lookups, fill all 4 threads. Then `fs.readFile`, and even **outbound HTTP connections that resolve hostnames through `dns.lookup`**, queue up behind them. Latency rises while CPU looks idle. Fixes: raise `UV_THREADPOOL_SIZE` (set it before the pool is first used, ideally through an env var), cache DNS (`cacheable-lookup`), or use `dns.resolve*`, which goes over the network through c-ares and skips the pool.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`PasswordHasher`](../../packages/backend/libs/domains/identity/infra/crypto/password-hasher.ts#L13): PasswordHasher does password hashing (argon2), which runs on the libuv thread pool, so it ties into thread-pool sizing. _(password-hasher.ts)_
<!-- theory-links:end -->

---

## 2. Event loop phases (libuv)

```
   ┌───────────────────────────┐
┌─►│           timers          │  setTimeout / setInterval callbacks whose time has come
│  └─────────────┬─────────────┘
│  ┌─────────────▼─────────────┐
│  │     pending callbacks     │  some system-level callbacks deferred from last loop (e.g., TCP errors)
│  └─────────────┬─────────────┘
│  ┌─────────────▼─────────────┐
│  │       idle, prepare       │  internal
│  └─────────────┬─────────────┘
│  ┌─────────────▼─────────────┐
│  │           poll            │  retrieve new I/O events, run I/O callbacks; may BLOCK here waiting
│  └─────────────┬─────────────┘
│  ┌─────────────▼─────────────┐
│  │           check           │  setImmediate callbacks
│  └─────────────┬─────────────┘
│  ┌─────────────▼─────────────┐
└──┤      close callbacks      │  socket.on('close'), etc.
   └───────────────────────────┘
```

**Between every callback** (since Node 11): first the `process.nextTick` queue is drained, then the **Promise microtask queue**.

### Ordering facts interviewers test
```js
// In the main module: ORDER IS NON-DETERMINISTIC (depends on process perf / 1ms timer granularity)
setTimeout(() => console.log('timeout'), 0);
setImmediate(() => console.log('immediate'));

// Inside an I/O callback: immediate ALWAYS first (poll → check → ... → timers)
fs.readFile(__filename, () => {
  setTimeout(() => console.log('timeout'), 0);
  setImmediate(() => console.log('immediate'));
});
```

- `process.nextTick` runs **before** promise microtasks and can starve the loop if it schedules itself recursively. Use it to defer an emit until after the constructor has returned (the classic EventEmitter pattern). Otherwise prefer `queueMicrotask`.
- `setImmediate` is the safe way to **yield** to I/O inside a long CPU loop.

---

## 3. Blocking the event loop

Anything synchronous and CPU-heavy blocks **every** request on that process:
- `JSON.parse`/`JSON.stringify` of multi-MB payloads.
- Catastrophic regex backtracking (**ReDoS**), e.g. `/(a+)+$/`. Use `re2` or keep patterns linear.
- `crypto.*Sync`, `fs.*Sync` in request paths, `zlib.*Sync`.
- Big array sorts and reductions, PDF or Excel generation, image manipulation.
- Huge synchronous loops in your own business logic (for example, financial model calculations).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`LoadSheddingMiddleware`](../../packages/backend/libs/common/load-shedding/load-shedding.middleware.ts#L15): LoadSheddingMiddleware rejects requests with 503 when event-loop lag from blocking work exceeds the threshold. _(load-shedding.middleware.ts)_ · [load-shedding](../../docs/humans/concepts/common-load-shedding/load-shedding.md)
<!-- theory-links:end -->

### Detecting it
```ts
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

const h = monitorEventLoopDelay({ resolution: 20 });
h.enable();
setInterval(() => {
  const elu = performance.eventLoopUtilization();   // 0..1, fraction of time loop was busy
  metrics.gauge('event_loop_delay_p99_ms', h.percentile(99) / 1e6);
  metrics.gauge('event_loop_utilization', elu.utilization);
  h.reset();
}, 10_000);
```

- **Event-loop delay p99 > ~100–200 ms** means user-visible latency. **ELU near 1.0** means the process is CPU-saturated, so scale out or offload work.
- ELU is a better autoscaling signal than raw CPU for Node, because CPU% can't tell useful work apart from GC.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`EventLoopMonitor`](../../packages/backend/libs/common/load-shedding/event-loop-monitor.service.ts#L12): EventLoopMonitor measures event-loop delay and publishes the p99 metric. _(event-loop-monitor.service.ts)_ · [load-shedding](../../docs/humans/concepts/common-load-shedding/load-shedding.md)
> - [load-shedding](../../docs/humans/concepts/common-load-shedding/load-shedding.md): The load-shedding module explains how the event-loop delay p99 is monitored and used for decisions.
<!-- theory-links:end -->

### Fixes, from cheapest to heaviest
1. Use streaming or incremental parsing instead of loading everything into memory.
2. Chunk the work and yield with `setImmediate` between chunks (partitioning).
3. **Worker threads** (a pool such as `piscina`) for CPU-bound work.
4. Move the work to a separate service or queue consumer (async job).

---

## 4. Concurrency primitives: worker_threads vs cluster vs child_process

| | `worker_threads` | `cluster` | `child_process` |
|---|---|---|---|
| Unit | thread in same process | forked processes | any process |
| Memory | separate V8 isolate/heap, **can share memory** (`SharedArrayBuffer`) | separate | separate |
| Communication | `postMessage` (structured clone), **transfer** `ArrayBuffer` zero-copy, `Atomics` | IPC | IPC / stdio |
| Use for | CPU-bound tasks (hashing, parsing, image work) | scaling an HTTP server across cores | running other binaries (ffmpeg), isolation |
| In Kubernetes | yes | **usually no**: run 1 process per pod and let K8s scale replicas | rarely |

**Interview point:** in containers, prefer **one Node process per pod** with a CPU request of about 1 core, and scale horizontally with replicas. `cluster` (or PM2) inside a pod hides per-process health from K8s and makes memory limits harder to reason about.

```ts
// piscina pool example
import Piscina from 'piscina';
const pool = new Piscina({ filename: new URL('./worker.js', import.meta.url).href, maxThreads: 4 });
app.post('/report', async (req, res) => res.json(await pool.run(req.body)));
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`run`](../../packages/backend/libs/domains/media/infra/ffmpeg.ts#L8): The ffmpeg run function uses child_process spawn with a timeout and SIGKILL on abort or timeout. _(ffmpeg.ts)_
<!-- theory-links:end -->

---

## 5. AsyncLocalStorage: request context

Propagates context such as a request ID, user, tenant, or DB transaction through async calls without passing it as a parameter.

```ts
import { AsyncLocalStorage } from 'node:async_hooks';
export const als = new AsyncLocalStorage<{ requestId: string; userId?: string }>();

app.use((req, _res, next) => als.run({ requestId: req.headers['x-request-id'] ?? randomUUID() }, next));

// anywhere deeper:
logger.info({ ...als.getStore() }, 'charging card');
```

Used by: pino `mixin` for log correlation, OpenTelemetry context, `nestjs-cls`, Sequelize CLS transactions, and Prisma/TypeORM transactional decorators.
Pitfall: context gets lost with some callback-based libraries and custom thenables. Wrap them with `AsyncResource.bind`.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`AppClsStore`](../../packages/backend/libs/common/request-context/types.ts#L8): AppClsStore is the request-context store type (nestjs-cls) carrying identity and authorization data across async calls. _(types.ts)_ · [request-context](../../docs/humans/concepts/common-request-context/request-context.md)
> - [`enableSequelizeCls`](../../packages/backend/libs/infrastructure/context/sequelize-cls.ts#L36): enableSequelizeCls turns on CLS so Sequelize transactions propagate automatically through async calls. _(sequelize-cls.ts)_
> - [`REQUEST_ID_HEADER`](../../packages/backend/libs/common/request-context/types.ts#L18): REQUEST_ID_HEADER is the header name used to carry the request ID into the request context. _(types.ts)_ · [request-context](../../docs/humans/concepts/common-request-context/request-context.md)
<!-- theory-links:end -->

---

## 6. EventEmitter gotchas

- An `'error'` event with no listener **throws** and crashes the process.
- Listeners run **synchronously** in registration order. A slow listener blocks `emit`.
- `MaxListenersExceededWarning` (above 10 listeners) usually means a **leak**: you're adding listeners per request to a long-lived emitter.
- `events.once(emitter, 'event')` returns a promise, and `events.on` returns an async iterator. Both accept `AbortSignal`.

---

## 7. HTTP server internals worth knowing

- **Keep-alive**: Node's `server.keepAliveTimeout` defaults to 5 s. Behind an AWS ALB (idle timeout 60 s) you get random **502s** when Node closes a socket the LB is about to reuse. **Set `keepAliveTimeout` higher than the LB idle timeout**, for example 65 s, and `headersTimeout` higher than `keepAliveTimeout`.
- **Outbound requests**: reuse connections. The global `fetch` (undici) pools by default. With `http.Agent`, set `keepAlive: true` (the default since Node 19). Unpooled requests cost a TCP+TLS handshake every time and can exhaust ephemeral ports.
- `server.requestTimeout` (default 300 s since Node 18) protects against slowloris-style attacks.
- `server.close()` stops accepting new connections but **waits for keep-alive sockets**. Call `server.closeIdleConnections()` too (Node 18.2+). See the graceful shutdown doc.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`GracefulShutdownOptions`](../../packages/backend/libs/infrastructure/lifecycle/graceful-shutdown.ts#L7): GracefulShutdownOptions includes keepAliveTimeoutMs, which configures the server keep-alive timeout during shutdown. _(graceful-shutdown.ts)_ · [lifecycle](../../docs/humans/concepts/platform-lifecycle/lifecycle.md)
> - [`HttpRequestOptions`](../../packages/backend/libs/infrastructure/http-client/resilient-http-client.ts#L7): HttpRequestOptions configures timeout, retry and abort signal for the resilient outbound HTTP client. _(resilient-http-client.ts)_
<!-- theory-links:end -->

---

## 8. Modern Node features (current LTS is 24; 22 is in maintenance)

- Global `fetch`, `WebSocket` client, `AbortSignal.timeout/any`, `structuredClone`.
- `node --watch`, `node --env-file=.env`, built-in test runner `node:test` with mocking and coverage.
- Native TypeScript **type stripping** (erasable syntax only).
- `require(esm)` (when there's no top-level await).
- Permission model `--permission` (restrict fs, child_process, and workers).
- `node:sqlite` (experimental), `util.parseArgs`, `util.styleText`.
- Single executable applications (SEA).

---

## Interview Q&A

**Q: Node is single-threaded. How does it handle 10k concurrent connections?**
The *JavaScript* runs on one thread, but I/O is non-blocking. libuv registers sockets with epoll and the loop runs callbacks only when data is ready, so idle connections cost memory but no CPU. Blocking work (fs, dns.lookup, some crypto, zlib) goes to a thread pool. Node is a good fit for I/O-bound work and a poor fit for CPU-bound work in the request path.

**Q: Your API's p99 latency spiked while CPU sits at 30%. What do you check?**
(1) Event-loop delay: one long synchronous task blocks everything even when average CPU is low. (2) Thread-pool saturation: slow fs, DNS, or crypto. (3) Connection-pool waits to Postgres (pool too small, slow queries holding connections). (4) GC pauses (heap close to its limit). (5) Downstream latency. I'd confirm with traces and look at pool wait-time metrics.

**Q: `setImmediate` vs `process.nextTick` vs `setTimeout(fn, 0)`?**
`nextTick` runs right after the current operation, before promises, and can starve I/O. `setImmediate` runs in the check phase after poll and is the right way to yield to I/O. `setTimeout(0)` actually means ≥1 ms and runs in the timers phase. Its order relative to `setImmediate` is nondeterministic in the main module but deterministic inside I/O callbacks.

**Q: When do you use worker threads?**
For CPU-bound work that must happen in-process: hashing, heavy parsing, compression, report computation. I use a pool such as piscina and transfer buffers instead of copying. Async I/O doesn't need them.
