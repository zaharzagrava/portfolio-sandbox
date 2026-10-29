# Fetch, Axios, Async Error Handling and Async Patterns

When consuming APIs in Node.js or the browser, the two most common libraries are the native `fetch` (now built into Node.js 18+) and `axios`. Sections 3–11 cover the promise patterns that live-coding rounds ask you to implement.

---

## 1. Fetch vs Axios

### `fetch`
The native `fetch` API only rejects its Promise if there is a **network error** (e.g., DNS lookup failure, connection refused, or the user is offline). 
It **does not reject** on HTTP error statuses (like `404 Not Found` or `500 Internal Server Error`).

```javascript
// Native fetch requires manual ok checking
const response = await fetch('https://api.example.com/weather?q=Seoul');

if (!response.ok) { // response.ok is true for 200-299 status codes
  const errorData = await response.json();
  throw new Error(errorData.message || 'API request failed');
}

const data = await response.json();
```

### `axios`
`axios` automatically rejects its Promise for any HTTP status code outside the `2xx` range. This makes it more ergonomic for error handling, as `404` and `500` errors will immediately jump to your `catch` block.

```javascript
try {
  // Axios automatically throws on 404
  const response = await axios.get('https://api.example.com/weather?q=Seoul');
  console.log(response.data); 
} catch (error) {
  // Axios attaches the response object to the error
  const message = error.response?.data?.message || 'city not found';
  throw new Error(message);
}
```

---

## 2. Async/Await Error Handling Patterns

### The standard `try/catch`
When you mark a function as `async`, any error thrown inside it (or any awaited Promise that rejects) automatically results in the async function returning a rejected Promise.

```javascript
async function getWeather(city) {
  if (!city) {
    // This is identical to: return Promise.reject(new Error('empty city'))
    throw new Error('empty city');
  }

  try {
    const res = await axios.get(`.../?q=${city}`);
    return res.data; 
  } catch (err) {
    // We catch the axios error and throw a custom one
    throw new Error(err.response?.data?.message || 'Server error');
  }
}
```

### The "Go-style" tuple wrapper
A common pattern in modern JS/TS codebases to avoid deep `try/catch` nesting is to use a wrapper utility that returns a tuple of `[error, data]`, similar to Golang.

```javascript
async function to(promise) {
  return promise
    .then(data => [null, data])
    .catch(err => [err, null]);
}

async function getWeather(city) {
  const [err, res] = await to(axios.get(`.../?q=${city}`));
  
  if (err) {
    throw new Error(err.response?.data?.message);
  }
  
  return res.data;
}
```

When `await`ed code runs relative to `.then` callbacks and timers: see [event loop ordering](../02-nodejs/01-event-loop-and-runtime.md#2-event-loop-phases-libuv). Retry with backoff: see [resilience §2](../06-distributed-systems/03-resilience-patterns.md#2-retries-done-right).

---

## 3. Promise combinators

| | Settles when | Result | Empty input |
|---|---|---|---|
| `Promise.all` | all fulfill, or the **first rejection** | values in **input order** | `[]` |
| `Promise.allSettled` | all settle; **never rejects** | `{ status, value \| reason }` per input | `[]` |
| `Promise.race` | the **first to settle** (fulfill or reject) | that value/reason | stays pending forever |
| `Promise.any` | the **first fulfillment**; rejects only if all reject | value, or `AggregateError` (errors in input order) | rejects at once |

None of them cancels the losers: the other operations keep running. To stop them, pass one `AbortSignal` to all of them and abort it (§6).

Reference implementations. Each one relies on two facts: `Promise.resolve(x)` accepts plain values and thenables, and a promise settles only once, so later `resolve`/`reject` calls are ignored.
```js
function all(values) {
  return new Promise((resolve, reject) => {
    const items = [...values], results = new Array(items.length);
    let left = items.length;
    if (left === 0) return resolve(results);
    items.forEach((item, i) =>
      Promise.resolve(item).then((v) => { results[i] = v; if (--left === 0) resolve(results); }, reject));
  });
}
// any is the mirror image: resolve on the first success, collect errors by index,
// and when the count reaches 0, reject(new AggregateError(errors, 'All promises were rejected')).

const race = (values) => new Promise((resolve, reject) => {
  for (const item of values) Promise.resolve(item).then(resolve, reject);
});
const allSettled = (values) => Promise.all([...values].map((item) => Promise.resolve(item).then(
  (value) => ({ status: 'fulfilled', value }),
  (reason) => ({ status: 'rejected', reason }))));
```
Traps: storing results in completion order instead of by index; forgetting the empty-input case. Drills: [node-07](../practice/live-coding/02-nodejs.md#node-07), [node-08](../practice/live-coding/02-nodejs.md#node-08), [node-10](../practice/live-coding/02-nodejs.md#node-10); the `Promise` class itself ([how it works](01-javascript-internals.md#8-promises-in-depth)): [node-09](../practice/live-coding/02-nodejs.md#node-09).

---

## 4. Callback APIs to promises: `promisify`

A Node-style callback is `(err, result) => void`, passed as the last argument. `util.promisify` (or the `fs/promises` APIs) wraps it; the hand-written version:
```js
function promisify(fn) {
  return function (...args) {             // regular function: keeps `this` for methods
    return new Promise((resolve, reject) => {
      fn.call(this, ...args, (err, result) => (err ? reject(err) : resolve(result)));
    });
  };
}
```
A synchronous throw inside `fn` becomes a rejection, because the Promise executor catches it. Callbacks with several results (`(err, a, b)`) need a custom mapping; `util.promisify.custom` lets a function provide its own promise version. Drill: [node-11](../practice/live-coding/02-nodejs.md#node-11).

---

## 5. Sequential vs parallel

- `items.forEach(async (x) => { await save(x); })` is a bug: `forEach` ignores the returned promises, so it starts every save and returns at once, and any rejection is unhandled.
- **Sequential** (order matters, or each step needs the previous one; total time = sum): `for (const x of items) await save(x);`
- **Parallel** (independent; total time = slowest): `await Promise.all(items.map(save))`. `map(async ...)` alone only gives an array of promises; you still have to await it.
- **Bounded parallel** for large lists: §7.
- Starting promises early and awaiting them one by one can crash the process with an unhandled rejection: see [error handling §2](../02-nodejs/04-error-handling-and-graceful-shutdown.md#2-async-error-propagation-rules).

Drill: [node-21](../practice/live-coding/02-nodejs.md#node-21).

---

## 6. Cancellation and timeouts: `AbortController`

A promise can't be cancelled. Cancellation is a separate signal: `AbortController` creates it, `controller.abort(reason)` fires it, and the work receives `controller.signal` (an `AbortSignal`) and stops itself. `fetch`, streams (`pipeline`), `events.once`, `node:timers/promises` and most DB drivers accept `{ signal }`.

- `signal.aborted`, `signal.reason` (an `AbortError` DOMException by default, or whatever was passed to `abort(reason)`), `signal.throwIfAborted()`.
- `AbortSignal.timeout(ms)` aborts with a `TimeoutError` (its timer does not keep the process alive). `AbortSignal.any([a, b])` aborts when either does, e.g. caller's signal + deadline.
- Check the signal **between** steps (`throwIfAborted()`) and also **pass it down** so the current step stops. Checking only between steps lets one slow step run on.
- Always remove the `'abort'` listener when the work finishes. A long-lived signal (one per request) otherwise collects listeners: a leak plus `MaxListenersExceededWarning`.
- **Per-request deadline and disconnect** (server side): one controller per request, passed to the handler. A deadline timer aborts it and replies `503` if nothing was sent yet; `res.on('close', () => { if (!res.writableFinished) ac.abort(); })` aborts it when the client goes away. `'close'` fires on a normal finish too, so clear the timer there. Once the signal is aborted, ignore the handler's rejection; a second response would throw `ERR_HTTP_HEADERS_SENT`. Drill: [node-12](../practice/live-coding/02-nodejs.md#node-12).

Abortable sleep (built in as `setTimeout` from `node:timers/promises`):
```js
function sleep(ms, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
```

Timeout around any task. A plain `Promise.race` with a timer only stops *waiting*; aborting the signal also stops the *work*:
```js
async function withTimeout(task, ms) {          // task: (signal) => Promise
  const ac = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = Object.assign(new Error(`Timed out after ${ms} ms`), { name: 'TimeoutError' });
      ac.abort(err);
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([task(ac.signal), timeout]);
  } finally {
    clearTimeout(timer);                         // a pending timer keeps the process alive
  }
}
```
Drills: [node-13](../practice/live-coding/02-nodejs.md#node-13), [node-45](../practice/live-coding/02-nodejs.md#node-45).

---

## 7. Limiting concurrency

`Promise.all(items.map(fn))` starts everything at once and can exhaust DB connections or hit rate limits. Fixed batches of N are better but each batch waits for its slowest item. A **worker pool** starts the next item as soon as a slot frees up (`p-limit`, `p-map` in real code):
```js
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;                                  // shared cursor; next++ can't race (one JS thread)
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
```
`Promise.all` rejects with the first error; add a `failed` flag checked in the `while` to stop starting new items after it.

**Mutex.** Node runs one piece of JS at a time, but every `await` lets other code run, so read-modify-write across an `await` is a race. A mutex runs critical sections one after another (FIFO) by chaining them on a promise:
```js
class Mutex {
  #last = Promise.resolve();
  run(fn) {
    const result = this.#last.then(fn);
    this.#last = result.catch(() => {});         // a failure must not block later callers; the caller still sees it
    return result;
  }
}
```
It only protects one process. With several instances, use the database: atomic `UPDATE … SET balance = balance + $1`, row locks, optimistic locking with a version column, or a distributed lock.

**Semaphore**: at most `max` holders at once (a mutex is a semaphore with `max = 1`; a connection pool is a semaphore that hands out connections instead of permits):
```js
class Semaphore {
  #free; #waiters = [];
  constructor(max) { this.#free = max; }
  async acquire() {
    if (this.#free > 0) this.#free--;
    else await new Promise((r) => this.#waiters.push(r));
    let released = false;
    return () => {                               // release; idempotent
      if (released) return;
      released = true;
      const next = this.#waiters.shift();
      next ? next() : this.#free++;              // hand the permit straight to a waiter, so no one jumps the queue
    };
  }
  async use(fn) {
    const release = await this.acquire();
    try { return await fn(); } finally { release(); }   // a throw never leaks a permit
  }
}
```

**Async task queue** = semaphore + FIFO of jobs: `add(task)` returns a promise for that task's result, a `drain` step starts jobs while `running < concurrency` (and the queue is not paused), and each finished job (in `finally`, so failures count too) calls `drain` again. Extras: `onIdle()`, priorities (a heap instead of a FIFO), per-task timeouts so a stuck task frees its slot. `array.shift()` is O(n); use a head index for very large queues.

Drills: [node-15](../practice/live-coding/02-nodejs.md#node-15), [node-16](../practice/live-coding/02-nodejs.md#node-16), [node-17](../practice/live-coding/02-nodejs.md#node-17), [node-18](../practice/live-coding/02-nodejs.md#node-18).

---

## 8. Sharing and caching promises

Cache the **promise**, not the value: callers that arrive while the work is still running then share it. Caching only the resolved value does nothing for concurrent callers.

**In-flight dedupe** (also called request coalescing or single-flight; stops a cache stampede on the DB):
```js
const inFlight = new Map();
function dedupe(key, fn) {
  let p = inFlight.get(key);
  if (!p) {
    p = fn().finally(() => inFlight.delete(key));   // next call fetches fresh data; failures aren't kept
    inFlight.set(key, p);
  }
  return p;
}
```
If callers can cancel, abort the shared work only when every waiting caller has given up (reference count).

**Async memoize with TTL** adds expiry on top:
```js
function memoizeAsync(fn, ttlMs, now = Date.now) {   // injectable clock → deterministic tests
  const cache = new Map();                            // key -> { promise, expiresAt }
  return (key) => {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now()) return hit.promise;
    const entry = { promise: fn(key), expiresAt: Infinity };     // in flight: never expires
    cache.set(key, entry);
    entry.promise.then(
      () => { entry.expiresAt = now() + ttlMs; },                  // TTL starts at completion
      () => { if (cache.get(key) === entry) cache.delete(key); },  // drop failures, unless already replaced
    );
    return entry.promise;
  };
}
```
An unbounded Map is a memory leak: add a max size (LRU) or a sweep. **Stale-while-revalidate**: after the TTL, return the old value at once and refresh in the background; block only when there is no value. Drills: [node-19](../practice/live-coding/02-nodejs.md#node-19), [node-20](../practice/live-coding/02-nodejs.md#node-20).

---

## 9. Batching

**DataLoader** (fixes N+1 in GraphQL resolvers): every `load(key)` made in the same tick goes into one queue; the first one schedules a single dispatch with `process.nextTick`, which calls `batchFn(keys)` once.
```js
class DataLoader {
  #batchFn; #queue = new Map(); #cache = new Map();   // Map queue also dedupes keys
  constructor(batchFn) { this.#batchFn = batchFn; }
  load(key) {
    if (this.#cache.has(key)) return this.#cache.get(key);
    const p = new Promise((resolve, reject) => {
      if (this.#queue.size === 0) process.nextTick(() => this.#dispatch());
      this.#queue.set(key, { resolve, reject });
    });
    this.#cache.set(key, p);
    return p;
  }
  async #dispatch() {
    const batch = this.#queue;
    this.#queue = new Map();
    const keys = [...batch.keys()];
    try {
      const values = await this.#batchFn(keys);       // contract: same length and order as keys
      keys.forEach((k, i) => values[i] instanceof Error
        ? (this.#cache.delete(k), batch.get(k).reject(values[i]))
        : batch.get(k).resolve(values[i]));
    } catch (err) {
      for (const [k, { reject }] of batch) { this.#cache.delete(k); reject(err); }
    }
  }
}
```
`batchFn` must map DB rows back to keys by id (filling gaps with Errors). Create **one loader per request**: the cache has no TTL and no auth context, so a global one serves stale data and can leak data between users.

**Batch by size or time** (bulk inserts, log shipping): the first item starts a timer; reaching `maxSize` flushes at once. So latency ≤ `maxWaitMs` and batch size ≤ `maxSize`.
- Swap in a fresh array **before** calling `flush`, so new items never join a batch that is being written.
- Give each caller a promise tied to its batch, so a failed write reaches the right callers.
- Clear the timer on a size flush, or it will flush the next batch early.
- `close()` flushes the rest and awaits in-flight writes; call it during graceful shutdown.
- If the sink is down, bound memory: cap buffered items and make `add` wait (backpressure) or drop and count.

Drills: [node-24](../practice/live-coding/02-nodejs.md#node-24), [node-49](../practice/live-coding/02-nodejs.md#node-49).

---

## 10. Async generators and `for await`

An `async function*` can `await` and `yield`; the consumer reads it with `for await`. It is lazy: the next value is computed only when the consumer asks for it, and `break` calls the generator's `return()`, which stops it and runs its `finally`. Classic use is hiding cursor pagination:
```js
async function* paginate(fetchPage) {
  let cursor;
  do {
    const page = await fetchPage(cursor);   // fetched only when the consumer needs more
    yield* page.items;
    cursor = page.nextCursor;
  } while (cursor);
}
for await (const user of paginate(listUsers)) { if (done(user)) break; }
```
Memory stays at one page. To hide page latency, prefetch the next page while the current one is consumed (respecting rate limits). Node streams are async iterables too: see [streams §9](../02-nodejs/02-streams-and-backpressure.md#9-async-iteration-readline-readablefrom-directory-walk). Drill: [node-23](../practice/live-coding/02-nodejs.md#node-23).

---

## 11. Debounce and throttle

- **Debounce**: run once after calls stop for `wait` ms (search-as-you-type, autosave). Each call stores the latest args and restarts the timer. `cancel()` clears it; `flush()` runs the pending call now (e.g. before shutdown).
- **Throttle**: run at most once per `interval` during continuous activity (progress updates, scroll). Leading call runs at once; calls inside the interval only replace the saved args; when the interval ends, the saved call runs (trailing) **and starts a new interval**, so two runs are always ≥ `interval` apart.
- **Rate limiter** (different tool): decides per request whether to allow it and rejects (429) or queues the rest. See [API design §3](../04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md#3-rate-limiting-as-provider).
- Trap: creating a new debounced function per call (e.g. inside a request handler) gives each call its own timer, so nothing is debounced.

```js
function debounce(fn, waitMs) {
  let timer, lastArgs;
  const debounced = (...args) => { lastArgs = args; clearTimeout(timer); timer = setTimeout(debounced.flush, waitMs); };
  debounced.cancel = () => { clearTimeout(timer); lastArgs = undefined; };
  debounced.flush = () => {
    clearTimeout(timer);
    if (lastArgs) { const a = lastArgs; lastArgs = undefined; fn(...a); }
  };
  return debounced;
}

function throttle(fn, intervalMs) {
  let timer = null, pending = null;
  const startInterval = () => {
    timer = setTimeout(() => {
      timer = null;
      if (pending) { const a = pending; pending = null; fn(...a); startInterval(); }  // trailing
    }, intervalMs);
  };
  return (...args) => {
    if (timer) { pending = args; return; }
    fn(...args);                                                                       // leading
    startInterval();
  };
}
```
Drills: [node-25](../practice/live-coding/02-nodejs.md#node-25), [node-26](../practice/live-coding/02-nodejs.md#node-26).

---

## Interview Q&A

**Q: Why does `fetch('https://google.com/404')` resolve instead of reject?**
A: `fetch` only rejects on network failures (like being offline). It considers receiving an HTTP response—even an error like 404 or 500—to be a successful network transaction. You must manually check `response.ok` or `response.status` to handle HTTP errors.

**Q: In an `async` function, what is the difference between `throw new Error()` and `return Promise.reject(new Error())`?**
A: Functionally, there is no difference from the caller's perspective. The `async` keyword ensures that any thrown exception is implicitly caught and converted into a rejected Promise. However, `throw new Error()` is generally preferred as it is more idiomatic synchronous-looking syntax.

**Q: Does `Promise.all` cancel the other promises when one rejects?**
A: No. Promises can't be cancelled; the other operations keep running. Pass one `AbortSignal` to all of them and abort it on the first failure.

**Q: `Promise.race` vs `Promise.any`?**
A: `race` settles with whichever input settles first, even a rejection. `any` waits for the first fulfillment and rejects with an `AggregateError` only if every input rejects. Empty input: `race` hangs forever, `any` rejects at once.

**Q: How do you process 10,000 items against an API that allows 5 concurrent requests?**
A: A worker pool: start 5 workers sharing a cursor; each takes the next index, awaits the call, stores the result by index, and loops. Better than fixed batches of 5, where one slow item stalls the batch. In production, `p-limit` plus a rate limiter if the API also caps requests per second.

**Q: Node is single-threaded. Why would you ever need a mutex?**
A: Every `await` is a point where other requests run, so `read → await → write` can interleave and lose updates. An in-process mutex serializes that section. Across several instances it doesn't help; use atomic DB updates, row locks, or optimistic locking.

**Q: Why cache the promise instead of the value?**
A: Callers that arrive while the first request is still running get the same promise, so the work runs once. Remove the entry when it rejects, so errors aren't cached.

**Q: Debounce vs throttle?**
A: Debounce waits for a pause and runs once at the end. Throttle runs at most once per interval while activity continues.
