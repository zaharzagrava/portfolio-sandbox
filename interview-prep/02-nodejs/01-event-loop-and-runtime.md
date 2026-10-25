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

A **macrotask** is a callback run by one of these phases (timer, I/O callback, `setImmediate`, close). A **microtask** is a promise callback (`.then`/`.catch`/`.finally`, `queueMicrotask`, the code after an `await`).

### Order of execution: the full algorithm (pseudocode)

```js
// ===== 1. Sync code. Runs now, top to bottom. =====
// Includes a `new Promise` executor and an `async` function up to its first `await`.
runMainScript();

drain();   // first drain right after the script

// ===== 2 + 3. DRAIN: runs after the script and after EVERY single callback =====
function drain() {
  do {
    // ---- 2. nextTick queue. Node-only. Emptied first, after every piece of work. ----
    // `process.nextTick(fn)`. Ticks added while emptying also run now (can starve
    // everything if a tick keeps rescheduling itself).
    while (nextTickQueue.length) nextTickQueue.shift()();

    // ---- 3. Promise queue (microtasks). Emptied right after nextTick. ----
    // `.then` / `.catch` / `.finally`, `queueMicrotask`, code after `await`.
    // FIFO. Ones added while emptying also run now (same drain).
    // `await x` splits the function: the rest is a microtask, ordered with other `.then`s.
    // Awaiting a native promise = 1 hop; a non-native thenable = extra hops.
    while (promiseQueue.length) promiseQueue.shift()();

    // Ping-pong: a tick queued inside a promise callback waits until the WHOLE
    // promise queue is empty; a promise queued inside a tick waits until the whole
    // tick queue is empty. Repeat until both are empty.
  } while (nextTickQueue.length || promiseQueue.length);
}
// ES module start ONLY: the module body itself runs inside a promise job, so V8
// finishes the promise queue BEFORE Node runs ticks (`promise` → `nextTick`).
// CommonJS: `nextTick` → `promise`. After startup both behave the same.
// That's why puzzles say "CommonJS".

// ===== 4. Event loop phases, in a circle =====
// Since Node 11 drain() runs after every callback. Before: only after a whole phase.
while (somethingLeftToWaitFor()) {     // timers, open sockets/servers, I/O in progress, immediates
  const now = readClockOnce();          // whole ms, read once per turn

  // ---- timers: `setTimeout` / `setInterval` ----
  // `setTimeout(fn, 0)` = `setTimeout(fn, 1)`: Node turns any delay below 1 into 1 ms.
  // Runs only timers that are due (>= delay passed at `now`). Not due → wait for a later turn.
  // MAIN SCRIPT: `setTimeout(0)` vs `setImmediate` is a RACE. The first turn starts here:
  //   1 ms already passed → timeout first; not yet → skipped, immediate (check) first.
  //   Busy-waiting a few ms after scheduling makes the timeout always win.
  // A timer added inside a timer callback is not run in this phase → next turn.
  // A timer created from the initial microtasks can run in the same phase as earlier timers.
  for (const t of dueTimers(now)) { t.callback(); drain(); }

  // ---- pending: rare system callbacks deferred from last turn (e.g. TCP errors) ----
  for (const cb of pendingCallbacks) { cb(); drain(); }

  // ---- idle / prepare: internal ----

  // ---- poll: I/O callbacks like `readFile`, sockets, HTTP ----
  // Nothing else queued (no immediates)? BLOCK here waiting for I/O,
  // but only until the nearest timer is due. That's where an idle server sits,
  // and why timers still fire on time.
  // INSIDE an I/O callback: `setImmediate` ALWAYS beats `setTimeout`:
  //   we are in poll, check is the next phase (this turn), timers only next turn.
  //   No time check involved → no race.
  waitForIO({ until: nearestTimer() });
  for (const cb of completedIOCallbacks()) { cb(); drain(); }

  // ---- check: `setImmediate` ----
  // An immediate added inside an immediate runs next turn.
  for (const cb of immediatesQueuedBeforeThisPhase()) { cb(); drain(); }

  // ---- close: close callbacks, `socket.on('close')` ----
  for (const cb of closeCallbacks) { cb(); drain(); }

  // After a drain the loop continues in the SAME phase / the NEXT phase.
  // No reset: it never jumps back to timers early.
  // Callback in poll → check (this turn) → timers (next turn).
  // Ticks and promises never wait for a turn: they run in the very next drain().
}

// ===== 5. Nothing left to wait for → process exits =====
// No timers, no sockets, no pending I/O. That's why an open server keeps the process alive.
process.exit();
```

### Ordering facts interviewers test
```js
// In the main module: ORDER IS NON-DETERMINISTIC (race on the 1 ms timer, see the rules above)
setTimeout(() => console.log('timeout'), 0);
setImmediate(() => console.log('immediate'));

// Inside an I/O callback: immediate ALWAYS first (poll → check → ... → timers)
fs.readFile(__filename, () => {
  setTimeout(() => console.log('timeout'), 0);
  setImmediate(() => console.log('immediate'));
});
```

- `process.nextTick` runs **before** promise microtasks. Because its queue is drained until empty, a nextTick that reschedules itself never lets the loop continue: timers, I/O and even promises **starve**. Use it only to defer an emit until after the constructor has returned (the classic EventEmitter pattern). Otherwise prefer `queueMicrotask`.
- `setImmediate` is the safe way to **yield** to I/O inside a long CPU loop: it runs once per loop turn, after poll (see §3).

Drills: [node-01](../practice/live-coding/02-nodejs.md#node-01), [node-02](../practice/live-coding/02-nodejs.md#node-02), [node-03](../practice/live-coding/02-nodejs.md#node-03), [node-04](../practice/live-coding/02-nodejs.md#node-04), [node-05](../practice/live-coding/02-nodejs.md#node-05), [node-06](../practice/live-coding/02-nodejs.md#node-06).

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
2. Chunk the work and yield with `setImmediate` between chunks (partitioning). This improves fairness, not total CPU time:
   ```js
   function processInChunks(items, chunkSize, fn) {
     return new Promise((resolve, reject) => {
       let i = 0;
       const runChunk = () => {
         try {
           const end = Math.min(i + chunkSize, items.length);
           for (; i < end; i++) fn(items[i]);
           if (i < items.length) setImmediate(runChunk);   // timers and I/O get a turn here
           else resolve();
         } catch (err) { reject(err); }
       };
       runChunk();
     });
   }
   ```
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

A Worker has its own thread, event loop and V8 isolate. Input goes in through `workerData` or `postMessage` (structured clone: data is copied unless you transfer an `ArrayBuffer`), and the result comes back as a message. One-off worker wrapped in a promise:
```js
import { Worker } from 'node:worker_threads';
function runInWorker(file, data) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(file, { workerData: data });
    worker.once('message', resolve);                 // worker: parentPort.postMessage(result)
    worker.once('error', reject);                    // uncaught exception inside the worker
    worker.once('exit', (code) => reject(new Error(`worker exited with code ${code}`)));
  });
}
```
- Listen to `message`, `error` **and** `exit`; settling twice is harmless because a promise settles once.
- `worker.terminate()` is real cancellation (wire it to an `AbortSignal`), unlike abandoning a promise.
- Starting a worker costs tens of ms, so production code keeps a pool sized to the CPU count:

```ts
// piscina pool example
import Piscina from 'piscina';
const pool = new Piscina({ filename: new URL('./worker.js', import.meta.url).href, maxThreads: 4 });
app.post('/report', async (req, res) => res.json(await pool.run(req.body)));
```
Drill: [node-46](../practice/live-coding/02-nodejs.md#node-46).

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

`als.run(store, fn)` ties `store` to the async context created inside `fn`. Promises, timers and I/O callbacks started there inherit it, so `getStore()` returns that request's store even after many `await`s, while concurrent requests each see their own. A module-level `let currentRequestId` does not work: requests interleave at every `await`, so it holds whichever request ran last.

Used by: pino `mixin` for log correlation, OpenTelemetry context, `nestjs-cls`, Sequelize CLS transactions, and Prisma/TypeORM transactional decorators.
Pitfall: context gets lost with some callback-based libraries and custom thenables. Wrap them with `AsyncResource.bind`. Drill: [node-50](../practice/live-coding/02-nodejs.md#node-50).

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
- `events.once(emitter, 'event')` returns a promise (resolving with the args array, rejecting if `'error'` fires first), and `events.on` returns an async iterator. Both accept `{ signal }`. Hand-written versions must attach both the event and `'error'` handlers and remove **both** (plus any timer and abort listener) on every exit path, or each call leaks listeners.

Minimal implementation (the interview version):
```js
class Emitter {
  #listeners = new Map();                        // event -> [{ fn, once }]
  on(event, fn, once = false) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, []);
    this.#listeners.get(event).push({ fn, once });   // keep the original fn, so off() also removes once-listeners
    return this;
  }
  once(event, fn) { return this.on(event, fn, true); }
  off(event, fn) {
    const list = this.#listeners.get(event) ?? [];
    const i = list.findIndex((l) => l.fn === fn);
    if (i !== -1) list.splice(i, 1);
    return this;
  }
  emit(event, ...args) {
    const list = this.#listeners.get(event) ?? [];
    if (event === 'error' && list.length === 0) throw args[0];
    for (const l of [...list]) {                 // copy: listeners may call on/off during emit
      if (l.once) this.off(event, l.fn);         // remove first, so a re-emit inside it can't call it twice
      l.fn.apply(this, args);
    }
    return list.length > 0;
  }
}
```
Drills: [node-29](../practice/live-coding/02-nodejs.md#node-29), [node-30](../practice/live-coding/02-nodejs.md#node-30).

---

## 7. HTTP server internals worth knowing

- **Keep-alive**: Node's `server.keepAliveTimeout` defaults to 5 s. Behind an AWS ALB (idle timeout 60 s) you get random **502s** when Node closes a socket the LB is about to reuse. **Set `keepAliveTimeout` higher than the LB idle timeout**, for example 65 s, and `headersTimeout` higher than `keepAliveTimeout`.
- **Outbound requests**: reuse connections. The global `fetch` (undici) pools by default. With `http.Agent`, set `keepAlive: true` (the default since Node 19). Unpooled requests cost a TCP+TLS handshake every time and can exhaust ephemeral ports.
- `server.requestTimeout` (default 300 s since Node 18) protects against slowloris-style attacks.
- `server.close()` stops accepting new connections but **waits for keep-alive sockets**. Call `server.closeIdleConnections()` too (Node 18.2+). See the graceful shutdown doc.

### A JSON API with bare `node:http`
The request is a Readable stream, so read the body with `for await` and **enforce a size limit** (otherwise one client can exhaust memory). Route on method + `new URL(req.url, 'http://x').pathname`. Funnel every error through one `.catch`, so an async failure never becomes an unhandled rejection or a request that never gets a response.
```js
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function readJson(req, limit = 1_000_000) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    if ((size += chunk.length) > limit) throw new HttpError(413, 'Body too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); }
  catch { throw new HttpError(400, 'Invalid JSON'); }
}
function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}
// route(req, res): async; matches method + path, throws HttpError(404) when nothing matches
http.createServer((req, res) => {
  route(req, res).catch((err) => {
    const status = err instanceof HttpError ? err.status : 500;
    send(res, status, { error: status === 500 ? 'Internal error' : err.message });  // no internals on 5xx
  });
}).listen(3000);
```
Missing for production: schema validation, `requestTimeout`/`headersTimeout`, auth, structured logs with request IDs, graceful shutdown. Drill: [node-38](../practice/live-coding/02-nodejs.md#node-38).

### Middleware chains
**Express model**: a stack of `(req, res, next)` functions; error handlers have 4 parameters `(err, req, res, next)`. `next()` calls the next normal layer; `next(err)` skips normal layers until an error handler. Core of it:
```js
function compose(stack, done) {                       // done = final 404/500 handler
  return (req, res) => {
    let i = 0;
    const next = (err) => {
      const layer = stack[i++];
      if (!layer) return done(err, req, res);
      const isErrorHandler = layer.length === 4;
      if (err ? !isErrorHandler : isErrorHandler) return next(err);   // wrong kind for this state: skip
      try {
        const out = err ? layer(err, req, res, next) : layer(req, res, next);
        out?.then?.(undefined, next);                 // async rejection → error path
      } catch (e) { next(e); }                        // sync throw → error path
    };
    next();
  };
}
```
Express 4 did not route rejected promises (hence `express-async-errors`); Express 5 does.

**Koa model** ("onion"): `async (ctx, next) => { before; await next(); after; }`. Code after `await next()` runs on the way back out, so timing, response post-processing and a single `try/catch` around `await next()` for errors are easy. Drill: [node-39](../practice/live-coding/02-nodejs.md#node-39).

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

**Q: In what order do sync code, `nextTick`, promises, `setTimeout(0)` and `setImmediate` run?**
Sync code first, then the whole nextTick queue, then the whole promise microtask queue, then macrotasks; the two queues are drained again after every macrotask callback. `setTimeout(0)` vs `setImmediate` is a race in the main module, but inside an I/O callback `setImmediate` always wins because check comes right after poll.

**Q: What happens if `process.nextTick` reschedules itself forever?**
The loop never leaves the nextTick queue, so timers, I/O and promise callbacks starve. Split long work into chunks and yield with `setImmediate`, or move it to a worker thread.

**Q: Why can't you store the current request ID in a module-level variable?**
Requests interleave at every `await`, so the variable holds whichever request touched it last. `AsyncLocalStorage.run(store, next)` gives each request its own context that follows its async calls.
