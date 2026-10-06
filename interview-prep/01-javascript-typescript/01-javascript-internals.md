# JavaScript Internals (Senior Level)

Questions about the language itself check whether you know *why* things behave the way they do. The topics below are the ones that come up at senior level.

---

## 1. Execution model: agents, threads, processes, tasks, microtasks

### 1.1 Engine vs host

- The **engine** (V8 in Chrome and Node, SpiderMonkey in Firefox, JavaScriptCore in Safari) only executes JavaScript: parsing, compiling, the **call stack**, the **heap**, and garbage collection. It has **no** timers, network, files, or DOM.
- The **host** is the program that embeds the engine: the **browser** or **Node.js**. The host provides `setTimeout`, `fetch`, `fs`, DOM events, and so on, and it runs the **event loop**.
- ECMAScript itself only defines **jobs** (promise reactions). Concepts like "task", "event loop", and "rendering" come from the host: the HTML spec for browsers, libuv plus Node's own code for Node.

### 1.2 What an "agent" is

"Agent" is an ECMAScript spec term: **one JS execution thread with its own call stack, heap (realm/isolate), and job queues**. Every place JS runs gets its own agent:

| Host | Agents |
|---|---|
| Browser | the page's main (window) thread; each **Dedicated Worker**; each **Shared Worker**; each **Service Worker**; worklets (see 1.4) |
| Node.js | the main thread; each `new Worker()` from `node:worker_threads` |

- Agents **don't share JS objects**. They communicate via `postMessage`, which copies data with the structured clone algorithm or *transfers* ownership of `ArrayBuffer`s, or via **`SharedArrayBuffer`** for raw shared memory (1.5).
- An **agent cluster** is a group of agents that are able to share memory (for example, a page and its dedicated workers in one process).

### 1.3 Agents and OS threads in Node and Chrome

In practice each agent runs on a **real OS thread**, with its own V8 **isolate** (a separate heap and its own GC). "JS is single-threaded" means **your JS code for a given agent** runs on one thread. The engine and host themselves use many helper threads.

**Node.js process:**
```
node process (PID 1234)
├── main thread            ← main agent: your JS + event loop (libuv)
├── libuv thread pool (4)  ← fs, dns.lookup, crypto, zlib (no JS runs here)
├── V8 platform threads    ← concurrent GC marking, background JIT compilation
└── worker_threads Worker  ← one OS thread per Worker, with its own isolate + own event loop
```

**Chrome** has a multi-process architecture:
```
Browser process        ← UI, tabs, navigation, permissions, storage coordination
GPU process            ← compositing / drawing to screen
Network service        ← all HTTP, sockets (a utility process)
Renderer process(es)   ← one per site (Site Isolation), sandboxed; inside each:
   ├── main thread          ← YOUR page JS + DOM, style, layout, paint commands, event dispatch
   ├── compositor thread    ← scrolling/animations without blocking on the main thread
   ├── raster threads       ← turn paint commands into pixels
   ├── worker threads       ← one per Dedicated/Shared/Service Worker, each with its own V8 isolate
   └── V8 helper threads    ← GC, background compilation
```
- Because page JS shares the **main thread** with layout and painting, a long-running JS task freezes the UI: clicks don't respond, and only compositor-driven scrolling may keep working. That's why CPU-heavy work goes into a Web Worker.
- Site Isolation means pages from different sites run in different OS processes, which is a security boundary (against Spectre, compromised renderers; explained in `05-Security/01-web-security-xss-csrf-csp.md` §7). Several tabs of the *same* site may share one renderer process, and therefore one process (but each tab still has its own main-thread event loop).

### 1.4 Workers: Web Worker vs Dedicated vs Shared vs Service Worker vs Worklets

**Terminology first: "Web Worker" vs "Dedicated Worker"**
- **"Web Workers"** is the *umbrella name* for the browser's Web Workers API: background JS threads with no DOM access. It covers **Dedicated Workers** and **Shared Workers**. (Service Workers are defined in a separate spec but are built on the same worker machinery, `WorkerGlobalScope`.)
- In everyday speech, "a Web Worker" almost always means a **Dedicated Worker**, the one you create with `new Worker(url)`. So "Web Worker vs Dedicated Worker" isn't really a comparison: a dedicated worker is the most common *kind* of web worker.

```
Web Workers API (umbrella)
├── Dedicated Worker   new Worker(url)          ← what people usually mean by "Web Worker"
└── Shared Worker      new SharedWorker(url)
Service Worker         navigator.serviceWorker.register(url)   (separate spec, worker-based)
Worklets               paintWorklet / audioWorklet ...         (lightweight, not full workers)
```

| | Dedicated Worker | Shared Worker | Service Worker | Worklets |
|---|---|---|---|---|
| Created by | `new Worker(url)` | `new SharedWorker(url)` | `navigator.serviceWorker.register(url)` | `CSS.paintWorklet.addModule()`, `audioContext.audioWorklet.addModule()` |
| Purpose | **CPU-heavy work off the main thread** (parsing, image/crypto processing, WASM) | same kind of work, but **one instance shared by all tabs/iframes of the same origin** (e.g., one WebSocket or one DB connection for all tabs) | **network proxy** between page and network: intercepts `fetch` events → offline support (Cache API), push notifications, background sync | tiny scripts that **hook into the rendering or audio pipeline** |
| How many instances | one per `new Worker()` call | **one per origin + script URL**, no matter how many tabs | **one active per scope** (e.g. `/app/`) per origin | engine decides (may create several) |
| Owned by | the page that created it; dies with it | all connected same-origin pages; dies when the last one disconnects | the **origin + scope**; lives **independently of pages** (runs even with no tab open, e.g. for push) | the rendering/audio engine |
| Lifetime | as long as page (or `terminate()`) | while any client connected | event-driven: browser **starts it for an event and kills it when idle** (see below) | managed by the engine; may be created/destroyed/duplicated at will |
| DOM access | no | no | no | no |
| Communication | `postMessage` | `MessagePort` (`port.postMessage`) | `postMessage`, plus `fetch`/`push`/`sync` events | very restricted, no `postMessage` for most kinds |
| Requirements | — | — | **HTTPS** (or localhost); install → activate lifecycle; one active version controls clients | AudioWorklet/PaintWorklet need secure context |

#### Platform support

| | Browsers | Node.js | Deno / Bun |
|---|---|---|---|
| Dedicated Worker (`new Worker()`, web API) | ✅ all modern browsers | ❌ not the web API, but ✅ **`worker_threads`** is the equivalent (different API) | ✅ web-style `new Worker()` |
| Shared Worker | ✅ Chrome/Edge desktop, Firefox, Safari 16+; ⚠️ historically **not on Chrome for Android** (check caniuse before relying on it) | ❌ no equivalent | ❌ |
| Service Worker | ✅ all modern browsers (HTTPS only) | ❌ concept doesn't apply (there's no browser network layer to intercept; the server *is* the network) | ❌ (Deno Deploy/Cloudflare Workers use a *similar event-style API* but run on servers, not as proxies) |
| Worklets | ✅ AudioWorklet in all major browsers; PaintWorklet **Chromium only** | ❌ | ❌ |

**So in Node:** you get **only one kind of worker, `worker_threads`**, which plays the role of a Dedicated Worker:
```js
// Node                                           // Browser
import { Worker } from 'node:worker_threads';     const w = new Worker('/worker.js', { type: 'module' });
const w = new Worker('./worker.js');              w.postMessage(data);
w.postMessage(data);                              w.onmessage = (e) => console.log(e.data);
w.on('message', (msg) => console.log(msg));
// inside worker: parentPort.postMessage(...)      // inside worker: self.postMessage(...)
```
Node has **no Shared Worker**. One process already shares one runtime, so you share state between `worker_threads` with `SharedArrayBuffer`, `MessageChannel`, or `BroadcastChannel` (Node has those), and between *processes* or *pods* with Redis or a DB. Node has no **Service Workers** or **Worklets** either: they're browser features tied to the page's network stack and rendering/audio pipeline.

#### Service Workers: why not keep state in global variables
```js
// sw.js — ❌ BUG
let requestCount = 0;                 // looks like persistent state...
let authToken = null;
self.addEventListener('fetch', (e) => { requestCount++; /* ... uses authToken ... */ });
```
- The browser **starts the service worker only to handle an event** (`fetch`, `push`, `message`, `sync`) and **terminates it when idle**: Chrome after roughly 30 seconds with no events, with additional caps on how long a single event may keep it alive. The next event **starts a fresh instance**, which runs the script top to bottom again, so `requestCount` is back to `0` and `authToken` is `null`.
- You can't predict when this happens, so the bug shows up as "works during development (DevTools open keeps the SW alive), randomly fails in production".
- A new deployed version also **replaces** the old worker (install → activate), discarding its memory.
- **Instead**: persist state in **IndexedDB** (structured data), the **Cache API** (HTTP responses), or ask the page (`clients.matchAll()` + `postMessage`). Use **`event.waitUntil(promise)`** to keep the worker alive until async work (writing to IndexedDB, caching) finishes; otherwise it can be killed mid-operation.
- Globals are fine **only as a per-instance cache** that you can always rebuild (e.g. a lazily opened IndexedDB connection).

#### Service Worker lifecycle
`register` → `install` (precache assets) → `waiting` (until old version's clients close, unless `skipWaiting()`) → `activate` (clean old caches; `clients.claim()`) → handles `fetch` events for pages in its scope. Debugging a "stale version" usually means looking at this lifecycle.

#### Worklets
**AudioWorklet** (custom audio processing on the real-time audio thread), **PaintWorklet** (CSS Paint API, `background: paint(myPainter)`), Animation Worklet and Layout Worklet (experimental). They're lighter than workers and run with a minimal global scope. They must be stateless-ish, because the engine may run several instances or discard them.

#### When to use which (browser)

| Situation | Use | Why |
|---|---|---|
| Heavy computation freezes the UI (parsing a 50 MB CSV/Excel import, image resizing/filters, PDF generation, encryption, diffing large JSON, search indexing, running WASM like ffmpeg/SQLite) | **Dedicated Worker** | moves CPU work off the main thread; UI stays responsive (good INP) |
| Several tabs of your app each open the same expensive resource (one WebSocket/SSE connection, one sync engine, one in-memory cache) and should share it | **Shared Worker** (fallback: **BroadcastChannel** + leader election, or a Dedicated Worker per tab where Shared Worker isn't supported) | one instance per origin instead of N; consistent state across tabs |
| App should work offline / on flaky networks, load instantly on repeat visits (PWA) | **Service Worker** (+ Cache API, often via Workbox) | intercepts requests, serves cached responses |
| Push notifications when no tab is open; retry failed sends when back online (background sync) | **Service Worker** | only worker type that runs without an open page |
| Custom audio effects/synthesis with low latency | **AudioWorklet** | runs on the real-time audio thread; a regular worker would glitch |
| Custom CSS painting (backgrounds, borders) driven by CSS properties | **PaintWorklet** (Chromium only) | runs inside the rendering pipeline |
| Small async work (fetching data, timers, light JSON) | **none, stay on the main thread** | it's I/O, not CPU; a worker adds messaging and serialization overhead |

Rules of thumb:
- Workers help with **CPU** work, not I/O. `fetch` is already asynchronous.
- `postMessage` **copies** data (structured clone). For big binary data, **transfer** `ArrayBuffer`s (zero-copy) or use `SharedArrayBuffer`.
- Libraries like **Comlink** make a worker look like an async object (`await api.parse(file)`), which removes most of the messaging boilerplate.
- A worker costs memory and startup time (its own isolate). Create **one** (or a small pool), and reuse it.

### 1.5 ArrayBuffer, SharedArrayBuffer and Atomics

#### ArrayBuffer: raw binary memory
An **`ArrayBuffer` is a fixed-length block of raw binary bytes**. You **can't read or write it directly**: it has no indexes and no idea what the bytes mean. You access it through a **view**, which says how to interpret the bytes:

- **Typed arrays** see the whole buffer as one numeric type: `Uint8Array` (bytes 0–255), `Int16Array`, `Int32Array`, `Uint32Array`, `Float32Array`, `Float64Array`, `BigInt64Array`, `Uint8ClampedArray` (pixel data)...
- **`DataView`** reads and writes **mixed types at any byte offset**, with explicit **endianness**. Use it for parsing binary file formats and network protocols.

```js
const buf = new ArrayBuffer(8);            // 8 bytes, all zero
const bytes = new Uint8Array(buf);         // view: 8 × 1-byte unsigned ints
const ints  = new Int32Array(buf);         // view on the SAME memory: 2 × 4-byte ints

ints[0] = 258;                             // 258 = 0x00000102
console.log(bytes.slice(0, 4));            // Uint8Array [2, 1, 0, 0]  ← little-endian byte order (x86/ARM)

const dv = new DataView(buf);
dv.setUint16(4, 0xCAFE, false);            // big-endian (network byte order) at byte offset 4
console.log(dv.getUint16(4, false).toString(16)); // 'cafe'
```

- Several views can share one buffer: they're windows onto the same bytes, not copies.
- Where you meet it: `fetch(...).arrayBuffer()`, `FileReader`/`Blob.arrayBuffer()`, WebSocket binary messages, `crypto.subtle`, canvas `ImageData` pixels, **WebAssembly memory**, audio samples.
- **Node's `Buffer` is a subclass of `Uint8Array`**, so it's a view over an `ArrayBuffer` (often a slice of a shared 8 KB pool; see the streams doc). `buf.buffer` gives you the underlying ArrayBuffer.
- ES2024 additions: **resizable** buffers (`new ArrayBuffer(8, { maxByteLength: 64 })` + `.resize()`) and `.transfer()` (move contents to a new buffer and detach the old one).
- Why not a regular JS array? `[1, 2, 3]` stores tagged JS values (each a number or object reference, possibly holes, mixed types) and grows dynamically. A typed array is **dense, fixed-type, contiguous memory**. It's much more compact and fast, and it can be passed to native code, the GPU, WASM, or another thread without conversion.

#### Passing buffers between agents
- An `ArrayBuffer` sent through `postMessage` is **copied** by default, or **transferred** if you list it in the transfer list (`worker.postMessage(buf, [buf])`): ownership moves at zero copy cost, and the sender's buffer becomes **detached** (`byteLength` 0, unusable).

#### SharedArrayBuffer
- A **`SharedArrayBuffer` (SAB)** is a block of raw bytes whose memory is **shared**: `postMessage` sends a *reference*, and every agent reads and writes the **same bytes** through typed arrays (`Int32Array`, etc.).
- Shared memory brings **data races**. `counter[0]++` is a read, an add, and a write, so two threads can interleave and lose increments. **`Atomics`** gives you indivisible operations:
  - `Atomics.add/sub/and/or/xor/exchange/compareExchange/load/store`
  - `Atomics.wait(arr, idx, expected, timeoutMs?)` **blocks the thread** until notified (see below).
  - `Atomics.waitAsync(arr, idx, expected, timeoutMs?)` is the **non-blocking** version that returns a promise.
  - `Atomics.notify(arr, idx, count)` wakes waiters.
  - Together these let you build mutexes, semaphores, and lock-free queues between workers.

#### What "Atomics.wait blocks the thread" means
**Blocking** = the OS thread **stops executing entirely** and sleeps inside the kernel (it's implemented with a futex on Linux), until another thread calls `Atomics.notify` on the same index or the timeout expires. While it's blocked, **that agent's event loop is frozen too**: no timers, no I/O callbacks, no promise callbacks, no incoming messages, and (on a browser main thread) no rendering or input.

Compare with **`await`**, which is *non-blocking*: it suspends only the current `async` function and **returns control to the event loop**, so everything else keeps running.

```
await somePromise        → this function pauses, the THREAD keeps running other tasks
Atomics.wait(...)        → the whole THREAD sleeps; nothing else runs on it
Atomics.waitAsync(...)   → returns a promise; thread keeps running; resolve when notified
```

How `wait` works step by step:
1. **Atomically** check `arr[idx] === expected`.
   - If **not equal**, return `'not-equal'` immediately (the thing you were waiting for already happened). Doing the check atomically avoids the classic *lost wake-up* race: "check, then sleep" with a notify slipping in between.
2. If equal, sleep until `Atomics.notify(arr, idx)` wakes it (returns `'ok'`) or the timeout passes (returns `'timed-out'`).

Where it's allowed:
| Context | `Atomics.wait` (blocking) | `Atomics.waitAsync` |
|---|---|---|
| Browser **main thread** | ❌ **throws `TypeError`**: blocking it would freeze the page (no rendering, no input) | ✅ |
| Browser **worker** | ✅ (a worker has no UI, so blocking is acceptable) | ✅ |
| Node **main thread** | ✅ allowed, but it **freezes the whole server's event loop**; avoid in request paths | ✅ |
| Node **worker_threads** | ✅ | ✅ |

(`waitAsync` shipped in Chromium and Node 16+ first; check support in other browsers.)

Verified on Node 24: a worker computes for 200 ms, then stores a result and notifies. The main thread's `waitAsync` keeps the event loop alive (a 50 ms timer still fires) and resolves with `'ok'`:
```js
import { Worker, isMainThread, workerData } from 'node:worker_threads';
if (isMainThread) {
  const sab = new SharedArrayBuffer(8);
  const shared = new Int32Array(sab);                 // [0] = ready flag, [1] = result
  new Worker(new URL(import.meta.url), { workerData: sab });
  setTimeout(() => console.log('event loop still alive'), 50);   // fires: waitAsync doesn't block
  const { value } = Atomics.waitAsync(shared, 0, 0);  // wait while shared[0] === 0
  console.log(await value, Atomics.load(shared, 1));  // 'ok' 42
} else {
  const shared = new Int32Array(workerData);
  /* ...200ms of CPU work... */
  Atomics.store(shared, 1, 42);                       // write result first
  Atomics.store(shared, 0, 1);                        // then flip the flag
  Atomics.notify(shared, 0);                          // wake whoever waits on index 0
}
```
Other verified behaviors: `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)` → sleeps ~100 ms and returns `'timed-out'` (a "synchronous sleep" trick in Node; it blocks everything). Calling `wait` when the value already differs returns `'not-equal'` immediately.

Typical uses of blocking `wait` (always inside workers):
- **Producer/consumer queues** between workers, where the consumer sleeps when the queue is empty instead of busy-polling.
- **Mutexes/locks** around shared data structures.
- **Making async APIs synchronous inside a worker**: the worker posts a request, then `Atomics.wait`s until the main thread writes the answer into the SAB and notifies. Emscripten (WASM pthreads, `ASYNCIFY`-free sync calls), Pyodide, and in-browser TypeScript/language servers use this so compiled C/Rust/Python code that expects blocking calls can run.

#### SharedArrayBuffer + Atomics are NOT Node-only
They're **standard JavaScript (ES2017)** and work in **both browsers and Node**:

| | Browser | Node |
|---|---|---|
| Share memory between | page main thread ↔ **Dedicated Workers** (and Shared Workers / AudioWorklets) | main thread ↔ `worker_threads` |
| How to share | `worker.postMessage(sab)` (the reference is shared, not copied) | `new Worker(file, { workerData: sab })` or `postMessage(sab)` |
| Requirement | page must be **cross-origin isolated** (COOP + COEP headers, see below) | none |
| Not possible between | different tabs/processes (no shared memory across processes); Service Workers can't share SAB with pages | different processes (`child_process`, `cluster`) |

Browser example: a page and a worker sharing progress without messages:
```js
// main.js (page served with COOP: same-origin + COEP: require-corp)
if (!crossOriginIsolated) throw new Error('SharedArrayBuffer unavailable: missing COOP/COEP headers');
const sab = new SharedArrayBuffer(4);
const progress = new Int32Array(sab);
const worker = new Worker('/worker.js');
worker.postMessage({ sab, file });                       // SAB shared, File copied
function render() {
  bar.style.width = Atomics.load(progress, 0) + '%';     // read worker's progress directly, no message spam
  if (Atomics.load(progress, 0) < 100) requestAnimationFrame(render);
}
requestAnimationFrame(render);

// worker.js
self.onmessage = ({ data: { sab, file } }) => {
  const progress = new Int32Array(sab);
  for (let pct = 1; pct <= 100; pct++) {
    processChunk(file, pct);                             // heavy CPU work
    Atomics.store(progress, 0, pct);
  }
};
```

Real browser uses:
- **WebAssembly threads**: compiled C/C++/Rust threads (`pthread`) become Web Workers sharing one SAB as WASM memory, with Atomics for locks. ffmpeg.wasm (multi-threaded build), Photoshop/Figma-style apps, and SQLite WASM rely on this.
- **AudioWorklet ring buffers**: the real-time audio thread must never block or allocate, so a worker writes samples into a SAB ring buffer and the worklet reads them with Atomics.
- Big data visualizations and games: workers compute into shared buffers, and the main thread renders.

When **not** to use SAB: for ordinary request/response between page and worker, plain `postMessage` (plus transferables for big buffers) is simpler and has no header requirements. SAB is for high-frequency or very large shared state and for WASM threads.

```js
// Node: 4 workers increment a shared counter 100k times each → exactly 400000 (verified)
import { Worker, isMainThread, workerData } from 'node:worker_threads';
if (isMainThread) {
  const sab = new SharedArrayBuffer(4);
  const counter = new Int32Array(sab);
  const workers = Array.from({ length: 4 }, () => new Worker(new URL(import.meta.url), { workerData: sab }));
  await Promise.all(workers.map(w => new Promise(r => w.on('exit', r))));
  console.log(Atomics.load(counter, 0));      // 400000 (with counter[0]++ it could be less)
} else {
  const c = new Int32Array(workerData);
  for (let i = 0; i < 100_000; i++) Atomics.add(c, 0, 1);
}
```

- **Browser restriction**: after the **Spectre** CPU vulnerability (2018), browsers disabled SAB, because shared memory makes high-resolution timers possible (details: `05-Security/01-web-security-xss-csrf-csp.md` §7). It's available again only on **cross-origin isolated** pages, which send:
  ```http
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  ```
  (Check `self.crossOriginIsolated`.) Node has no such restriction.
- Use cases: WASM threads (e.g. ffmpeg.wasm, SQLite WASM), high-performance worker pipelines, and passing large datasets between workers without copying.

### 1.6 Process vs agent; child_process and cluster

| | **Process** (OS concept) | **Agent** (JS spec concept) |
|---|---|---|
| What | an OS-level container: own **virtual address space**, PID, file descriptors, environment | one JS execution thread with its own stack, heap, job queues |
| Contains | one or more OS threads | runs on exactly one thread |
| Memory sharing | isolated from other processes (only explicit OS shared memory / pipes / sockets) | agents **in the same process** can share memory via SharedArrayBuffer |
| Crash isolation | a crash kills only that process | an unhandled crash in a worker emits `'error'`; a native crash (e.g., V8 OOM in main) kills the whole process |
| Relationship | a Node process = **1 main agent + 1 agent per `worker_thread`** | — |

**`node:child_process`** starts **separate OS processes**. Each one is a full program with its own memory and, if it's Node, its own V8, event loop, and ~30–50 MB of baseline memory.

| Function | What it does | Use for |
|---|---|---|
| `spawn(cmd, args)` | starts any binary; stdin/stdout/stderr are **streams** | long-running or large-output commands (ffmpeg, pg_dump) |
| `execFile(file, args, cb)` | like spawn, but **buffers** output; **no shell** | short commands with small output, safely |
| `exec(cmdString, cb)` | runs through a **shell** (`/bin/sh -c`), buffers output | quick scripts; ⚠️ **command injection** if you interpolate user input |
| `fork(modulePath)` | spawns a **new Node process** running a JS file, with a built-in **IPC channel** (`child.send()` / `process.on('message')`) | offloading work to an isolated Node process |

```js
import { spawn } from 'node:child_process';
const p = spawn('pg_dump', ['--format=custom', dbUrl]);   // args array → no shell, no injection
p.stdout.pipe(uploadStream);
p.on('exit', (code) => console.log('exit', code));
```

**`node:cluster`** is built on `fork()`. It's for using **multiple CPU cores with one HTTP server**:
- The **primary** process forks N **worker processes** (usually one per core). All of them call `server.listen(3000)`, but the **primary owns the port** and hands incoming connections to workers (round-robin by default on Linux and macOS).
- Workers are **separate processes**, so nothing is shared in memory. In-memory caches, sessions, and rate limiters each exist N times, which is why that state belongs in Redis.
- The primary can restart workers that crash (`cluster.on('exit', () => cluster.fork())`). PM2's "cluster mode" works the same way.
- In **Kubernetes** you usually **don't** use cluster: run **one Node process per pod** and scale with replicas, so K8s sees each process's health and memory directly.

Summary of Node concurrency options:
| Need | Use |
|---|---|
| CPU-heavy JS without blocking the event loop | `worker_threads` (same process, can share memory) |
| Run another program / isolate untrusted or crash-prone work | `child_process` |
| Use all cores for an HTTP server on one machine/VM | `cluster` (or PM2); in K8s → replicas instead |

### 1.7 Tasks (macrotasks), "callbacks from the host", and microtasks

- A **task** (often called a **macrotask**; the HTML spec says "task", Node has no official name) is **one call from the host into your JS** in response to something happening:
  - the initial script/module evaluation itself
  - a timer firing (`setTimeout`/`setInterval`)
  - an I/O completion (file read done, socket data, an HTTP request arriving in Node)
  - a user event (click, keypress) or `postMessage`
  - `setImmediate` (Node), a `MessageChannel` message
- A task **runs until the call stack is empty**. It isn't limited to one function: the callback can call any number of functions synchronously. The task ends when control returns to the host.
- A **microtask** is a small follow-up job that must run **as soon as the current task finishes**, before the host does anything else:
  - promise reactions: `.then`/`.catch`/`.finally` callbacks
  - the continuation of an `async` function after `await` (each `await` splits the function: the rest runs as a microtask once the awaited promise settles)
  - `queueMicrotask(fn)`
  - `MutationObserver` callbacks (browser)
  - Node also has **`process.nextTick`**: a *separate* queue drained **before** the promise microtask queue.

### 1.8 The loop: precisely what runs when

**Browser** (per event loop iteration):
1. Take **one** task from a task queue and run it to completion.
2. **Microtask checkpoint**: run microtasks until the queue is **empty**, including microtasks queued *during* this step.
3. Maybe **render** (rAF callbacks → style → layout → paint), typically at the display refresh rate.
4. Repeat.

**Node** (libuv phases: timers → pending → poll → check → close; see `02-Node.js/01-event-loop-and-runtime.md`):
- Each phase may run **many** callbacks (all expired timers, a batch of I/O callbacks, all queued immediates).
- **After each individual callback**: drain the `nextTick` queue, then the promise microtask queue (repeating until both are empty).
- This per-callback draining was introduced in **Node 11**. Before that, Node drained microtasks only **between phases**, so the output differed from browsers:

```js
setTimeout(() => { console.log('t1'); Promise.resolve().then(() => console.log('m1')); process.nextTick(() => console.log('tick1')); });
setTimeout(() => console.log('t2'));
// Node ≥ 11 and browsers (no nextTick): t1, tick1, m1, t2    (verified on Node 24)
// Node ≤ 10:                            t1, t2, tick1, m1
```

**A common misunderstanding**: "after the task, run **all microtasks in the codebase**". That's wrong. The loop runs **only microtasks that are already in the queue** (plus any queued while draining). A microtask is only queued **at runtime** when:
- a promise **settles** and already has a `.then` attached → its reactions get queued, or
- `.then` is attached to an **already settled** promise → queued immediately, or
- `queueMicrotask`/`await`/`nextTick` is called.

A promise that's still **pending** (waiting on a timer, a file, or the network) has nothing queued. Its reactions are queued later, when the host completes the I/O and resolves it **inside a future task**:

```js
import fs from 'node:fs';
console.log('A');                                          // task 1 (the script)
fs.readFile(file, () => {                                  // registers I/O; nothing queued yet
  console.log('C');                                        // task N (I/O callback, later)
  Promise.resolve().then(() => console.log('D'));          // microtask of task N
});
Promise.resolve().then(() => console.log('B'));            // microtask of task 1
// A, B, C, D   (verified)
```

Full ordering example:
```js
setTimeout(() => console.log('timeout'), 0);
Promise.resolve().then(() => console.log('micro 1'));
queueMicrotask(() => console.log('micro 2'));
process.nextTick(() => console.log('tick'));   // Node only
console.log('sync');
// sync, tick, micro 1, micro 2, timeout
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [load-shedding](../../docs/humans/concepts/common-load-shedding/load-shedding.md): The load-shedding module monitors Node event-loop delay (p99) to shed load when the loop stalls.
<!-- theory-links:end -->

### 1.9 `queueMicrotask`

`queueMicrotask(fn)` puts `fn` **directly** on the microtask queue.
- It behaves like `Promise.resolve().then(fn)`, but **doesn't allocate a promise** (cheaper).
- **Error handling differs**: if `fn` throws, it's reported as a regular **uncaught exception** (`window.onerror`; `process.on('uncaughtException')` in Node). With `Promise.resolve().then(fn)` it becomes a **rejected promise** (`unhandledrejection` / `unhandledRejection`).
- It's the standardized, cross-environment way to say "run this right after the current synchronous code, before any timers, I/O, or rendering".

Typical use, **batching** many synchronous calls into one flush (the trick UI frameworks and loggers use):
```js
let pending = [];
function log(msg) {
  pending.push(msg);
  if (pending.length === 1) {
    queueMicrotask(() => { send(pending); pending = []; });   // one flush per synchronous burst
  }
}
log('a'); log('b'); log('c');   // → send(['a','b','c']) called once
```

### 1.10 Microtask starvation ("recursive Promise.resolve starves I/O")

Step 2 of the loop doesn't finish until the microtask queue is **empty**. If every microtask queues another one, the queue never empties and the loop **never reaches the next task**. Timers, I/O callbacks, incoming HTTP requests, and (in browsers) rendering and input all stop. CPU sits at 100%, even though there's no visible `while (true)`.

```js
setTimeout(() => console.log('timeout'), 0);   // never prints
function loop() { Promise.resolve().then(loop); }
loop();
```

Verified with a bounded version on Node 24: a 0 ms timeout only fired **after** a chain of 2,000,000 microtasks had completed.

Compare `setTimeout(loop)` / `setImmediate(loop)`: each step is a **new task**, so the loop gets a chance to run other work in between. The same applies to recursive `process.nextTick`, which starves even promise microtasks.

**The version you'll actually hit**: an `await` loop that never really waits:
```js
async function processAll(items) {
  for (const x of items) {
    await transform(x);       // transform is `async` but does no real I/O → resolves immediately
  }
}
```
Each `await` on an already resolved promise only schedules a **microtask**, so the loop never yields to the event loop. With a million items, the server stops answering requests until it finishes. Fix: yield to the macrotask queue from time to time (or move the work into a worker thread):
```js
for (let i = 0; i < items.length; i++) {
  await transform(items[i]);
  if (i % 1000 === 0) await new Promise((r) => setImmediate(r));   // Node: let I/O run
  // browser: await new Promise((r) => setTimeout(r)) or scheduler.yield() where supported
}
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`EventLoopMonitor`](../../packages/backend/libs/common/load-shedding/event-loop-monitor.service.ts#L12): EventLoopMonitor measures event-loop delay and publishes p99, which is the symptom that microtask or CPU starvation produces. _(event-loop-monitor.service.ts)_ · [load-shedding](../../docs/humans/concepts/common-load-shedding/load-shedding.md)
<!-- theory-links:end -->

### 1.11 Everything together: one annotated example (Node)

Save as `order.cjs` and run `node order.cjs`. The output below was **identical across repeated runs on Node 24**.

```js
const fs = require('node:fs');

console.log('1 sync start');                          // (A) synchronous: runs now, inside task #1 (the script)

setTimeout(() => {                                    // (B) schedules a TIMER task (timers phase, ≥1ms)
  console.log('timeout 1');
  process.nextTick(() => console.log('timeout 1 → nextTick'));       // drained right after THIS callback
  Promise.resolve().then(() => console.log('timeout 1 → promise'));  // ...then promise microtasks
}, 0);

setTimeout(() => console.log('timeout 2'), 0);        // (C) second timer, same phase, runs after timeout 1
                                                      //     (and after timeout 1's microtasks, Node ≥ 11)

setImmediate(() => console.log('immediate 1'));       // (D) CHECK-phase task: runs after the poll phase

fs.readFile(__filename, () => {                       // (E) I/O on the libuv thread pool; callback is a
  console.log('readFile callback');                   //     POLL-phase task once the read completes
  setTimeout(() => console.log('readFile → timeout'), 0);   // next loop iteration's timers phase
  setImmediate(() => console.log('readFile → immediate'));  // check phase of THIS iteration (poll → check)
  process.nextTick(() => console.log('readFile → nextTick'));
});

Promise.resolve().then(() => {                        // (F) promise MICROTASK, queued now (promise already resolved)
  console.log('promise 1');
  process.nextTick(() => console.log('promise 1 → nextTick'));  // nextTick from inside a microtask:
                                                                //  runs after the WHOLE promise queue drains
  Promise.resolve().then(() => console.log('promise 1 → promise')); // appended to the CURRENT microtask drain
});

queueMicrotask(() => console.log('queueMicrotask'));  // (G) same queue as promises, FIFO → after (F)

process.nextTick(() => {                              // (H) nextTick queue: in CJS it runs BEFORE promise
  console.log('nextTick 1');                          //     microtasks, even though queued after them
  process.nextTick(() => console.log('nextTick 1 → nextTick'));     // nextTick queue drains fully first
  Promise.resolve().then(() => console.log('nextTick 1 → promise')); // goes to the END of the promise queue
});

(async () => {
  console.log('async fn (sync part)');                // (I) an async function runs SYNCHRONOUSLY until its first await
  await null;                                         //     the rest becomes a promise microtask (queued after F, G)
  console.log('async fn after await');
})();

const start = Date.now(); while (Date.now() - start < 5) {} // busy-wait 5ms so the 1ms timers have definitely
                                                            // expired → makes timers-vs-immediate deterministic
console.log('2 sync end');                            // (J) still task #1
```

Output, and why:
```
1 sync start              ┐
async fn (sync part)      │ Task #1 (the script): all synchronous code, top to bottom.
2 sync end                ┘ Nothing async can interrupt it.

nextTick 1                ┐ Script task finished → Node drains the nextTick queue FIRST,
nextTick 1 → nextTick     ┘ including ticks added while draining it.

promise 1                 ┐ Then the promise microtask queue, FIFO in the order things were queued:
queueMicrotask            │   F, G, I (await continuation) were queued during the script;
async fn after await      │   "nextTick 1 → promise" was queued during the nextTick drain → after them;
nextTick 1 → promise      │   "promise 1 → promise" was queued while draining → appended, still same drain.
promise 1 → promise       ┘

promise 1 → nextTick        Promise queue empty → Node checks the nextTick queue again → runs it.
                            (Repeats nextTick ⇄ promises until BOTH are empty.)

timeout 1                 ┐ Event loop starts. TIMERS phase: both timers expired (busy-wait).
timeout 1 → nextTick      │ After EACH timer callback, drain nextTick then promises (Node ≥ 11),
timeout 1 → promise       │ so timeout 1's micro-work runs before timeout 2.
timeout 2                 ┘

immediate 1                 POLL phase: readFile not finished yet (it needs several thread-pool
                            round trips: open, stat, read, close) → nothing to run → CHECK phase.

readFile callback         ┐ A later iteration: POLL phase runs the I/O callback.
readFile → nextTick       │ Its nextTick runs right after it.
readFile → immediate      │ poll → CHECK comes next in the same iteration → immediate before timeout,
readFile → timeout        ┘ ALWAYS, when both are scheduled from inside an I/O callback.
                            The timer waits for the next iteration's TIMERS phase.
```

Rules this example demonstrates:
1. All synchronous code finishes first. Nothing preempts running JS.
2. After every task: **nextTick queue → promise/microtask queue**, repeated until both are empty.
3. `queueMicrotask`, `.then`, and `await` continuations share **one FIFO queue**. Order = the order they were *queued*, not the order they appear in the source.
4. Microtasks queued while draining are run **in the same drain**. That's the reason starvation is possible (1.10).
5. Phases: **timers → poll (I/O) → check (setImmediate)**. From an I/O callback, `setImmediate` always beats `setTimeout(0)`.
6. In the main script, `setTimeout(0)` vs `setImmediate` is **nondeterministic**: it depends on whether 1 ms has passed when the loop starts. The busy-wait above forces "timeout first". Remove it and the order may flip.

**⚠️ ES modules change the startup order.** Run the same code as `order.mjs` and the first part becomes:
```
1 sync start
async fn (sync part)
2 sync end
promise 1                 ← promises BEFORE nextTick!
queueMicrotask
async fn after await
promise 1 → promise
nextTick 1
promise 1 → nextTick
nextTick 1 → nextTick
nextTick 1 → promise
timeout 1 ...             (the rest is the same)
```
Why: ESM evaluation is asynchronous. Node evaluates the module graph **inside a promise job**, so when your top-level code finishes, Node is *already in the middle of draining the microtask queue*. Promise microtasks queued by the module run in that same drain. The nextTick queue is only processed once the drain completes. In CommonJS the script is a plain task, so nextTick goes first. **Don't write code that depends on nextTick-vs-promise order.**

Browser equivalent (no `nextTick`/`setImmediate`): sync → microtasks (`.then`, `queueMicrotask`, `await`, `MutationObserver`) → maybe render (`requestAnimationFrame` callbacks run just before paint) → next task (`setTimeout`, events, `MessageChannel` messages). `MessageChannel` is the usual way to get a "setImmediate"-like task in browsers, without `setTimeout`'s clamping (≥4 ms after 5 nested levels).

### 1.12 History: when these pieces arrived

| Year | Addition |
|---|---|
| 2009–2010 | Node.js released with `process.nextTick` (Node-specific "run after current operation" queue) and `setImmediate` (added in Node 0.10, 2013) |
| ~2010–2014 | Promise libraries (Q, when.js, Bluebird) implement their own async scheduling via `nextTick`, `setImmediate`, or `MutationObserver` hacks; the **Promises/A+** community spec (2012–2013) standardizes `then` behavior |
| ~2012 | `MutationObserver` arrives in browsers (Chrome 18 prefixed / 26, Firefox 14); the HTML spec defines the **microtask queue and microtask checkpoint** to deliver its callbacks |
| **2015** | **ES2015 (ES6)** adds native **Promises** and the spec concept of **jobs** (PromiseJobs) → promise reactions become standard microtasks |
| **2017** | **ES2017 `async`/`await`** (Node 7.6/8, Chrome 55): `await` continuations are microtasks |
| **2018** | **`queueMicrotask`** (Chrome 71, Firefox 69 in 2019, **Node 11**) |
| **2018** | **Node 11** aligns with browsers: microtasks drained **after each** timer/immediate callback instead of between phases |
| 2018 | Spectre: `SharedArrayBuffer` disabled in browsers; returns ~2020 behind cross-origin isolation |
| 2018 (Node 10.5, stable in 12) | `worker_threads` |

### 1.13 Interview Q&A for this section

**Q: JS is single-threaded, so how do Web Workers / worker threads exist?**
Each worker is a separate **agent** on its own OS thread with its own isolate and event loop. Your code within one agent is single-threaded. Agents communicate by message passing or SharedArrayBuffer with Atomics.

**Q: Web Worker vs Service Worker?**
A Web Worker is a background thread for computation, owned by one page. A Service Worker is an event-driven network proxy for an origin's scope that lives independently of pages: offline caching, push, background sync. The browser starts it for events and kills it when idle, it requires HTTPS, and it has an install/activate lifecycle.

**Q: Process vs thread vs agent?**
A process is an OS container with isolated memory. Threads live inside a process and share its memory. An agent is the JS-level unit: one JS thread with its own heap and queues. A Node process has one main agent plus one per worker_thread. `child_process` and `cluster` create new processes.

**Q: What does `Atomics.wait` do, and why is it banned on the browser main thread?**
It atomically checks that a shared Int32 slot still holds an expected value, then puts the whole OS thread to sleep until `Atomics.notify` or a timeout. Unlike `await`, nothing else on that thread runs, event loop included. On the main thread that would freeze rendering and input, so browsers throw. Use `Atomics.waitAsync` there, or block only in workers.

**Q: Are SharedArrayBuffer and Atomics Node-only?**
No. They're standard JS and work between a page and its Web Workers, but browsers require cross-origin isolation (COOP + COEP) because of Spectre. Main uses: WASM threads, AudioWorklet ring buffers, high-frequency shared state between workers.

**Q: Which browser worker would you use for what?**
A Dedicated Worker for CPU-heavy work off the UI thread. A Shared Worker to share one connection or state across tabs. A Service Worker for offline caching, push, and background sync. Worklets for audio processing or CSS painting. Node only has `worker_threads`, its equivalent of a dedicated worker.

**Q: Explain macrotasks vs microtasks.**
Tasks are host callbacks (script, timers, I/O, events). After each one finishes, the host drains the microtask queue (promise reactions, await continuations, queueMicrotask, and in Node first nextTick) completely before the next task or a render. That's why promise callbacks always run before a `setTimeout(0)` queued at the same time, and why endless microtask chains starve I/O.

---

## 2. Closures and their memory implications

A closure is a function together with its **lexical environment** (a reference to the scope record it was created in, not a copy of it).

V8 detail that leads to leaks: **every closure created in the same scope shares one context object**. If one closure references a large variable, that variable stays alive for as long as **any** sibling closure is alive.

```js
function attach() {
  const huge = new Array(1e6).fill('x');
  const unused = () => huge.length;         // references huge
  return () => console.log('tick');         // doesn't, but shares the context
}
setInterval(attach(), 1000);                 // huge is retained (V8 shared context)
```

Classic interview question: `var` in loops.

```js
for (var i = 0; i < 3; i++) setTimeout(() => console.log(i)); // 3 3 3
for (let i = 0; i < 3; i++) setTimeout(() => console.log(i)); // 0 1 2 (fresh binding per iteration)
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`RealtimePublisher`](../../packages/backend/libs/infrastructure/realtime/realtime-publisher.service.ts#L13): RealtimePublisher keeps a bounded per-connection replay buffer, the closure and leak concern, as the pattern map notes for infrastructure/realtime. _(realtime-publisher.service.ts)_
<!-- theory-links:end -->

---

## 3. `this` binding rules (in precedence order)

1. **`new`** binds to the newly created object.
2. **Explicit**: `call`, `apply`, `bind`. Once a function is bound, `bind` cannot rebind it.
3. **Implicit**: `obj.method()` binds `this` to `obj`. The binding is **lost** when you extract the method: `const f = obj.method; f()`.
4. **Default**: `undefined` in strict mode (which includes ES modules and classes), `globalThis` in sloppy mode.
5. **Arrow functions** have no `this` of their own. They capture it lexically, ignore `call`/`bind`, and can't be used with `new`.

Practical consequence: class methods passed as callbacks (`emitter.on('x', this.handle)`) lose `this`. Fix it with arrow class fields (`handle = () => {}`). Note that this creates **one function per instance** instead of one on the prototype, a small memory trade-off.

---

## 4. Prototypes and classes

- Every object has `[[Prototype]]`. Property lookup walks the chain.
- `class` is mostly syntactic sugar over constructor functions and prototypes, but there are real differences:
  - Class bodies are always strict, and classes are not hoisted the same way (they sit in the TDZ until declared).
  - `#private` fields are **truly private** (brand-checked, not just a naming convention). `#x in obj` is an ergonomic brand check.
  - `static` blocks run once at class evaluation.
- **Prototype pollution** (security): `merge(target, JSON.parse('{"__proto__":{"isAdmin":true}}'))` adds `isAdmin` to **every** object. Mitigations: `Object.create(null)` for dictionaries, use `Map`, reject `__proto__`/`constructor`/`prototype` keys, `--disable-proto=delete`, schema validation.

---

## 5. Promises in depth

### States and guarantees
- A promise is pending, then fulfilled or rejected, and it settles **once**. `then` callbacks are **always asynchronous** (microtasks), even when the promise is already resolved.
- Resolving with a thenable **adopts** its state. This costs extra microtask ticks, which is why `return await` and `return promise` once had different timings.

### Combinators: know which one to use

| Combinator | Resolves when | Rejects when | Use case |
|---|---|---|---|
| `Promise.all` | all fulfill | **first** rejection (others keep running!) | parallel, all required |
| `Promise.allSettled` | all settle | never | best-effort fan-out, partial results |
| `Promise.any` | first fulfills | all reject (`AggregateError`) | hedged requests / mirrors |
| `Promise.race` | first settles | first settles with rejection | timeouts (prefer `AbortSignal.timeout`) |

**Gotcha:** `Promise.all` does **not cancel** the other operations when one fails. If you need cancellation, pass a shared `AbortController` and abort it in a `catch`.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`settleWithConcurrency`](../../packages/backend/libs/common/core/promise-pool.ts#L31): settleWithConcurrency runs async work with bounded concurrency and never rejects, returning settled results, like allSettled. _(promise-pool.ts)_
> - [`ProductPageService`](../../packages/backend/libs/composition/bff/product-page.service.ts#L29): ProductPageService fans out in parallel to core with per-section timeouts so partial results can be returned. _(product-page.service.ts)_
<!-- theory-links:end -->

### Concurrency control (common live-coding question)

```ts
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;                 // safe: JS is single-threaded between awaits
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`mapWithConcurrency`](../../packages/backend/libs/common/core/promise-pool.ts#L6): mapWithConcurrency maps items through an async function with a bounded number of in-flight calls and preserves result order. _(promise-pool.ts)_
<!-- theory-links:end -->

### Error-handling traps
- `forEach(async ...)` doesn't await anything. Use `for...of` (sequential) or `Promise.all(map(...))` (parallel).
- Creating a promise and attaching `.catch` **later**, after an `await`, can trigger `unhandledRejection`, which crashes Node 15+:
  ```js
  const p1 = fetchA(); const p2 = fetchB();
  await p1;   // if p2 rejects meanwhile -> unhandled rejection -> process crash
  await p2;
  // Fix: await Promise.all([p1, p2])
  ```
- `try { return promise } catch {}` won't catch the rejection. `return await promise` will.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`installCrashHandlers`](../../packages/backend/libs/infrastructure/lifecycle/graceful-shutdown.ts#L88): installCrashHandlers installs unhandledRejection and uncaughtException handlers that log and force exit, which is the Node behaviour this section warns about. _(graceful-shutdown.ts)_ · [lifecycle](../../docs/humans/concepts/platform-lifecycle/lifecycle.md)
<!-- theory-links:end -->

---

## 6. Iterators, generators, async iteration

- Iterator protocol: `{ next(): { value, done } }`. Iterable: `[Symbol.iterator]()`.
- Generators are **lazy** and **pausable**. They work well for pagination and streaming:

```ts
async function* paginate(client: Api) {
  let cursor: string | undefined;
  do {
    const page = await client.list({ cursor });
    yield* page.items;
    cursor = page.nextCursor;
  } while (cursor);
}
for await (const item of paginate(api)) { /* constant memory */ }
```

- Node streams are async iterables. `for await` over a stream **respects backpressure**.
- Leaving a `for await` early (`break`/`throw`) calls `return()` on the iterator, which closes the underlying resource.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`streamStatementCsv`](../../packages/backend/libs/domains/statements/infra/statement-export.ts#L34): streamStatementCsv streams rows from a Postgres cursor into a Writable with backpressure. _(statement-export.ts)_
> - [`OrderExportService`](../../packages/backend/libs/domains/orders/application/order-export.service.ts#L28): OrderExportService streams orders to CSV in S3 with backpressure. _(order-export.service.ts)_
<!-- theory-links:end -->

---

## 7. Memory-related built-ins

- `WeakMap`/`WeakSet`: keys are held weakly. Good for attaching metadata to objects you don't own, such as caches keyed by request objects.
- `WeakRef` + `FinalizationRegistry`: non-deterministic. **Never** use them for correctness, only for caches and diagnostics.
- `structuredClone` deep-copies and supports Map, Set, Date, cycles, and typed arrays. It does **not** copy functions, class prototypes, or DOM nodes.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`FunctionSandbox`](../../packages/backend/libs/domains/shop-functions/infra/sandbox.ts#L26): FunctionSandbox runs untrusted seller JavaScript in isolated V8 sandboxes with memory caps and timeouts, an application of isolates and heap limits. _(sandbox.ts)_
<!-- theory-links:end -->

---

## 8. ESM vs CommonJS

| | CommonJS | ES Modules |
|---|---|---|
| Loading | sync `require` | async graph (parse → link → evaluate) |
| Bindings | **copies** of `module.exports` values | **live bindings** |
| Top-level await | no | yes |
| `__dirname` | yes | `import.meta.dirname` (Node 20.11+) |
| Static analysis / tree shaking | hard | yes |

- Interop: ESM can `import` CJS. CJS can `require()` ESM as of Node 22.12 / 20.19 (unflagged) **as long as the ESM graph has no top-level await**.
- `package.json` `"exports"` defines the public entry points, can provide conditional `import`/`require`/`types` targets, and blocks deep imports.
- Dual-package hazard: the same library loaded twice (once as CJS, once as ESM) gives you two singletons and breaks `instanceof`.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`refactor/phase2-entrypoints.ts`](../../packages/backend/scripts/refactor/phase2-entrypoints.ts): phase2-entrypoints.ts is a script that rewrites module imports. It does not cover ESM versus CommonJS bundling, so this ref is weak.
<!-- theory-links:end -->

---

## 9. Numbers and money

- Every JS number is an IEEE-754 double. `0.1 + 0.2 !== 0.3`. Safe integers stop at `2^53 - 1` (`Number.MAX_SAFE_INTEGER`).
- **Never store money as a float.** Options:
  - Integer minor units (cents) as `number` while values stay below 2^53, or as `bigint`.
  - A decimal library (`decimal.js`, `big.js`) with explicit rounding modes (banker's rounding, HALF_EVEN, for finance).
  - Postgres `numeric(19,4)`. Note that `pg` returns `numeric` as a **string** by default, which is intentional so precision isn't lost.
- Allocation problem: splitting $100 three ways gives 33.33 + 33.33 + 33.34. Use a **largest remainder** allocation so the parts sum exactly to the total. A common follow-up in fintech interviews.

```ts
function allocate(totalCents: bigint, weights: number[]): bigint[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  const raw = weights.map(w => (Number(totalCents) * w) / sum);
  const floored = raw.map(r => BigInt(Math.floor(r)));
  let remainder = totalCents - floored.reduce((a, b) => a + b, 0n);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) { if (remainder === 0n) break; floored[i]++; remainder--; }
  return floored;
}
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`allocate`](../../packages/backend/libs/common/money/allocate.ts#L10): allocate splits an integer-cents total by weights using the largest-remainder method so the sum is exact. _(allocate.ts)_ · [money](../../docs/humans/concepts/common-money/money.md)
> - [Signed BIGINT amount in cents: positive = credit, negative = debit](../../docs/humans/concepts/domain-payments/ledger-amount-convention.md): The ledger amount is a signed BIGINT in cents, so money is never stored as a float. [`amount`](../../packages/backend/libs/domains/payments/infra/models/ledger-entry.model.ts#L50)
<!-- theory-links:end -->

---

## 10. Dates and time zones

- `Date` is a UTC timestamp. Its *display* follows local time. Store `timestamptz` in Postgres and work in UTC.
- Business logic like "end of month for the client in Kyiv" needs a **time-zone-aware** library (`date-fns-tz`, `Luxon`) or **Temporal** (now shipping in modern engines; polyfill elsewhere).
- DST traps: "add 1 day" is not the same as "add 24 hours". Monthly periods: Jan 31 + 1 month = ?

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`nextFireAt`](../../packages/backend/libs/infrastructure/jobs/cron.ts#L9): nextFireAt computes the next cron fire time in the schedule's own time zone. _(cron.ts)_
> - [`quietHoursEnd`](../../packages/backend/libs/domains/notifications/domain/quiet-hours.ts#L19): quietHoursEnd computes when a notification quiet window ends in the user's time zone. _(quiet-hours.ts)_
> - [`addPeriod`](../../packages/backend/libs/domains/billing/domain/periods.ts#L12): addPeriod computes the next billing period end from an anchor day, handling month-end anchors. _(periods.ts)_
<!-- theory-links:end -->

---

## 11. Proxy/Reflect, Symbols

- `Proxy` intercepts operations. ORMs, MobX/Immer-style libraries, and validation layers use it. Immer (which Redux Toolkit uses) relies on Proxies to turn "mutations" into immutable updates.
- Well-known symbols: `Symbol.iterator`, `Symbol.asyncIterator`, `Symbol.toPrimitive`. `Symbol.dispose`/`Symbol.asyncDispose` work with `using` (explicit resource management, TS 5.2+, now in V8).

```ts
await using conn = await pool.connect(); // conn[Symbol.asyncDispose]() runs at scope exit
```

---

## Interview Q&A

**Q: Why does `await` inside `forEach` not work?**
`forEach` ignores the returned promises. The callbacks start, but nothing waits for them, and their rejections become unhandled.

**Q: What's the difference between microtasks and macrotasks?**
Macrotasks are host callbacks: timers, I/O, `setImmediate`. Microtasks are promise reactions and `queueMicrotask`. The microtask queue is fully drained after every macrotask (and in Node, between each individual timer or immediate callback since v11), so a flood of microtasks can starve I/O.

**Q: How would you implement a timeout for a fetch?**
`fetch(url, { signal: AbortSignal.timeout(2000) })`. To combine it with a user cancel, use `AbortSignal.any([userSignal, AbortSignal.timeout(2000)])`. `Promise.race` doesn't cancel the underlying request, so the socket stays busy.

**Q: How do you represent money in JS?**
As integer minor units (or `bigint`), or with a decimal library that has explicit rounding, stored as Postgres `numeric`. Don't use floats. Use largest-remainder allocation for splits.
