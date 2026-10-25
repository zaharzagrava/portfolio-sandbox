# Node.js live-coding drills

50 problems most likely to come up in Full Stack Node.js live-coding rounds. Try each one before opening the solution. Every solution was run against the tests shown.

Difficulty: Easy 20 · Medium 23 · Hard 7

## Index

| # | Problem | Topic | Level |
|---|---|---|---|
| node-01 | [Sync vs setTimeout vs Promise.then](#node-01) | Event loop | Easy |
| node-02 | [nextTick, microtasks, timers and setImmediate](#node-02) | Event loop | Medium |
| node-03 | [async/await ordering](#node-03) | Event loop | Medium |
| node-04 | [Nested timers and microtasks inside timers](#node-04) | Event loop | Medium |
| node-05 | [setImmediate vs setTimeout inside an I/O callback](#node-05) | Event loop | Medium |
| node-06 | [process.nextTick starvation](#node-06) | Event loop | Hard |
| node-07 | [Implement Promise.all](#node-07) | Promises | Easy |
| node-08 | [Implement Promise.allSettled](#node-08) | Promises | Easy |
| node-09 | [Implement Promise.race](#node-09) | Promises | Easy |
| node-10 | [Implement Promise.any](#node-10) | Promises | Medium |
| node-11 | [Promisify a callback API](#node-11) | Promises | Easy |
| node-12 | [Abortable sleep](#node-12) | Promises | Easy |
| node-13 | [withTimeout for async operations](#node-13) | Promises | Easy |
| node-14 | [Retry with exponential backoff and jitter](#node-14) | Promises | Medium |
| node-15 | [Map with a concurrency limit](#node-15) | Concurrency | Medium |
| node-16 | [Async task queue with concurrency](#node-16) | Concurrency | Hard |
| node-17 | [Async mutex](#node-17) | Concurrency | Easy |
| node-18 | [Counting semaphore](#node-18) | Concurrency | Medium |
| node-19 | [Dedupe concurrent calls (in-flight cache)](#node-19) | Promises | Easy |
| node-20 | [Async memoize with TTL](#node-20) | Promises | Medium |
| node-21 | [forEach + await bug: sequential vs parallel](#node-21) | Async patterns | Easy |
| node-22 | [Unhandled rejection when starting promises early](#node-22) | Error handling | Medium |
| node-23 | [Async generator for cursor pagination](#node-23) | Async iteration | Medium |
| node-24 | [DataLoader-style batching](#node-24) | Batching | Hard |
| node-25 | [Debounce with cancel and flush](#node-25) | Timing | Easy |
| node-26 | [Throttle with leading and trailing calls](#node-26) | Timing | Medium |
| node-27 | [Token bucket rate limiter](#node-27) | Rate limiting | Medium |
| node-28 | [Sliding window rate limiter](#node-28) | Rate limiting | Medium |
| node-29 | [Implement an EventEmitter](#node-29) | Events | Medium |
| node-30 | [Wait for an event with a promise](#node-30) | Events | Easy |
| node-31 | [Uppercase Transform stream](#node-31) | Streams | Easy |
| node-32 | [Parse JSON Lines with a Transform stream](#node-32) | Streams | Medium |
| node-33 | [Copy a stream with backpressure](#node-33) | Streams | Hard |
| node-34 | [Read a large file line by line](#node-34) | Streams | Easy |
| node-35 | [Stream a CSV and aggregate](#node-35) | Streams | Medium |
| node-36 | [Readable.from and generator pipelines](#node-36) | Streams | Easy |
| node-37 | [Count bytes and lines in a stream](#node-37) | Streams | Easy |
| node-38 | [Minimal JSON API with node:http](#node-38) | HTTP | Medium |
| node-39 | [Express-style middleware chain](#node-39) | Middleware | Medium |
| node-40 | [Graceful shutdown](#node-40) | Reliability | Hard |
| node-41 | [Circuit breaker](#node-41) | Reliability | Hard |
| node-42 | [Idempotency-Key middleware](#node-42) | Middleware | Hard |
| node-43 | [Verify an HMAC webhook signature](#node-43) | Security | Medium |
| node-44 | [Hash and verify passwords with scrypt](#node-44) | Security | Easy |
| node-45 | [Cancel a long async job with AbortController](#node-45) | Cancellation | Medium |
| node-46 | [Offload CPU work to a worker thread](#node-46) | worker_threads | Medium |
| node-47 | [Base64, base64url and decoding a JWT payload](#node-47) | Buffer | Easy |
| node-48 | [Walk a directory tree recursively](#node-48) | File system | Easy |
| node-49 | [Batch writes by size or time](#node-49) | Batching | Medium |
| node-50 | [Request context with AsyncLocalStorage](#node-50) | AsyncLocalStorage | Easy |

---

<a id="node-01"></a>
### node-01. Sync vs setTimeout vs Promise.then

*Event loop · Easy*

What does this print, and why?

```js
console.log('A');
setTimeout(() => console.log('B'), 0);
Promise.resolve().then(() => console.log('C'));
console.log('D');
```

**Starter**

```ts
// Write down the order you expect, then explain each step.
```

<details>
<summary>Solution</summary>

```ts
// The snippet, with `log` injectable so the order can be captured.
export function puzzle(log: (msg: string) => void = console.log) {
  log('A');
  setTimeout(() => log('B'), 0);
  Promise.resolve().then(() => log('C'));
  log('D');
}
```

**Why it works.** Prints `A, D, C, B`. Synchronous code runs to completion first (A, D). When the call stack is empty, the microtask queue (promise callbacks) is drained before the event loop moves on, so C runs next. B is a macrotask in the timers phase, which only runs on a later loop turn, even with a 0 ms delay. The trap is thinking `setTimeout(fn, 0)` means "run immediately".

**Say it.** Sync code runs first, then all microtasks like promise callbacks, and only then the event loop picks up timers, so a 0 ms timeout always runs after a resolved promise.

**Follow-up.** Q: Would `setTimeout(fn, 0)` ever fire in less than 1 ms? A: No. Node clamps 0 to 1 ms, and the callback also waits for the current stack and all microtasks to finish.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

const out: string[] = [];
puzzle((m) => out.push(m));
assert.deepEqual(out, ['A', 'D']);
await new Promise((r) => setTimeout(r, 20));
assert.deepEqual(out, ['A', 'D', 'C', 'B']);
```

</details>

</details>

---

<a id="node-02"></a>
### node-02. nextTick, microtasks, timers and setImmediate

*Event loop · Medium*

What does this print (CommonJS module, Node 22)? Which part of the order is not guaranteed?

```js
console.log('start');
setTimeout(() => console.log('timeout'), 0);
setImmediate(() => console.log('immediate'));
Promise.resolve().then(() => console.log('promise'));
queueMicrotask(() => console.log('microtask'));
process.nextTick(() => console.log('nextTick'));
console.log('end');
```

**Starter**

```ts
// Predict the order. Mark which lines could swap between runs.
```

<details>
<summary>Solution</summary>

```ts
export function puzzle(log: (msg: string) => void = console.log) {
  log('start');
  setTimeout(() => log('timeout'), 0);
  setImmediate(() => log('immediate'));
  Promise.resolve().then(() => log('promise'));
  queueMicrotask(() => log('microtask'));
  process.nextTick(() => log('nextTick'));
  log('end');
}
```

**Why it works.** Prints `start, end, nextTick, promise, microtask`, then `timeout` and `immediate` in either order. After the sync code, Node drains the `process.nextTick` queue first, then the promise microtask queue (`.then` and `queueMicrotask` share it, FIFO). From the main module, `setTimeout(0)` vs `setImmediate` depends on whether 1 ms has passed when the loop starts, so it is non-deterministic. Trap: in an ES module the top level already runs inside a microtask, so `promise` can print before `nextTick` there.

**Say it.** Sync first, then the nextTick queue, then promise microtasks in FIFO order; timeout versus immediate from the main module is a race, so I wouldn't rely on it.

**Follow-up.** Q: How do you make timeout vs immediate deterministic? A: Schedule them inside an I/O callback: after the poll phase the check phase (setImmediate) always comes before the next timers phase.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

const out: string[] = [];
// Run from a macrotask so nextTick/microtask ordering matches a CommonJS top level.
setImmediate(() => puzzle((m) => out.push(m)));
await new Promise((r) => setTimeout(r, 30));
assert.deepEqual(out.slice(0, 5), ['start', 'end', 'nextTick', 'promise', 'microtask']);
assert.deepEqual([...out.slice(5)].sort(), ['immediate', 'timeout']);
assert.equal(out.length, 7);
```

</details>

</details>

---

<a id="node-03"></a>
### node-03. async/await ordering

*Event loop · Medium*

What does this print?

```js
async function a1() {
  console.log('a1 start');
  await a2();
  console.log('a1 end');
}
async function a2() { console.log('a2'); }

console.log('script start');
setTimeout(() => console.log('setTimeout'), 0);
a1();
new Promise((resolve) => {
  console.log('p1');
  resolve();
}).then(() => console.log('then1'));
console.log('script end');
```

**Starter**

```ts
// Predict the order and explain where each `await` splits the function.
```

<details>
<summary>Solution</summary>

```ts
export function puzzle(log: (msg: string) => void = console.log) {
  async function a1() {
    log('a1 start');
    await a2();
    log('a1 end');
  }
  async function a2() {
    log('a2');
  }

  log('script start');
  setTimeout(() => log('setTimeout'), 0);
  a1();
  new Promise<void>((resolve) => {
    log('p1');
    resolve();
  }).then(() => log('then1'));
  log('script end');
}
```

**Why it works.** Prints `script start, a1 start, a2, p1, script end, a1 end, then1, setTimeout`. An async function runs synchronously until its first `await`, so `a1 start` and `a2` print immediately. The code after `await` becomes a microtask, queued before `then1` because `a1` was called first. The Promise executor runs synchronously (`p1`). The timer is a macrotask and comes last. Trap: thinking `async` makes the whole function body asynchronous.

**Say it.** An async function is synchronous up to its first await; the rest is a microtask continuation, so it is ordered with other promise callbacks and always before timers.

**Follow-up.** Q: What changes if `a2` returns a non-native thenable or a promise from another async function? A: Awaiting a native promise costs one microtask hop; resolving with a thenable adds extra hops, so its continuation can move later relative to other `.then` callbacks.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

const out: string[] = [];
puzzle((m) => out.push(m));
await new Promise((r) => setTimeout(r, 20));
assert.deepEqual(out, [
  'script start', 'a1 start', 'a2', 'p1', 'script end', 'a1 end', 'then1', 'setTimeout',
]);
```

</details>

</details>

---

<a id="node-04"></a>
### node-04. Nested timers and microtasks inside timers

*Event loop · Medium*

What does this print in Node 22?

```js
setTimeout(() => {
  console.log('t1');
  Promise.resolve().then(() => console.log('t1 micro'));
  process.nextTick(() => console.log('t1 tick'));
}, 0);
setTimeout(() => {
  console.log('t2');
  setTimeout(() => console.log('t2 nested'), 0);
}, 0);
Promise.resolve().then(() => {
  console.log('micro');
  setTimeout(() => console.log('micro timeout'), 0);
});
```

**Starter**

```ts
// Predict the order. Hint: what happens between two timer callbacks?
```

<details>
<summary>Solution</summary>

```ts
export function puzzle(log: (msg: string) => void = console.log) {
  setTimeout(() => {
    log('t1');
    Promise.resolve().then(() => log('t1 micro'));
    process.nextTick(() => log('t1 tick'));
  }, 0);
  setTimeout(() => {
    log('t2');
    setTimeout(() => log('t2 nested'), 0);
  }, 0);
  Promise.resolve().then(() => {
    log('micro');
    setTimeout(() => log('micro timeout'), 0);
  });
}
```

**Why it works.** Prints `micro, t1, t1 tick, t1 micro, t2, micro timeout, t2 nested`. The microtask runs before any timer and schedules `micro timeout` before the loop starts, so it is due in the same timers phase as t1 and t2. Since Node 11, nextTicks and microtasks are drained after each individual timer callback (tick before promise), so `t1 tick`/`t1 micro` come before `t2`. A timer created while timers are being processed (`t2 nested`) is not due yet and waits for the next loop turn.

**Say it.** Between every macrotask callback Node drains nextTick then microtasks, and a timer scheduled during the timers phase runs on the next turn, not the current one.

**Follow-up.** Q: Was this different in old Node versions? A: Before Node 11, all expired timers ran as a batch and microtasks ran only after the whole phase, so `t2` would print before `t1 tick`. Node now matches browser behavior.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

const out: string[] = [];
puzzle((m) => out.push(m));
await new Promise((r) => setTimeout(r, 50));
assert.deepEqual(out, ['micro', 't1', 't1 tick', 't1 micro', 't2', 'micro timeout', 't2 nested']);
```

</details>

</details>

---

<a id="node-05"></a>
### node-05. setImmediate vs setTimeout inside an I/O callback

*Event loop · Medium*

What does this print? Is the order guaranteed?

```js
const fs = require('fs');
fs.readFile(__filename, () => {
  setTimeout(() => console.log('timeout'), 0);
  setImmediate(() => console.log('immediate'));
  process.nextTick(() => console.log('nextTick'));
});
```

**Starter**

```ts
// Predict the order and name the event loop phases involved.
```

<details>
<summary>Solution</summary>

```ts
import { readFile } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function puzzle(log: (msg: string) => void = console.log, onDone?: () => void) {
  readFile(fileURLToPath(import.meta.url), () => {
    setTimeout(() => {
      log('timeout');
      onDone?.();
    }, 0);
    setImmediate(() => log('immediate'));
    process.nextTick(() => log('nextTick'));
  });
}
```

**Why it works.** Always prints `nextTick, immediate, timeout`. The readFile callback runs in the poll phase. When it returns, the nextTick queue is drained. The next phase is check, where `setImmediate` callbacks run; the timers phase only comes on the next loop turn. So inside an I/O callback, setImmediate always beats `setTimeout(0)`. From the main module the same pair is a race.

**Say it.** I/O callbacks run in the poll phase and the check phase comes right after it, so setImmediate is guaranteed to run before a zero-delay timer there.

**Follow-up.** Q: When would you use setImmediate over process.nextTick? A: Use setImmediate to yield to I/O (it runs after the poll phase); nextTick runs before anything else and can starve I/O if used recursively.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

for (let i = 0; i < 3; i++) {
  const out: string[] = [];
  await new Promise<void>((resolve) => puzzle((m) => out.push(m), resolve));
  assert.deepEqual(out, ['nextTick', 'immediate', 'timeout']);
}
```

</details>

</details>

---

<a id="node-06"></a>
### node-06. process.nextTick starvation

*Event loop · Hard*

1. Run inside an I/O callback, what does this print?
2. What happens if `tick` reschedules itself forever? Fix it so a long loop of work does not block timers and I/O.

```js
let count = 0;
setTimeout(() => console.log('timeout'), 0);
setImmediate(() => console.log('immediate'));
Promise.resolve().then(() => console.log('promise'));
function tick() {
  count++;
  console.log('tick ' + count);
  if (count < 3) process.nextTick(tick);
}
process.nextTick(tick);
```

Write `processInChunks(items, chunkSize, fn)` that yields to the event loop between chunks.

**Starter**

```ts
export function processInChunks<T>(items: T[], chunkSize: number, fn: (item: T) => void): Promise<void> {
  // TODO: process synchronously in chunks, yielding to the event loop between chunks
  throw new Error('not implemented');
}
```

<details>
<summary>Solution</summary>

```ts
export function puzzle(log: (msg: string) => void = console.log) {
  let count = 0;
  setTimeout(() => log('timeout'), 0);
  setImmediate(() => log('immediate'));
  Promise.resolve().then(() => log('promise'));
  function tick() {
    count++;
    log('tick ' + count);
    if (count < 3) process.nextTick(tick);
  }
  process.nextTick(tick);
}

// Fix: yield with setImmediate (runs after I/O), never with recursive nextTick.
export function processInChunks<T>(items: T[], chunkSize: number, fn: (item: T) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let i = 0;
    const runChunk = () => {
      try {
        const end = Math.min(i + chunkSize, items.length);
        for (; i < end; i++) fn(items[i]);
        if (i < items.length) setImmediate(runChunk);
        else resolve();
      } catch (err) {
        reject(err);
      }
    };
    runChunk();
  });
}
```

**Why it works.** Prints `tick 1, tick 2, tick 3, promise, immediate, timeout`. Node drains the whole nextTick queue, including ticks added while draining, before promise microtasks and before the loop can continue. A nextTick that always reschedules itself never lets the loop reach any phase: timers, I/O and even promises starve. The fix is to split work into chunks and yield with `setImmediate`, which runs once per loop turn after I/O, so other callbacks interleave.

**Say it.** The nextTick queue is drained completely, including newly added ticks, so recursive nextTick starves the event loop; I chunk the work and yield with setImmediate instead.

**Follow-up.** Q: Chunking still runs on the main thread. When is it not enough? A: For heavy CPU work it only improves fairness, not throughput or latency; move it to worker_threads or a separate service.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
import { readFile as rf } from 'node:fs';

const out: string[] = [];
await new Promise<void>((resolve) => {
  rf(import.meta.filename, () => {
    puzzle((m) => out.push(m));
    setTimeout(resolve, 20);
  });
});
assert.deepEqual(out, ['tick 1', 'tick 2', 'tick 3', 'promise', 'immediate', 'timeout']);

// A 0 ms timer must get a chance to run while the chunked work is in progress.
let timerFiredAt = -1;
let processed = 0;
setTimeout(() => { timerFiredAt = processed; }, 0);
const items = Array.from({ length: 200_000 }, (_, i) => i);
await processInChunks(items, 1000, () => {
  processed++;
  for (let k = 0; k < 50; k++) Math.sqrt(k);
});
assert.equal(processed, 200_000);
assert.ok(timerFiredAt >= 0 && timerFiredAt < 200_000, 'timer should fire before work finishes');
await processInChunks([], 10, () => assert.fail('should not be called'));
```

</details>

</details>

---

<a id="node-07"></a>
### node-07. Implement Promise.all

*Promises · Easy*

Implement `promiseAll(values)` that behaves like `Promise.all`: resolves with results in input order, rejects with the first rejection, and accepts plain values too.

```ts
await promiseAll([1, Promise.resolve(2), delay(10, 3)]) // [1, 2, 3]
await promiseAll([])                                    // []
await promiseAll([Promise.reject(new Error('x')), 1])   // rejects with Error('x')
```

**Starter**

```ts
export function promiseAll<T>(values: Iterable<T | PromiseLike<T>>): Promise<T[]> {
  // TODO
  throw new Error('not implemented');
}
```

<details>
<summary>Solution</summary>

```ts
export function promiseAll<T>(values: Iterable<T | PromiseLike<T>>): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const items = Array.from(values);
    const results: T[] = new Array(items.length);
    let remaining = items.length;
    if (remaining === 0) return resolve(results);

    items.forEach((item, index) => {
      Promise.resolve(item).then((value) => {
        results[index] = value; // keep input order, not completion order
        if (--remaining === 0) resolve(results);
      }, reject);
    });
  });
}
```

**Why it works.** Wrap each item with `Promise.resolve` so plain values and thenables work, store each result at its original index, and count remaining items to know when all are done. The first rejection calls `reject`; later calls to resolve/reject are ignored because a promise settles only once. Traps: pushing results in completion order, and forgetting that an empty input must resolve immediately with `[]`.

**Say it.** I resolve each input with Promise.resolve, write results by index, count down to zero to resolve, and reject on the first failure since a promise can only settle once.

**Follow-up.** Q: Does Promise.all cancel the other promises when one rejects? A: No. Promises are not cancellable; the other operations keep running. Use an AbortController to actually stop them.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

const delay = <T>(ms: number, v: T) => new Promise<T>((r) => setTimeout(() => r(v), ms));
assert.deepEqual(await promiseAll([1, Promise.resolve(2), delay(10, 3)]), [1, 2, 3]);
assert.deepEqual(await promiseAll([delay(30, 'slow'), delay(5, 'fast')]), ['slow', 'fast']);
assert.deepEqual(await promiseAll([]), []);
await assert.rejects(promiseAll([delay(20, 1), Promise.reject(new Error('x'))]), /x/);
assert.deepEqual(await promiseAll(new Set([4, 5])), [4, 5]);
```

</details>

</details>

---

<a id="node-08"></a>
### node-08. Implement Promise.allSettled

*Promises · Easy*

Implement `allSettled(values)` like `Promise.allSettled`: it never rejects, and resolves with one result object per input, in order.

```ts
await allSettled([Promise.resolve(1), Promise.reject(new Error('no'))])
// [{ status: 'fulfilled', value: 1 }, { status: 'rejected', reason: Error('no') }]
```

**Starter**

```ts
type Settled<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown };

export function allSettled<T>(values: Iterable<T | PromiseLike<T>>): Promise<Settled<T>[]> {
  // TODO
  throw new Error('not implemented');
}
```

<details>
<summary>Solution</summary>

```ts
type Settled<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown };

export function allSettled<T>(values: Iterable<T | PromiseLike<T>>): Promise<Settled<T>[]> {
  // Map every input to a promise that always fulfills, then reuse Promise.all.
  const wrapped = Array.from(values, (item) =>
    Promise.resolve(item).then(
      (value): Settled<T> => ({ status: 'fulfilled', value }),
      (reason): Settled<T> => ({ status: 'rejected', reason }),
    ),
  );
  return Promise.all(wrapped);
}
```

**Why it works.** Turn each input into a promise that always fulfills with a status object, by handling both outcomes in `.then(onFulfilled, onRejected)`. Then `Promise.all` cannot reject and keeps input order. This is the right tool when you want every result, for example sending notifications to many users and reporting which failed. Trap: using `.catch` after `.then` would also catch errors thrown inside your own mapping code.

**Say it.** I map every promise to one that always fulfills with a status object, then Promise.all over those, so order is kept and nothing rejects.

**Follow-up.** Q: How would you get just the failures with their inputs? A: Zip results with inputs by index and filter `status === 'rejected'`, e.g. to retry only failed items.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

const err = new Error('no');
const res = await allSettled([Promise.resolve(1), Promise.reject(err), 3]);
assert.deepEqual(res, [
  { status: 'fulfilled', value: 1 },
  { status: 'rejected', reason: err },
  { status: 'fulfilled', value: 3 },
]);
assert.deepEqual(await allSettled([]), []);
const slow = new Promise((r) => setTimeout(() => r('late'), 15));
assert.deepEqual((await allSettled([slow]))[0], { status: 'fulfilled', value: 'late' });
```

</details>

</details>

---

<a id="node-09"></a>
### node-09. Implement Promise.race

*Promises · Easy*

Implement `race(values)` like `Promise.race`: settle the same way as the first input that settles (fulfilled or rejected). An empty input stays pending forever.

```ts
await race([delay(30, 'slow'), delay(10, 'fast')]) // 'fast'
await race([delay(30, 'ok'), rejectAfter(10)])     // rejects
await race([5, delay(10, 1)])                      // 5
```

**Starter**

```ts
export function race<T>(values: Iterable<T | PromiseLike<T>>): Promise<T> {
  // TODO
  throw new Error('not implemented');
}
```

<details>
<summary>Solution</summary>

```ts
export function race<T>(values: Iterable<T | PromiseLike<T>>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    for (const item of values) {
      // The first one to call resolve/reject wins; later calls are ignored.
      Promise.resolve(item).then(resolve, reject);
    }
  });
}
```

**Why it works.** Subscribe `resolve` and `reject` of one outer promise to every input. Whichever input settles first settles the outer promise, and later calls are no-ops because a promise settles only once. Plain values are wrapped with `Promise.resolve`, so they win over pending promises (on the next microtask). Common use: timeouts via racing against a timer. Trap: the losers keep running, and a losing timer should be cleared.

**Say it.** I attach the outer promise's resolve and reject to every input; the first to settle wins because a promise can only settle once.

**Follow-up.** Q: What is the difference between race and any? A: race settles with the first settled result, even a rejection; any waits for the first fulfillment and rejects only if all reject (AggregateError).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

const delay = <T>(ms: number, v: T) => new Promise<T>((r) => setTimeout(() => r(v), ms));
const rejectAfter = (ms: number) => new Promise<never>((_, j) => setTimeout(() => j(new Error('boom')), ms));
assert.equal(await race([delay(30, 'slow'), delay(10, 'fast')]), 'fast');
await assert.rejects(race([delay(30, 'ok'), rejectAfter(10)]), /boom/);
assert.equal(await race([5, delay(10, 1)]), 5);
const pending = race([]);
const winner = await Promise.race([pending, delay(20, 'still pending')]);
assert.equal(winner, 'still pending');
```

</details>

</details>

---

<a id="node-10"></a>
### node-10. Implement Promise.any

*Promises · Medium*

Implement `any(values)` like `Promise.any`: resolve with the first fulfilled value; if all inputs reject (or the input is empty), reject with an `AggregateError` whose `errors` are in input order.

```ts
await any([rejectAfter(5), delay(20, 'b'), delay(10, 'c')]) // 'c'
await any([Promise.reject(1), Promise.reject(2)])          // AggregateError, errors [1, 2]
```

**Starter**

```ts
export function any<T>(values: Iterable<T | PromiseLike<T>>): Promise<T> {
  // TODO
  throw new Error('not implemented');
}
```

<details>
<summary>Solution</summary>

```ts
export function any<T>(values: Iterable<T | PromiseLike<T>>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const items = Array.from(values);
    const errors: unknown[] = new Array(items.length);
    let remaining = items.length;
    if (remaining === 0) {
      return reject(new AggregateError([], 'All promises were rejected'));
    }
    items.forEach((item, index) => {
      Promise.resolve(item).then(resolve, (reason) => {
        errors[index] = reason;
        if (--remaining === 0) reject(new AggregateError(errors, 'All promises were rejected'));
      });
    });
  });
}
```

**Why it works.** It is the mirror image of `Promise.all`: the first fulfillment resolves, and rejections are collected by index while counting down. Only when every input rejected do we reject with an `AggregateError`. Empty input rejects immediately, unlike `race`, which stays pending. Useful for "fastest healthy replica" or fallback mirrors. Trap: storing errors in completion order instead of input order.

**Say it.** Any is the inverse of all: resolve on the first success, collect failures by index, and reject with an AggregateError only when every input has failed.

**Follow-up.** Q: With any over several HTTP mirrors, what happens to the slower requests? A: They keep running; pass one AbortController signal to all of them and abort it once the first succeeds.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

const delay = <T>(ms: number, v: T) => new Promise<T>((r) => setTimeout(() => r(v), ms));
const rejectAfter = (ms: number, why: unknown) => new Promise<never>((_, j) => setTimeout(() => j(why), ms));
assert.equal(await any([rejectAfter(5, 'a'), delay(20, 'b'), delay(10, 'c')]), 'c');
await assert.rejects(any([rejectAfter(10, 1), Promise.reject(2)]), (e: unknown) => {
  assert.ok(e instanceof AggregateError);
  assert.deepEqual(e.errors, [1, 2]);
  return true;
});
await assert.rejects(any([]), AggregateError);
assert.equal(await any([Promise.reject(new Error('x')), 7]), 7);
```

</details>

</details>

---

<a id="node-11"></a>
### node-11. Promisify a callback API

*Promises · Easy*

Implement `promisify(fn)` for Node-style callback functions (`(err, result) => void` as the last argument). The returned function must keep `this` and pass all arguments through.

```ts
const readConfig = (name, cb) => cb(null, { name });
await promisify(readConfig)('app')  // { name: 'app' }
// cb(new Error('ENOENT')) -> the promise rejects with that error
```

**Starter**

```ts
type Callback<R> = (err: unknown, result?: R) => void;

export function promisify<A extends unknown[], R>(
  fn: (...args: [...A, Callback<R>]) => void,
): (...args: A) => Promise<R> {
  // TODO
  throw new Error('not implemented');
}
```

<details>
<summary>Solution</summary>

```ts
type Callback<R> = (err: unknown, result?: R) => void;

export function promisify<A extends unknown[], R>(
  fn: (...args: [...A, Callback<R>]) => void,
): (...args: A) => Promise<R> {
  return function (this: unknown, ...args: A): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      const callback: Callback<R> = (err, result) => {
        if (err) reject(err);
        else resolve(result as R);
      };
      // Keep `this` so methods like obj.method still work.
      fn.call(this, ...args, callback);
    });
  };
}
```

**Why it works.** Return a function that creates a promise and calls the original with an extra callback appended. The callback rejects on a truthy `err` and resolves with the result otherwise. Using a regular `function` and `fn.call(this, ...)` keeps method calls working. If `fn` throws synchronously, the Promise executor turns that into a rejection. In real code, use `util.promisify` from `node:util` or the `fs/promises` APIs.

**Say it.** I return a wrapper that builds a promise and appends a Node-style callback that rejects on error and resolves otherwise, calling the original with the same this.

**Follow-up.** Q: What about callbacks that pass multiple results, like `(err, a, b)`? A: Resolve with an array or object; `util.promisify` supports this via the `util.promisify.custom` symbol (e.g. `dns.lookup` returns `{ address, family }`).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

const readConfig = (name: string, cb: Callback<{ name: string }>) => setTimeout(() => cb(null, { name }), 5);
assert.deepEqual(await promisify(readConfig)('app'), { name: 'app' });

const failing = (cb: Callback<number>) => cb(new Error('ENOENT'));
await assert.rejects(promisify(failing)(), /ENOENT/);

const obj = {
  factor: 3,
  times(n: number, cb: Callback<number>) { cb(null, n * this.factor); },
};
const times = promisify(obj.times);
assert.equal(await times.call(obj, 4), 12);

const throwsSync = (_cb: Callback<number>) => { throw new Error('sync'); };
await assert.rejects(promisify(throwsSync)(), /sync/);
```

</details>

</details>

---

<a id="node-12"></a>
### node-12. Abortable sleep

*Promises · Easy*

Write `sleep(ms, { signal })` that resolves after `ms` milliseconds. If the optional `AbortSignal` is aborted (before or during the wait), clear the timer and reject with `signal.reason`.

```ts
await sleep(20)                       // resolves after ~20 ms
const ac = new AbortController();
const p = sleep(1000, { signal: ac.signal });
ac.abort();                           // p rejects with an AbortError right away
```

**Starter**

```ts
export function sleep(ms: number, opts: { signal?: AbortSignal } = {}): Promise<void> {
  // TODO
  throw new Error('not implemented');
}
```

<details>
<summary>Solution</summary>

```ts
export function sleep(ms: number, opts: { signal?: AbortSignal } = {}): Promise<void> {
  const { signal } = opts;
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);

    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
```

**Why it works.** The basic version is `new Promise(r => setTimeout(r, ms))`. Supporting cancellation means checking `signal.aborted` first, listening for `abort` to clear the timer and reject, and removing the listener when the timer fires so long-lived signals do not leak listeners. `signal.reason` is an `AbortError` DOMException by default, or whatever was passed to `abort(reason)`. Node also ships this as `setTimeout` from `node:timers/promises`.

**Say it.** I wrap setTimeout in a promise, reject immediately if the signal is already aborted, and on abort I clear the timer and reject with the signal's reason, cleaning up the listener either way.

**Follow-up.** Q: Why remove the abort listener after the timer fires? A: A shared signal (say, one per request) can outlive many sleeps; leaving listeners attached leaks memory and triggers MaxListenersExceeded warnings.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

const t0 = Date.now();
await sleep(20);
assert.ok(Date.now() - t0 >= 15);

const ac = new AbortController();
const p = sleep(1000, { signal: ac.signal });
const t1 = Date.now();
ac.abort();
await assert.rejects(p, { name: 'AbortError' });
assert.ok(Date.now() - t1 < 100);

await assert.rejects(sleep(10, { signal: AbortSignal.abort(new Error('already')) }), /already/);

const shared = new AbortController();
await sleep(5, { signal: shared.signal });
// Aborting after completion must not throw or reject anything.
shared.abort();
```

</details>

</details>

---

<a id="node-13"></a>
### node-13. withTimeout for async operations

*Promises · Easy*

Write `withTimeout(task, ms)` where `task` receives an `AbortSignal`. If the task does not finish in `ms`, abort it and reject with an error named `TimeoutError`. Always clear the timer.

```ts
await withTimeout((signal) => fetchUser(1, signal), 50)   // user, if fast enough
await withTimeout((signal) => slowQuery(signal), 20)      // rejects TimeoutError, slowQuery is aborted
```

**Starter**

```ts
export function withTimeout<T>(task: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  // TODO
  throw new Error('not implemented');
}
```

<details>
<summary>Solution</summary>

```ts
export class TimeoutError extends Error {
  name = 'TimeoutError';
}

export async function withTimeout<T>(task: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new TimeoutError(`Timed out after ${ms} ms`);
      controller.abort(err); // tell the task to stop its work
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([task(controller.signal), timeout]);
  } finally {
    clearTimeout(timer); // otherwise a pending timer keeps the process alive
  }
}
```

**Why it works.** Race the task against a timer promise. On timeout, abort the controller so the underlying work (fetch, DB query, stream) really stops instead of running in the background, then reject. The `finally` clears the timer on success so it does not hold the process open or fire later. Trap: a plain `Promise.race` with `setTimeout` only stops waiting; it does not cancel anything.

**Say it.** I race the task against a timer, and on timeout I abort the signal I passed to the task so the work actually stops; finally always clears the timer.

**Follow-up.** Q: Is there a built-in way? A: Yes: `AbortSignal.timeout(ms)` gives a signal that aborts with a TimeoutError, and `AbortSignal.any([userSignal, AbortSignal.timeout(ms)])` combines it with a caller's signal; e.g. `fetch(url, { signal: AbortSignal.timeout(5000) })`.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

const work = (ms: number, value: string) => (signal: AbortSignal) =>
  new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => resolve(value), ms);
    signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); });
  });

assert.equal(await withTimeout(work(5, 'fast'), 100), 'fast');

let seenSignal: AbortSignal | undefined;
await assert.rejects(
  withTimeout((s) => { seenSignal = s; return work(500, 'slow')(s); }, 20),
  { name: 'TimeoutError' },
);
assert.equal(seenSignal?.aborted, true);

await assert.rejects(withTimeout(async () => { throw new Error('task failed'); }, 100), /task failed/);
```

</details>

</details>

---

<a id="node-14"></a>
### node-14. Retry with exponential backoff and jitter

*Promises · Medium*

Write `retry(fn, options)` that calls `fn` until it succeeds, up to `maxAttempts` total attempts. Retry only errors where `isRetryable(err)` is true; rethrow others immediately. Wait between attempts with exponential backoff and full jitter: `delay = random() * min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))`. Make `sleep` and `random` injectable for tests.

```ts
// fails twice with 503, then succeeds -> returns the result after 3 calls
// fails with 400 -> throws at once, 1 call
```

**Starter**

```ts
export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  isRetryable?: (err: unknown) => boolean;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export async function retry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  // TODO
  throw new Error('not implemented');
}
```

<details>
<summary>Solution</summary>

```ts
export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  isRetryable?: (err: unknown) => boolean;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export async function retry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const {
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
    isRetryable = () => true,
    random = Math.random,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = options;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= maxAttempts || !isRetryable(err)) throw err;
      const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      await sleep(random() * cap); // full jitter spreads retries from many clients
    }
  }
}
```

**Why it works.** A loop with `try { return await fn() }` retries on failure. Exponential backoff gives a struggling service time to recover, the cap stops delays from growing without limit, and jitter avoids a thundering herd where all clients retry at the same moment. Only retry transient errors (timeouts, 429, 5xx, ECONNRESET); a 400 or validation error will fail again. Trap: `return fn()` without `await` inside `try` lets the rejection escape the catch.

**Say it.** I loop up to maxAttempts, rethrow immediately for non-retryable errors or on the last attempt, and otherwise sleep a random fraction of a capped exponential delay.

**Follow-up.** Q: Is it safe to retry a POST that charges a card? A: Only if the operation is idempotent, e.g. the client sends an Idempotency-Key so the server can return the stored result instead of charging twice.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

class HttpError extends Error {
  status: number;
  constructor(status: number) { super(`HTTP ${status}`); this.status = status; }
}
const isRetryable = (e: unknown) => e instanceof HttpError && (e.status === 429 || e.status >= 500);
const delays: number[] = [];
const opts = {
  maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 300, isRetryable,
  random: () => 1, sleep: async (ms: number) => { delays.push(ms); },
};

let calls = 0;
const result = await retry(async () => {
  calls++;
  if (calls < 4) throw new HttpError(503);
  return 'ok';
}, opts);
assert.equal(result, 'ok');
assert.equal(calls, 4);
assert.deepEqual(delays, [100, 200, 300]); // capped at maxDelayMs

calls = 0;
await assert.rejects(retry(async () => { calls++; throw new HttpError(400); }, opts), /HTTP 400/);
assert.equal(calls, 1);

calls = 0;
await assert.rejects(retry(async () => { calls++; throw new HttpError(500); }, { ...opts, maxAttempts: 3 }), /HTTP 500/);
assert.equal(calls, 3);

const jittered: number[] = [];
await retry(async (a) => { if (a < 2) throw new HttpError(503); return 1; },
  { ...opts, random: () => 0.5, sleep: async (ms: number) => { jittered.push(ms); } });
assert.deepEqual(jittered, [50]);
```

</details>

</details>

---

<a id="node-15"></a>
### node-15. Map with a concurrency limit

*Concurrency · Medium*

Write `mapLimit(items, limit, fn)` that runs async `fn` over `items` with at most `limit` calls in flight at once. Results must be in input order. If any call fails, reject with that error and do not start new items.

```ts
await mapLimit([1, 2, 3, 4, 5], 2, async (n) => n * 2) // [2, 4, 6, 8, 10], max 2 running at a time
```

**Starter**

```ts
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  // TODO
  throw new Error('not implemented');
}
```

<details>
<summary>Solution</summary>

```ts
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;

  // Each worker pulls the next index until the list is exhausted.
  async function worker() {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index], index);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}
```

**Why it works.** Start `limit` workers that share a cursor. Each takes the next index, awaits `fn`, stores the result at that index and loops. Because JavaScript is single-threaded, `next++` cannot race. A failure sets a flag so no new work starts, and `Promise.all` rejects with the first error. Trap: `Promise.all(items.map(fn))` starts everything at once and can exhaust DB connections or hit API rate limits. Chunking in fixed batches also works but is slower, since each batch waits for its slowest item.

**Say it.** I start N workers that pull indexes from a shared counter, so there are never more than N calls in flight, and I store results by index to keep order.

**Follow-up.** Q: Why not split into batches of N and Promise.all each batch? A: One slow item stalls the whole batch; the worker pool starts a new item as soon as any slot frees up.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

let active = 0;
let maxActive = 0;
const res = await mapLimit([30, 10, 20, 5, 15], 2, async (ms, i) => {
  active++;
  maxActive = Math.max(maxActive, active);
  await new Promise((r) => setTimeout(r, ms));
  active--;
  return `${i}:${ms}`;
});
assert.deepEqual(res, ['0:30', '1:10', '2:20', '3:5', '4:15']);
assert.equal(maxActive, 2);
assert.deepEqual(await mapLimit([], 3, async (x) => x), []);

const started: number[] = [];
await assert.rejects(
  mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
    started.push(n);
    await new Promise((r) => setTimeout(r, 5));
    if (n === 2) throw new Error('bad item 2');
    return n;
  }),
  /bad item 2/,
);
assert.ok(started.length < 6, 'should stop starting new items after a failure');
```

</details>

</details>

---

<a id="node-16"></a>
### node-16. Async task queue with concurrency

*Concurrency · Hard*

Build a `TaskQueue` with a concurrency limit.
- `add(task)` returns a promise for that task's result (or error).
- `onIdle()` resolves when the queue is empty and nothing is running.
- `pause()` stops starting new tasks; `resume()` continues.
- `size` (waiting) and `pending` (running) getters.

```ts
const q = new TaskQueue(2);
const results = await Promise.all([q.add(() => job(1)), q.add(() => job(2)), q.add(() => job(3))]);
// never more than 2 jobs run at once
```

**Starter**

```ts
export class TaskQueue {
  constructor(concurrency: number) {
    // TODO
  }
  add<T>(task: () => Promise<T>): Promise<T> {
    throw new Error('not implemented');
  }
  onIdle(): Promise<void> { throw new Error('not implemented'); }
  pause(): void {}
  resume(): void {}
  get size(): number { return 0; }
  get pending(): number { return 0; }
}
```

<details>
<summary>Solution</summary>

```ts
type Job = () => Promise<void>;

export class TaskQueue {
  #concurrency: number;
  #queue: Job[] = [];
  #running = 0;
  #paused = false;
  #idleWaiters: (() => void)[] = [];

  constructor(concurrency: number) {
    if (concurrency < 1) throw new RangeError('concurrency must be >= 1');
    this.#concurrency = concurrency;
  }

  get size() { return this.#queue.length; }
  get pending() { return this.#running; }

  add<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // Wrap the task so the queue never sees its result or error.
      this.#queue.push(async () => {
        try {
          resolve(await task());
        } catch (err) {
          reject(err);
        }
      });
      this.#drain();
    });
  }

  pause() { this.#paused = true; }

  resume() {
    this.#paused = false;
    this.#drain();
  }

  onIdle(): Promise<void> {
    if (this.#running === 0 && this.#queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  #drain() {
    while (!this.#paused && this.#running < this.#concurrency && this.#queue.length > 0) {
      const job = this.#queue.shift()!;
      this.#running++;
      job().finally(() => {
        this.#running--;
        this.#drain();
        if (this.#running === 0 && this.#queue.length === 0) {
          this.#idleWaiters.splice(0).forEach((resolve) => resolve());
        }
      });
    }
  }
}
```

**Why it works.** Each `add` wraps the task in a job that settles the caller's promise, so one failing task cannot break the queue. `#drain` starts jobs while there is free capacity and the queue is not paused, and every finished job calls `#drain` again to pull the next one. Idle waiters are resolved when nothing is queued or running. Trap: forgetting to decrement `running` on failure (use `finally`), which slowly deadlocks the queue. `shift()` is O(n); for very large queues use a linked list or a head index.

**Say it.** Tasks are wrapped so the caller gets their own promise, a drain loop starts work while running is below the limit, and each completion decrements in finally and drains again.

**Follow-up.** Q: How would you add priorities or per-task timeouts? A: Keep a priority queue (heap or one array per priority) instead of a FIFO, and wrap each task with withTimeout plus an AbortSignal so a stuck task frees its slot.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

const q = new TaskQueue(2);
let active = 0;
let maxActive = 0;
const job = (v: number, ms: number) => async () => {
  active++;
  maxActive = Math.max(maxActive, active);
  await new Promise((r) => setTimeout(r, ms));
  active--;
  return v;
};
const all = Promise.all([q.add(job(1, 20)), q.add(job(2, 5)), q.add(job(3, 10)), q.add(job(4, 5))]);
assert.equal(q.pending, 2);
assert.equal(q.size, 2);
assert.deepEqual(await all, [1, 2, 3, 4]);
assert.equal(maxActive, 2);

await assert.rejects(q.add(async () => { throw new Error('task failed'); }), /task failed/);
assert.equal(await q.add(async () => 'still works'), 'still works');

q.pause();
const later = q.add(job(5, 1));
await new Promise((r) => setTimeout(r, 15));
assert.equal(q.size, 1);
assert.equal(q.pending, 0);
q.resume();
assert.equal(await later, 5);
await q.onIdle();
assert.equal(q.pending + q.size, 0);
```

</details>

</details>

---

<a id="node-17"></a>
### node-17. Async mutex

*Concurrency · Easy*

This code loses updates when called concurrently:

```ts
async function deposit(amount) {
  const balance = await db.getBalance();
  await db.setBalance(balance + amount);
}
await Promise.all([deposit(10), deposit(10)]); // balance +10, not +20
```

Implement a `Mutex` with `runExclusive(fn)` so critical sections run one at a time, in call order, even if one of them throws.

**Starter**

```ts
export class Mutex {
  runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    // TODO
    throw new Error('not implemented');
  }
}
```

<details>
<summary>Solution</summary>

```ts
export class Mutex {
  // Tail of the chain: resolves when the last queued section has finished.
  #last: Promise<void> = Promise.resolve();

  runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const result = this.#last.then(() => fn());
    // The next caller waits for this one, whether it succeeds or fails.
    this.#last = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
```

**Why it works.** Node is single-threaded, but every `await` is a point where other code can run, so read-modify-write across an `await` is a race. The mutex keeps a promise chain: each call runs after the previous one settles, and errors are swallowed only in the internal chain (the caller still gets them), so one failure does not block the rest. FIFO order comes for free. Trap: an in-process mutex does not help with several Node processes; then you need DB transactions, `SELECT ... FOR UPDATE`, atomic updates, or a distributed lock.

**Say it.** I chain every critical section onto the previous one's promise, so they run one at a time in order, and I keep the chain alive even if a section throws.

**Follow-up.** Q: How do you fix this in production with 4 Node instances? A: Make the DB do it: `UPDATE accounts SET balance = balance + $1`, a transaction with row locks, or optimistic locking with a version column.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

let balance = 0;
const db = {
  async get() { await new Promise((r) => setTimeout(r, 5)); return balance; },
  async set(v: number) { await new Promise((r) => setTimeout(r, 5)); balance = v; },
};
async function deposit(amount: number) {
  const b = await db.get();
  await db.set(b + amount);
}
await Promise.all([deposit(10), deposit(10), deposit(10)]);
assert.equal(balance, 10); // the race

balance = 0;
const mutex = new Mutex();
const order: number[] = [];
await Promise.all([1, 2, 3].map((i) => mutex.runExclusive(async () => { order.push(i); await deposit(10); })));
assert.equal(balance, 30);
assert.deepEqual(order, [1, 2, 3]);

await assert.rejects(mutex.runExclusive(() => { throw new Error('inside lock'); }), /inside lock/);
assert.equal(await mutex.runExclusive(() => 'next caller runs'), 'next caller runs');
```

</details>

</details>

---

<a id="node-18"></a>
### node-18. Counting semaphore

*Concurrency · Medium*

Implement a `Semaphore(max)` that allows at most `max` holders at a time.
- `acquire()` resolves with a `release` function when a permit is available (FIFO).
- Calling `release` twice must not free two permits.
- `use(fn)` acquires, runs `fn`, and always releases.

```ts
const sem = new Semaphore(3); // at most 3 concurrent DB queries
await sem.use(() => db.query(sql));
```

**Starter**

```ts
export class Semaphore {
  constructor(max: number) {}
  acquire(): Promise<() => void> { throw new Error('not implemented'); }
  use<T>(fn: () => Promise<T>): Promise<T> { throw new Error('not implemented'); }
}
```

<details>
<summary>Solution</summary>

```ts
export class Semaphore {
  #available: number;
  #waiters: (() => void)[] = [];

  constructor(max: number) {
    this.#available = max;
  }

  get available() { return this.#available; }

  async acquire(): Promise<() => void> {
    if (this.#available > 0) {
      this.#available--;
    } else {
      // The permit is handed over directly by release(), so `available` stays 0.
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#waiters.shift();
      if (next) next();
      else this.#available++;
    };
  }

  async use<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
```

**Why it works.** Keep a count of free permits and a FIFO of waiters. On release, hand the permit straight to the next waiter instead of incrementing the count, which prevents a newcomer from jumping the queue. The `released` flag makes release idempotent. `use` wraps the pattern in try/finally so an exception never leaks a permit. A mutex is a semaphore with `max = 1`.

**Say it.** I track free permits and a FIFO of waiters; release hands the permit directly to the next waiter, and use wraps acquire/release in try/finally so permits never leak.

**Follow-up.** Q: How is this different from a connection pool? A: A pool is a semaphore plus the resources themselves: acquire returns a connection object instead of a token, and it may also create, validate and evict connections.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

const sem = new Semaphore(2);
let active = 0;
let maxActive = 0;
const order: number[] = [];
await Promise.all([1, 2, 3, 4, 5].map((i) => sem.use(async () => {
  active++;
  maxActive = Math.max(maxActive, active);
  order.push(i);
  await new Promise((r) => setTimeout(r, 10));
  active--;
})));
assert.equal(maxActive, 2);
assert.deepEqual(order, [1, 2, 3, 4, 5]);
assert.equal(sem.available, 2);

const r1 = await sem.acquire();
r1();
r1(); // double release is a no-op
assert.equal(sem.available, 2);

await assert.rejects(sem.use(async () => { throw new Error('fail'); }), /fail/);
assert.equal(sem.available, 2);
```

</details>

</details>

---

<a id="node-19"></a>
### node-19. Dedupe concurrent calls (in-flight cache)

*Promises · Easy*

Many requests ask for the same user at once, and each triggers a DB query. Write `dedupe(fn)` that returns a wrapped function: concurrent calls with the same key share one in-flight promise. Once it settles (success or failure), the next call triggers a fresh request.

```ts
const getUser = dedupe((id) => db.findUser(id));
await Promise.all([getUser('1'), getUser('1'), getUser('2')]); // db.findUser called twice
```

**Starter**

```ts
export function dedupe<K, V>(fn: (key: K) => Promise<V>): (key: K) => Promise<V> {
  // TODO
  throw new Error('not implemented');
}
```

<details>
<summary>Solution</summary>

```ts
export function dedupe<K, V>(fn: (key: K) => Promise<V>): (key: K) => Promise<V> {
  const inFlight = new Map<K, Promise<V>>();
  return (key: K) => {
    const existing = inFlight.get(key);
    if (existing) return existing;

    const promise = fn(key).finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
  };
}
```

**Why it works.** Store the promise, not the value, in a Map keyed by the argument, so callers that arrive while the request is running get the same promise. `finally` removes the entry once it settles, so the next call fetches fresh data and a failure is not cached. This is also called request coalescing or the "single-flight" pattern; it protects the DB from cache stampedes. Trap: caching the resolved value instead of the promise does nothing for concurrent callers.

**Say it.** I keep a map from key to the in-flight promise, return it to concurrent callers, and delete it in finally so failures and stale results are not cached.

**Follow-up.** Q: What if the first caller's request is cancelled? A: Do not let one caller's AbortSignal cancel the shared request; abort it only when every waiting caller has given up (reference count).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

let calls = 0;
const getUser = dedupe(async (id: string) => {
  calls++;
  await new Promise((r) => setTimeout(r, 10));
  if (id === 'bad') throw new Error('not found');
  return { id };
});
const [a, b, c] = await Promise.all([getUser('1'), getUser('1'), getUser('2')]);
assert.equal(calls, 2);
assert.equal(a, b);
assert.deepEqual(c, { id: '2' });

await getUser('1');
assert.equal(calls, 3); // settled entries are not cached

const results = await Promise.allSettled([getUser('bad'), getUser('bad')]);
assert.equal(calls, 4);
assert.ok(results.every((r) => r.status === 'rejected'));
await assert.rejects(getUser('bad'), /not found/);
assert.equal(calls, 5);
```

</details>

</details>

---

<a id="node-20"></a>
### node-20. Async memoize with TTL

*Promises · Medium*

Write `memoizeAsync(fn, { ttlMs, now })`:
- Cache successful results per key for `ttlMs`.
- Concurrent calls for the same key share one in-flight call.
- Do not cache failures.
- `now` is an injectable clock (default `Date.now`).
- Return `{ get, invalidate }`.

```ts
const prices = memoizeAsync(fetchPrice, { ttlMs: 60_000 });
await prices.get('BTC'); // calls fetchPrice
await prices.get('BTC'); // cached
// 61 s later -> calls fetchPrice again
```

**Starter**

```ts
export function memoizeAsync<K, V>(
  fn: (key: K) => Promise<V>,
  opts: { ttlMs: number; now?: () => number },
): { get(key: K): Promise<V>; invalidate(key: K): void } {
  // TODO
  throw new Error('not implemented');
}
```

<details>
<summary>Solution</summary>

```ts
export function memoizeAsync<K, V>(
  fn: (key: K) => Promise<V>,
  opts: { ttlMs: number; now?: () => number },
): { get(key: K): Promise<V>; invalidate(key: K): void } {
  const { ttlMs, now = Date.now } = opts;
  // Entries hold the promise; expiresAt is set once it fulfills.
  const cache = new Map<K, { promise: Promise<V>; expiresAt: number }>();

  function get(key: K): Promise<V> {
    const hit = cache.get(key);
    if (hit && now() < hit.expiresAt) return hit.promise;

    const entry = { promise: fn(key), expiresAt: Infinity }; // Infinity while in flight
    cache.set(key, entry);
    entry.promise.then(
      () => { entry.expiresAt = now() + ttlMs; },
      () => { if (cache.get(key) === entry) cache.delete(key); },
    );
    return entry.promise;
  }

  return {
    get,
    invalidate: (key: K) => { cache.delete(key); },
  };
}
```

**Why it works.** Cache the promise so concurrent callers share it, and treat an in-flight entry as never expiring. When it fulfills, start the TTL from the completion time; when it rejects, delete the entry so the next call retries, but only if it is still the same entry (it may have been invalidated and replaced). An injectable clock makes TTL tests deterministic without real waiting. Trap: an unbounded Map is a memory leak; in production add a max size (LRU) or a periodic sweep.

**Say it.** I cache the promise per key so concurrent calls share it, set the expiry when it resolves, drop it on rejection, and inject the clock so expiry is testable.

**Follow-up.** Q: What is stale-while-revalidate? A: After the TTL, return the stale value immediately and refresh it in the background, so callers never wait on a slow upstream; only block when there is no value at all.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

let t = 1000;
let calls = 0;
let fail = false;
const m = memoizeAsync(async (sym: string) => {
  calls++;
  await new Promise((r) => setTimeout(r, 5));
  if (fail) throw new Error('upstream down');
  return `${sym}:${calls}`;
}, { ttlMs: 100, now: () => t });

const [a, b] = await Promise.all([m.get('BTC'), m.get('BTC')]);
assert.equal(calls, 1);
assert.equal(a, b);
t += 50;
assert.equal(await m.get('BTC'), 'BTC:1');
t += 60; // past TTL
assert.equal(await m.get('BTC'), 'BTC:2');
m.invalidate('BTC');
assert.equal(await m.get('BTC'), 'BTC:3');

fail = true;
await assert.rejects(m.get('ETH'), /upstream down/);
fail = false;
assert.equal(await m.get('ETH'), 'ETH:5'); // the failure was not cached
```

</details>

</details>

---

<a id="node-21"></a>
### node-21. forEach + await bug: sequential vs parallel

*Async patterns · Easy*

This function is meant to save all orders and then return the count, but it returns `0` before anything is saved and errors go unhandled. Why? Fix it twice: `saveSequential` (one at a time, in order) and `saveParallel` (all at once).

```ts
async function saveAll(orders) {
  let saved = 0;
  orders.forEach(async (o) => {
    await db.save(o);
    saved++;
  });
  return saved;
}
```

**Starter**

```ts
export async function saveSequential<T>(items: T[], save: (item: T) => Promise<void>): Promise<number> {
  // TODO
  throw new Error('not implemented');
}

export async function saveParallel<T>(items: T[], save: (item: T) => Promise<void>): Promise<number> {
  // TODO
  throw new Error('not implemented');
}
```

<details>
<summary>Solution</summary>

```ts
export async function saveSequential<T>(items: T[], save: (item: T) => Promise<void>): Promise<number> {
  let saved = 0;
  for (const item of items) {
    await save(item); // waits before starting the next one
    saved++;
  }
  return saved;
}

export async function saveParallel<T>(items: T[], save: (item: T) => Promise<void>): Promise<number> {
  await Promise.all(items.map((item) => save(item)));
  return items.length;
}
```

**Why it works.** `forEach` ignores the promises returned by an async callback, so it starts every save and returns immediately; `saved` is still 0, and a rejection inside becomes an unhandled rejection that can crash the process. Use `for...of` with `await` when order matters or each step depends on the previous one (total time = sum). Use `Promise.all(items.map(...))` when the operations are independent (total time = slowest one). For large lists, limit concurrency instead of firing everything.

**Say it.** forEach doesn't await async callbacks, so I use for...of with await for sequential work, or map to promises and Promise.all for parallel work.

**Follow-up.** Q: Does `array.map(async ...)` alone fix it? A: No, it gives you an array of promises; you still have to await them with Promise.all (or allSettled).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

const log: string[] = [];
const save = async (ms: number) => {
  log.push(`start ${ms}`);
  await new Promise((r) => setTimeout(r, ms));
  log.push(`end ${ms}`);
};

assert.equal(await saveSequential([20, 5], save), 2);
assert.deepEqual(log, ['start 20', 'end 20', 'start 5', 'end 5']);

log.length = 0;
const t0 = Date.now();
assert.equal(await saveParallel([30, 30, 30], save), 3);
assert.ok(Date.now() - t0 < 80, 'parallel should take about as long as one save');
assert.deepEqual(log.slice(0, 3), ['start 30', 'start 30', 'start 30']);

await assert.rejects(saveSequential([1], async () => { throw new Error('db down'); }), /db down/);
await assert.rejects(saveParallel([1, 2], async (n) => { if (n === 2) throw new Error('db down'); }), /db down/);
```

</details>

</details>

---

<a id="node-22"></a>
### node-22. Unhandled rejection when starting promises early

*Error handling · Medium*

This handler sometimes crashes the process with an "unhandled rejection", even though the call is wrapped in try/catch. Explain why and fix `loadDashboard`.

```ts
async function loadDashboard(userId) {
  const userP = getUser(userId);     // takes 50 ms
  const ordersP = getOrders(userId); // fails after 5 ms
  const user = await userP;
  const orders = await ordersP;
  return { user, orders };
}
```

**Starter**

```ts
export async function loadDashboard<U, O>(
  getUser: () => Promise<U>,
  getOrders: () => Promise<O>,
): Promise<{ user: U; orders: O }> {
  // TODO: run both in parallel without risking an unhandled rejection
  throw new Error('not implemented');
}
```

<details>
<summary>Solution</summary>

```ts
export async function loadDashboard<U, O>(
  getUser: () => Promise<U>,
  getOrders: () => Promise<O>,
): Promise<{ user: U; orders: O }> {
  // Promise.all attaches handlers to both promises right away.
  const [user, orders] = await Promise.all([getUser(), getOrders()]);
  return { user, orders };
}
```

**Why it works.** Both promises start at once, but the function is suspended on `await userP` while `ordersP` rejects with no handler attached. Node checks for unhandled rejections after the microtask queue drains, so it reports one, and since Node 15 the default `--unhandled-rejections=throw` crashes the process. The try/catch would only see the error later. `Promise.all` subscribes to every promise immediately and rejects fast. Also add `process.on('unhandledRejection')` as a last-resort logger, then exit.

**Say it.** The second promise rejects while we're still awaiting the first, so it has no handler yet and Node treats it as unhandled; Promise.all attaches handlers to both immediately.

**Follow-up.** Q: Should you keep the process running after an uncaughtException? A: No. Log it, stop accepting traffic, and exit; state may be corrupt. Let the process manager (Kubernetes, PM2, systemd) restart it.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

const unhandled: unknown[] = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));

const getUser = () => new Promise<string>((r) => setTimeout(() => r('ann'), 40));
const failingOrders = () => new Promise<string[]>((_, j) => setTimeout(() => j(new Error('orders failed')), 5));

await assert.rejects(loadDashboard(getUser, failingOrders), /orders failed/);
assert.deepEqual(
  await loadDashboard(getUser, async () => ['o1']),
  { user: 'ann', orders: ['o1'] },
);

// The buggy version does report an unhandled rejection.
async function buggy() {
  const userP = getUser();
  const ordersP = failingOrders();
  const user = await userP;
  const orders = await ordersP;
  return { user, orders };
}
await buggy().catch(() => {});
await new Promise((r) => setTimeout(r, 10));
assert.equal(unhandled.length, 1);
```

</details>

</details>

---

<a id="node-23"></a>
### node-23. Async generator for cursor pagination

*Async iteration · Medium*

An API returns pages: `fetchPage(cursor?) -> { items, nextCursor }`, where `nextCursor` is `null` on the last page. Write an async generator `paginate(fetchPage)` that yields items one by one, fetching pages lazily. Then write `take(iterable, n)`. Breaking out early must stop fetching.

```ts
for await (const user of paginate(fetchUsers)) console.log(user.id);
await take(paginate(fetchUsers), 3); // fetches only the pages it needs
```

**Starter**

```ts
export interface Page<T> { items: T[]; nextCursor: string | null }

export async function* paginate<T>(fetchPage: (cursor?: string) => Promise<Page<T>>): AsyncGenerator<T> {
  // TODO
}

export async function take<T>(source: AsyncIterable<T>, n: number): Promise<T[]> {
  // TODO
  throw new Error('not implemented');
}
```

<details>
<summary>Solution</summary>

```ts
export interface Page<T> { items: T[]; nextCursor: string | null }

export async function* paginate<T>(fetchPage: (cursor?: string) => Promise<Page<T>>): AsyncGenerator<T> {
  let cursor: string | undefined;
  do {
    const page = await fetchPage(cursor);
    yield* page.items;
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
}

export async function take<T>(source: AsyncIterable<T>, n: number): Promise<T[]> {
  const out: T[] = [];
  if (n <= 0) return out;
  for await (const item of source) {
    out.push(item);
    if (out.length >= n) break; // break calls the generator's return(), so no more pages are fetched
  }
  return out;
}
```

**Why it works.** The generator owns the cursor loop and hides paging from the caller: consumers just `for await` over items. It is lazy: the next page is fetched only when the consumer asks for more items, and `break` calls `return()` on the generator, which stops it (and runs any `finally` for cleanup). Memory stays at one page. Trap: collecting all pages into one array first defeats the point for large datasets.

**Say it.** The async generator loops on the cursor and yields items one at a time, so pages are fetched lazily and a consumer's break stops further requests.

**Follow-up.** Q: How would you speed this up if pages are slow? A: Prefetch: start fetching the next page while the consumer processes the current one (keep one pending promise), as long as the API allows it and you respect rate limits.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

const data = Array.from({ length: 7 }, (_, i) => ({ id: i + 1 }));
const calls: (string | undefined)[] = [];
const fetchUsers = async (cursor?: string): Promise<Page<{ id: number }>> => {
  calls.push(cursor);
  await new Promise((r) => setTimeout(r, 2));
  const start = cursor ? Number(cursor) : 0;
  const end = start + 3;
  return { items: data.slice(start, end), nextCursor: end < data.length ? String(end) : null };
};

const all: number[] = [];
for await (const u of paginate(fetchUsers)) all.push(u.id);
assert.deepEqual(all, [1, 2, 3, 4, 5, 6, 7]);
assert.deepEqual(calls, [undefined, '3', '6']);

calls.length = 0;
assert.deepEqual((await take(paginate(fetchUsers), 4)).map((u) => u.id), [1, 2, 3, 4]);
assert.equal(calls.length, 2);

calls.length = 0;
assert.deepEqual(await take(paginate(fetchUsers), 0), []);
assert.equal(calls.length, 0);
assert.deepEqual(await take(paginate(async () => ({ items: [], nextCursor: null })), 5), []);
```

</details>

</details>

---

<a id="node-24"></a>
### node-24. DataLoader-style batching

*Batching · Hard*

Resolving a GraphQL list causes N+1 queries: one `getUser(id)` per row. Build a `DataLoader` that collects all `load(key)` calls made in the same tick and calls `batchFn(keys)` once.
- `batchFn` receives unique keys and returns values (or `Error`s) in the same order.
- Duplicate keys share one promise; results are cached per loader.
- A batch failure rejects every load in it.

```ts
const loader = new DataLoader((ids) => db.users.findMany(ids));
await Promise.all([loader.load(1), loader.load(2), loader.load(1)]); // one call: batchFn([1, 2])
```

**Starter**

```ts
export class DataLoader<K, V> {
  constructor(batchFn: (keys: K[]) => Promise<(V | Error)[]>) {}
  load(key: K): Promise<V> {
    throw new Error('not implemented');
  }
}
```

<details>
<summary>Solution</summary>

```ts
type Pending<V> = { resolve: (v: V) => void; reject: (e: unknown) => void };

export class DataLoader<K, V> {
  #batchFn: (keys: K[]) => Promise<(V | Error)[]>;
  #cache = new Map<K, Promise<V>>();
  #queue = new Map<K, Pending<V>>();

  constructor(batchFn: (keys: K[]) => Promise<(V | Error)[]>) {
    this.#batchFn = batchFn;
  }

  load(key: K): Promise<V> {
    const cached = this.#cache.get(key);
    if (cached) return cached;

    const promise = new Promise<V>((resolve, reject) => {
      if (this.#queue.size === 0) {
        // First key of a new batch: dispatch after the current tick's loads are collected.
        process.nextTick(() => this.#dispatch());
      }
      this.#queue.set(key, { resolve, reject });
    });
    this.#cache.set(key, promise);
    return promise;
  }

  clear(key: K) {
    this.#cache.delete(key);
  }

  async #dispatch() {
    const batch = this.#queue;
    this.#queue = new Map();
    const keys = [...batch.keys()];
    try {
      const values = await this.#batchFn(keys);
      if (values.length !== keys.length) {
        throw new Error(`batchFn returned ${values.length} values for ${keys.length} keys`);
      }
      keys.forEach((key, i) => {
        const value = values[i];
        if (value instanceof Error) {
          this.#cache.delete(key); // do not cache per-key failures
          batch.get(key)!.reject(value);
        } else {
          batch.get(key)!.resolve(value);
        }
      });
    } catch (err) {
      for (const [key, pending] of batch) {
        this.#cache.delete(key);
        pending.reject(err);
      }
    }
  }
}
```

**Why it works.** The first `load` in a tick schedules one dispatch with `process.nextTick`, so every `load` made synchronously in the same tick lands in the same queue. The queue is a Map, which dedupes keys, and the promise cache returns the same promise for repeated keys. On dispatch, results are matched to keys by index, so `batchFn` must keep order and length (e.g. map DB rows back by id, filling gaps with Errors). Failures are removed from the cache so they can be retried. In GraphQL, create one loader per request so cached data never leaks between users.

**Say it.** I queue keys in a map and schedule a single dispatch on nextTick when the first key arrives, then call the batch function once and resolve each key's promise by index.

**Follow-up.** Q: Why create a new loader per request instead of one global loader? A: The cache has no TTL or auth context; a global one would serve stale data and could leak one user's data to another. Per-request loaders give batching plus request-scoped caching.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

const calls: number[][] = [];
const users = new Map([[1, 'ann'], [2, 'bob'], [3, 'cy']]);
const loader = new DataLoader<number, string>(async (ids) => {
  calls.push(ids);
  await new Promise((r) => setTimeout(r, 5));
  return ids.map((id) => users.get(id) ?? new Error(`user ${id} not found`));
});

assert.deepEqual(await Promise.all([loader.load(1), loader.load(2), loader.load(1)]), ['ann', 'bob', 'ann']);
assert.deepEqual(calls, [[1, 2]]);

assert.equal(await loader.load(2), 'bob'); // cached
assert.equal(calls.length, 1);

const results = await Promise.allSettled([loader.load(3), loader.load(99)]);
assert.deepEqual(calls[1], [3, 99]);
assert.equal(results[0].status, 'fulfilled');
assert.equal(results[1].status, 'rejected');

const broken = new DataLoader<number, string>(async () => { throw new Error('db down'); });
const r = await Promise.allSettled([broken.load(1), broken.load(2)]);
assert.ok(r.every((x) => x.status === 'rejected'));
```

</details>

</details>

---

<a id="node-25"></a>
### node-25. Debounce with cancel and flush

*Timing · Easy*

Implement `debounce(fn, waitMs)`: calls are delayed until `waitMs` has passed since the last call, then `fn` runs once with the latest arguments. Add `cancel()` (drop the pending call) and `flush()` (run the pending call now).

```ts
const save = debounce(saveDraft, 300);
save('a'); save('ab'); save('abc'); // ~300 ms later: saveDraft('abc') once
```

**Starter**

```ts
export function debounce<A extends unknown[]>(fn: (...args: A) => void, waitMs: number) {
  // TODO: return a function with .cancel() and .flush()
}
```

<details>
<summary>Solution</summary>

```ts
export function debounce<A extends unknown[]>(fn: (...args: A) => void, waitMs: number) {
  let timer: NodeJS.Timeout | undefined;
  let lastArgs: A | undefined;

  const run = () => {
    timer = undefined;
    const args = lastArgs!;
    lastArgs = undefined;
    fn(...args);
  };

  const debounced = (...args: A) => {
    lastArgs = args;
    clearTimeout(timer); // every call restarts the wait
    timer = setTimeout(run, waitMs);
  };
  debounced.cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    lastArgs = undefined;
  };
  debounced.flush = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    run();
  };
  return debounced;
}
```

**Why it works.** Each call stores the latest arguments and restarts a timer; `fn` only runs when the calls stop for `waitMs`. `cancel` clears the timer and arguments; `flush` runs the pending call immediately (useful on shutdown or before navigation so the last edit is saved). Use debounce for "do it once after things settle" (search-as-you-type, autosave, re-index after file changes). Trap: creating a new debounced function on every call (e.g. inside a request handler) gives each call its own timer, so nothing is debounced.

**Say it.** Every call saves the latest arguments and resets the timer, so the function runs once after a quiet period; cancel clears it and flush runs it now.

**Follow-up.** Q: Debounce vs throttle? A: Debounce waits for a pause and runs once at the end; throttle runs at most once per interval during continuous activity (e.g. progress updates, scroll handlers).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const calls: string[] = [];
const save = debounce((s: string) => calls.push(s), 30);
save('a'); save('ab'); save('abc');
await wait(10);
assert.deepEqual(calls, []);
await wait(40);
assert.deepEqual(calls, ['abc']);

save('x');
save.cancel();
await wait(40);
assert.deepEqual(calls, ['abc']);

save('y');
save.flush();
assert.deepEqual(calls, ['abc', 'y']);
await wait(40);
assert.deepEqual(calls, ['abc', 'y']); // flushed call does not run again
```

</details>

</details>

---

<a id="node-26"></a>
### node-26. Throttle with leading and trailing calls

*Timing · Medium*

Implement `throttle(fn, intervalMs, { leading = true, trailing = true })`: `fn` runs at most once per interval.
- `leading`: run immediately on the first call of a burst.
- `trailing`: if calls happened during the interval, run once more at its end with the latest arguments.

```ts
const t = throttle(report, 50);
t(1); t(2); t(3); // report(1) now, report(3) after ~50 ms
```

**Starter**

```ts
export function throttle<A extends unknown[]>(
  fn: (...args: A) => void,
  intervalMs: number,
  opts: { leading?: boolean; trailing?: boolean } = {},
): (...args: A) => void {
  // TODO
  throw new Error('not implemented');
}
```

<details>
<summary>Solution</summary>

```ts
export function throttle<A extends unknown[]>(
  fn: (...args: A) => void,
  intervalMs: number,
  opts: { leading?: boolean; trailing?: boolean } = {},
): (...args: A) => void {
  const { leading = true, trailing = true } = opts;
  let timer: NodeJS.Timeout | undefined;
  let pendingArgs: A | undefined;

  const onIntervalEnd = () => {
    if (trailing && pendingArgs) {
      fn(...pendingArgs);
      pendingArgs = undefined;
      timer = setTimeout(onIntervalEnd, intervalMs); // the trailing call opens a new interval
    } else {
      timer = undefined;
    }
  };

  return (...args: A) => {
    if (timer === undefined) {
      // Start of a burst.
      if (leading) fn(...args);
      else pendingArgs = args;
      timer = setTimeout(onIntervalEnd, intervalMs);
    } else {
      pendingArgs = args; // keep only the latest call for the trailing edge
    }
  };
}
```

**Why it works.** A timer marks an open interval. The first call of a burst runs now (leading) or is saved; calls inside the interval only replace the saved arguments. When the interval ends, a saved call runs (trailing) and starts a new interval, so two calls are always at least `intervalMs` apart. With `leading: false` you get "run at the end of each window". Trap: running the trailing call without restarting the interval lets a new leading call fire right after it.

**Say it.** A timer represents the current window: the first call runs immediately, later calls just overwrite the saved args, and when the window closes the saved call runs and opens a new window.

**Follow-up.** Q: How does this differ from a rate limiter? A: Throttle drops or merges extra calls (good for UI events or progress logs); a rate limiter decides per request whether to allow it and usually rejects (429) or queues the rest.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const calls: number[] = [];
const t = throttle((n: number) => calls.push(n), 40);
t(1); t(2); t(3);
assert.deepEqual(calls, [1]);
await wait(60);
assert.deepEqual(calls, [1, 3]);
await wait(60);
t(4);
assert.deepEqual(calls, [1, 3, 4]); // new burst after idle runs immediately
await wait(60);
assert.deepEqual(calls, [1, 3, 4]); // no trailing call without extra calls

const calls2: number[] = [];
const noLead = throttle((n: number) => calls2.push(n), 30, { leading: false });
noLead(1); noLead(2);
assert.deepEqual(calls2, []);
await wait(50);
assert.deepEqual(calls2, [2]);

const calls3: number[] = [];
const noTrail = throttle((n: number) => calls3.push(n), 30, { trailing: false });
noTrail(1); noTrail(2);
await wait(50);
assert.deepEqual(calls3, [1]);
```

</details>

</details>

---

<a id="node-27"></a>
### node-27. Token bucket rate limiter

*Rate limiting · Medium*

Implement a token bucket limiter: a bucket holds up to `capacity` tokens and refills continuously at `refillPerSec`. `tryRemove(cost = 1)` returns `true` and consumes tokens if enough are available, else `false`. Inject the clock so it is testable.

```ts
const bucket = new TokenBucket({ capacity: 10, refillPerSec: 5, now: () => fakeNow });
// 10 calls succeed at once (burst), the 11th fails; 200 ms later one more succeeds
```

**Starter**

```ts
export class TokenBucket {
  constructor(opts: { capacity: number; refillPerSec: number; now?: () => number }) {}
  tryRemove(cost = 1): boolean {
    throw new Error('not implemented');
  }
}
```

<details>
<summary>Solution</summary>

```ts
export class TokenBucket {
  #capacity: number;
  #refillPerMs: number;
  #now: () => number;
  #tokens: number;
  #lastRefill: number;

  constructor(opts: { capacity: number; refillPerSec: number; now?: () => number }) {
    this.#capacity = opts.capacity;
    this.#refillPerMs = opts.refillPerSec / 1000;
    this.#now = opts.now ?? Date.now;
    this.#tokens = opts.capacity; // start full to allow an initial burst
    this.#lastRefill = this.#now();
  }

  // Lazy refill: compute tokens from elapsed time instead of using a timer.
  #refill() {
    const now = this.#now();
    const elapsed = now - this.#lastRefill;
    this.#tokens = Math.min(this.#capacity, this.#tokens + elapsed * this.#refillPerMs);
    this.#lastRefill = now;
  }

  get tokens() {
    this.#refill();
    return this.#tokens;
  }

  tryRemove(cost = 1): boolean {
    this.#refill();
    if (this.#tokens < cost) return false;
    this.#tokens -= cost;
    return true;
  }
}
```

**Why it works.** No timer is needed: on each call, add `elapsed * rate` tokens (capped at capacity) and update the timestamp. Capacity sets the allowed burst, the refill rate sets the long-run average. Each key (user, API key, IP) gets its own bucket, usually stored in a Map or, across instances, in Redis with a Lua script so read-and-update is atomic. O(1) time and memory per key. Trap: refilling with `setInterval` for every bucket wastes CPU and drifts.

**Say it.** I refill lazily on each request from the elapsed time, cap at capacity, and allow the request if enough tokens remain; capacity is the burst and the refill rate is the sustained limit.

**Follow-up.** Q: How do you tell the client when to retry? A: Return 429 with a Retry-After header computed as `(cost - tokens) / refillRate`, plus optional RateLimit-Remaining headers.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

let now = 0;
const bucket = new TokenBucket({ capacity: 10, refillPerSec: 5, now: () => now });
for (let i = 0; i < 10; i++) assert.equal(bucket.tryRemove(), true);
assert.equal(bucket.tryRemove(), false);
now += 199;
assert.equal(bucket.tryRemove(), false);
now += 1; // 200 ms = 1 token
assert.equal(bucket.tryRemove(), true);
now += 10_000; // long idle: capped at capacity
assert.equal(bucket.tokens, 10);
assert.equal(bucket.tryRemove(4), true);
assert.equal(bucket.tryRemove(7), false);
assert.equal(bucket.tryRemove(6), true);
```

</details>

</details>

---

<a id="node-28"></a>
### node-28. Sliding window rate limiter

*Rate limiting · Medium*

Implement `SlidingWindowLimiter({ limit, windowMs, now })` with `allow(key): boolean`. A key may make at most `limit` requests in any rolling window of `windowMs` (not fixed clock minutes). Rejected requests do not count.

```ts
const rl = new SlidingWindowLimiter({ limit: 3, windowMs: 1000 });
rl.allow('ip1') x3 -> true, true, true; 4th -> false
// 1000 ms after the first request -> true again
```

**Starter**

```ts
export class SlidingWindowLimiter {
  constructor(opts: { limit: number; windowMs: number; now?: () => number }) {}
  allow(key: string): boolean {
    throw new Error('not implemented');
  }
}
```

<details>
<summary>Solution</summary>

```ts
export class SlidingWindowLimiter {
  #limit: number;
  #windowMs: number;
  #now: () => number;
  #hits = new Map<string, number[]>(); // timestamps of accepted requests, oldest first

  constructor(opts: { limit: number; windowMs: number; now?: () => number }) {
    this.#limit = opts.limit;
    this.#windowMs = opts.windowMs;
    this.#now = opts.now ?? Date.now;
  }

  allow(key: string): boolean {
    const now = this.#now();
    const windowStart = now - this.#windowMs;
    const hits = this.#hits.get(key) ?? [];

    // Drop timestamps that have left the window.
    let expired = 0;
    while (expired < hits.length && hits[expired] <= windowStart) expired++;
    if (expired > 0) hits.splice(0, expired);

    if (hits.length >= this.#limit) {
      this.#hits.set(key, hits);
      return false;
    }
    hits.push(now);
    this.#hits.set(key, hits);
    return true;
  }
}
```

**Why it works.** The sliding log keeps each accepted request's timestamp per key, drops the ones older than the window, and allows the request if fewer than `limit` remain. It is exact and avoids the fixed-window problem where a client sends `2 * limit` requests around a window boundary. Cost is O(limit) memory per key. Trap: fixed-window counters (`key:minute`) are simpler but allow those boundary bursts. Clean up idle keys or the Map grows forever.

**Say it.** I keep a log of accepted timestamps per key, trim entries older than the window on each request, and allow it only if fewer than limit remain.

**Follow-up.** Q: How do you make this cheaper with millions of users? A: Use the sliding window counter: keep counts for the current and previous fixed windows and estimate `prev * overlapFraction + current`; in Redis that is two INCR keys with TTL instead of a list per user.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

let now = 0;
const rl = new SlidingWindowLimiter({ limit: 3, windowMs: 1000, now: () => now });
assert.equal(rl.allow('a'), true);
now = 100; assert.equal(rl.allow('a'), true);
now = 200; assert.equal(rl.allow('a'), true);
now = 300; assert.equal(rl.allow('a'), false);
assert.equal(rl.allow('b'), true); // keys are independent
now = 999; assert.equal(rl.allow('a'), false);
now = 1000; assert.equal(rl.allow('a'), true); // the request at t=0 left the window
now = 1050; assert.equal(rl.allow('a'), false);
now = 1100; assert.equal(rl.allow('a'), true);
```

</details>

</details>

---

<a id="node-29"></a>
### node-29. Implement an EventEmitter

*Events · Medium*

Implement `Emitter` with `on`, `off`, `once` and `emit`.
- `emit` returns `true` if there were listeners.
- Listeners run in registration order; removing or adding listeners during `emit` must not affect the current emit.
- `off(event, fn)` also removes a `once` listener registered with `fn`.
- Emitting `'error'` with no listener throws the error.

```ts
const e = new Emitter();
e.once('ready', (v) => console.log('ready', v));
e.emit('ready', 1); // logs once
e.emit('ready', 2); // nothing, returns false
```

**Starter**

```ts
type Listener = (...args: any[]) => void;

export class Emitter {
  on(event: string, fn: Listener): this { throw new Error('not implemented'); }
  off(event: string, fn: Listener): this { throw new Error('not implemented'); }
  once(event: string, fn: Listener): this { throw new Error('not implemented'); }
  emit(event: string, ...args: unknown[]): boolean { throw new Error('not implemented'); }
}
```

<details>
<summary>Solution</summary>

```ts
type Listener = (...args: any[]) => void;
type Entry = { fn: Listener; once: boolean };

export class Emitter {
  #events = new Map<string, Entry[]>();

  on(event: string, fn: Listener): this {
    const list = this.#events.get(event) ?? [];
    list.push({ fn, once: false });
    this.#events.set(event, list);
    return this;
  }

  once(event: string, fn: Listener): this {
    const list = this.#events.get(event) ?? [];
    list.push({ fn, once: true });
    this.#events.set(event, list);
    return this;
  }

  off(event: string, fn: Listener): this {
    const list = this.#events.get(event);
    if (!list) return this;
    const index = list.findIndex((entry) => entry.fn === fn);
    if (index !== -1) list.splice(index, 1);
    if (list.length === 0) this.#events.delete(event);
    return this;
  }

  emit(event: string, ...args: unknown[]): boolean {
    const list = this.#events.get(event);
    if (!list || list.length === 0) {
      if (event === 'error') throw args[0] instanceof Error ? args[0] : new Error(`Unhandled error: ${String(args[0])}`);
      return false;
    }
    // Iterate over a snapshot so changes during emit only affect later emits.
    for (const entry of [...list]) {
      if (entry.once) this.off(event, entry.fn);
      entry.fn.apply(this, args);
    }
    return true;
  }

  listenerCount(event: string): number {
    return this.#events.get(event)?.length ?? 0;
  }
}
```

**Why it works.** Store, per event name, an array of `{ fn, once }` entries. Keeping the original `fn` (instead of a wrapper) lets `off` remove `once` listeners. `emit` iterates over a copy, so a listener that calls `off` or `on` does not skip or add calls in the current emit, and a `once` entry is removed before it runs, so re-emitting inside it does not call it twice. Node's EventEmitter calls listeners synchronously and throws on unhandled `'error'` events, which can crash the process.

**Say it.** I keep a map of event name to listener entries, emit over a snapshot so mutations during emit are safe, and remove once-listeners before calling them.

**Follow-up.** Q: What does the "MaxListenersExceededWarning" mean? A: More than 10 listeners on one event, usually a leak from adding a listener per request without removing it; fix the leak rather than raising the limit with setMaxListeners.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

const e = new Emitter();
const log: string[] = [];
e.once('ready', (v) => log.push(`ready ${v}`));
assert.equal(e.emit('ready', 1), true);
assert.equal(e.emit('ready', 2), false);
assert.deepEqual(log, ['ready 1']);

// Removing a later listener during emit does not affect the current emit.
const b = () => log.push('b');
e.on('x', () => { log.push('a'); e.off('x', b); });
e.on('x', b);
e.emit('x');
e.emit('x');
assert.deepEqual(log.slice(1), ['a', 'b', 'a']);

const onceFn = () => log.push('never');
e.once('y', onceFn).off('y', onceFn);
assert.equal(e.emit('y'), false);

assert.throws(() => e.emit('error', new Error('boom')), /boom/);
e.on('error', (err: Error) => log.push(err.message));
e.emit('error', new Error('handled'));
assert.equal(log.at(-1), 'handled');
```

</details>

</details>

---

<a id="node-30"></a>
### node-30. Wait for an event with a promise

*Events · Easy*

Write `waitForEvent(emitter, name, { timeoutMs })` that resolves with the event's arguments (as an array) the first time `name` is emitted, rejects if `'error'` is emitted first, and rejects with a `TimeoutError` after `timeoutMs`. All listeners and timers must be cleaned up in every case.

```ts
const [conn] = await waitForEvent(pool, 'connect', { timeoutMs: 5000 });
```

**Starter**

```ts
import { EventEmitter } from 'node:events';

export function waitForEvent(emitter: EventEmitter, name: string, opts: { timeoutMs?: number } = {}): Promise<unknown[]> {
  // TODO
  throw new Error('not implemented');
}
```

<details>
<summary>Solution</summary>

```ts
import { EventEmitter } from 'node:events';

export function waitForEvent(emitter: EventEmitter, name: string, opts: { timeoutMs?: number } = {}): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      clearTimeout(timer);
      emitter.off(name, onEvent);
      emitter.off('error', onError);
    };
    const onEvent = (...args: unknown[]) => { cleanup(); resolve(args); };
    const onError = (err: unknown) => { cleanup(); reject(err); };

    emitter.on(name, onEvent);
    if (name !== 'error') emitter.on('error', onError);
    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        cleanup();
        const err = new Error(`Timed out waiting for "${name}"`);
        err.name = 'TimeoutError';
        reject(err);
      }, opts.timeoutMs);
    }
  });
}
```

**Why it works.** Attach one handler for the event and one for `'error'`, and a single `cleanup` that removes both and clears the timer, called on every exit path. Without cleanup, each call leaks listeners, which shows up as a MaxListenersExceededWarning and memory growth. Node provides this as `events.once(emitter, name, { signal })`, which also rejects on `'error'`; for a stream of events use `events.on(emitter, name)` as an async iterator.

**Say it.** I subscribe to the event and to error, settle the promise on whichever happens first or on timeout, and always run one cleanup that removes both listeners and the timer.

**Follow-up.** Q: How would you support cancellation by the caller? A: Accept an AbortSignal, reject with signal.reason on abort, and remove the abort listener in cleanup; `events.once` already supports `{ signal }`.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

const em = new EventEmitter();
setTimeout(() => em.emit('connect', 'conn-1', 42), 5);
assert.deepEqual(await waitForEvent(em, 'connect', { timeoutMs: 100 }), ['conn-1', 42]);
assert.equal(em.listenerCount('connect'), 0);
assert.equal(em.listenerCount('error'), 0);

setTimeout(() => em.emit('error', new Error('refused')), 5);
await assert.rejects(waitForEvent(em, 'connect'), /refused/);
assert.equal(em.listenerCount('connect'), 0);

await assert.rejects(waitForEvent(em, 'never', { timeoutMs: 15 }), { name: 'TimeoutError' });
assert.equal(em.listenerCount('never'), 0);
assert.equal(em.listenerCount('error'), 0);
```

</details>

</details>

---

<a id="node-31"></a>
### node-31. Uppercase Transform stream

*Streams · Easy*

Write a `Transform` stream `UpperCase` that upper-cases text passing through it, then use it with `pipeline` to transform a source into a destination. It must handle multi-byte UTF-8 characters split across chunk boundaries.

```ts
await pipeline(Readable.from(['hello ', 'world']), new UpperCase(), sink); // sink gets 'HELLO WORLD'
// chunks [0x63, 0x61, 0x66, 0xC3] + [0xA9] ('café' split inside 'é') -> 'CAFÉ'
```

**Starter**

```ts
import { Transform, type TransformCallback } from 'node:stream';

export class UpperCase extends Transform {
  _transform(chunk: Buffer | string, _enc: BufferEncoding, cb: TransformCallback) {
    // TODO
  }
}
```

<details>
<summary>Solution</summary>

```ts
import { Transform, type TransformCallback } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

export class UpperCase extends Transform {
  // Buffers incomplete multi-byte characters between chunks.
  #decoder = new StringDecoder('utf8');

  _transform(chunk: Buffer | string, _enc: BufferEncoding, cb: TransformCallback) {
    const text = typeof chunk === 'string' ? chunk : this.#decoder.write(chunk);
    cb(null, text.toUpperCase());
  }

  _flush(cb: TransformCallback) {
    cb(null, this.#decoder.end().toUpperCase());
  }
}
```

**Why it works.** A Transform is a Duplex where `_transform` receives each chunk and pushes output via the callback; `_flush` runs once at the end for leftover data. Chunks are Buffers by default, and a chunk boundary can fall inside a multi-byte character, so `chunk.toString()` would produce garbage; `StringDecoder` keeps the partial bytes until the rest arrives. Use `pipeline` (from `node:stream/promises`) rather than `.pipe()` so errors in any stage destroy all streams and reject one promise.

**Say it.** I extend Transform, decode chunks with a StringDecoder so split UTF-8 characters survive, push the uppercased text, flush leftovers at the end, and connect everything with pipeline.

**Follow-up.** Q: Why prefer `pipeline` over `a.pipe(b).pipe(c)`? A: `.pipe()` does not forward errors or clean up: if `c` fails, `a` keeps reading and file descriptors leak. `pipeline` destroys every stream on error and gives one callback or promise.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

async function run(chunks: (string | Buffer)[]) {
  let out = '';
  const sink = new Writable({
    write(chunk, _enc, cb) { out += chunk.toString(); cb(); },
  });
  await pipeline(Readable.from(chunks), new UpperCase(), sink);
  return out;
}

assert.equal(await run(['hello ', 'world']), 'HELLO WORLD');
const bytes = Buffer.from('café', 'utf8');
assert.equal(await run([bytes.subarray(0, 4), bytes.subarray(4)]), 'CAFÉ');
assert.equal(await run([]), '');
```

</details>

</details>

---

<a id="node-32"></a>
### node-32. Parse JSON Lines with a Transform stream

*Streams · Medium*

Write `JsonLinesParser`, a Transform that takes raw text chunks and outputs one parsed object per line (object mode on the readable side). Lines can be split across chunks, the last line may have no trailing newline, blank lines are skipped, and invalid JSON fails the stream with an error that includes the line number.

```ts
chunks: ['{"id":1}\n{"i', 'd":2}\n\n{"id":3}']  ->  {id:1}, {id:2}, {id:3}
```

**Starter**

```ts
import { Transform, type TransformCallback } from 'node:stream';

export class JsonLinesParser extends Transform {
  constructor() {
    super({ readableObjectMode: true });
  }
  _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
    // TODO
  }
  _flush(cb: TransformCallback) {
    // TODO
  }
}
```

<details>
<summary>Solution</summary>

```ts
import { Transform, type TransformCallback } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

export class JsonLinesParser extends Transform {
  #decoder = new StringDecoder('utf8');
  #buffer = '';
  #lineNo = 0;

  constructor() {
    super({ readableObjectMode: true });
  }

  _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
    this.#buffer += this.#decoder.write(chunk);
    const lines = this.#buffer.split('\n');
    this.#buffer = lines.pop()!; // last piece may be an incomplete line
    cb(this.#pushLines(lines));
  }

  _flush(cb: TransformCallback) {
    this.#buffer += this.#decoder.end();
    const err = this.#pushLines([this.#buffer]);
    this.#buffer = '';
    cb(err);
  }

  #pushLines(lines: string[]): Error | null {
    for (const raw of lines) {
      this.#lineNo++;
      const line = raw.trim();
      if (!line) continue;
      try {
        this.push(JSON.parse(line));
      } catch (err) {
        return new Error(`Invalid JSON on line ${this.#lineNo}: ${(err as Error).message}`);
      }
    }
    return null;
  }
}
```

**Why it works.** Keep a string buffer: append each decoded chunk, split on `\n`, and keep the last element because it may be an incomplete line. `_flush` handles the final line without a newline. `readableObjectMode` lets the output side emit objects while the input side still takes bytes. Passing an Error to the callback destroys the stream, which `pipeline` turns into a rejection. Memory is bounded by the longest line, so this works on multi-GB files. Trap: `JSON.parse(chunk)` per chunk breaks as soon as a line spans two chunks.

**Say it.** I buffer text, split on newlines, keep the trailing partial line for the next chunk, parse complete lines into objects, and handle the last line in flush.

**Follow-up.** Q: How would you guard against a malicious line that never ends? A: Track the buffer size and fail the stream (or skip the record) if it exceeds a max line length, so one bad input cannot exhaust memory.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

async function parse(chunks: string[]) {
  const out: unknown[] = [];
  await pipeline(
    Readable.from(chunks.map((c) => Buffer.from(c))),
    new JsonLinesParser(),
    async function (source: AsyncIterable<unknown>) { for await (const obj of source) out.push(obj); },
  );
  return out;
}

assert.deepEqual(await parse(['{"id":1}\n{"i', 'd":2}\n\n{"id":3}']), [{ id: 1 }, { id: 2 }, { id: 3 }]);
assert.deepEqual(await parse(['{"a":"x"}\r\n', '{"a":"y"}\n']), [{ a: 'x' }, { a: 'y' }]);
assert.deepEqual(await parse([]), []);
await assert.rejects(parse(['{"ok":1}\n{bad}\n']), /line 2/);
```

</details>

</details>

---

<a id="node-33"></a>
### node-33. Copy a stream with backpressure

*Streams · Hard*

Without using `pipe` or `pipeline`, write `copy(source, destination)` that copies all chunks from a Readable to a Writable while respecting backpressure, ends the destination, and resolves when everything is flushed. It must reject if either stream errors.

Then explain: what goes wrong with this version on a 10 GB file and a slow destination?

```ts
source.on('data', (chunk) => destination.write(chunk));
source.on('end', () => destination.end());
```

**Starter**

```ts
import { Readable, Writable } from 'node:stream';

export async function copy(source: Readable, destination: Writable): Promise<void> {
  // TODO
}
```

<details>
<summary>Solution</summary>

```ts
import { Readable, Writable } from 'node:stream';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';

export async function copy(source: Readable, destination: Writable): Promise<void> {
  try {
    for await (const chunk of source) {
      // write() returns false when the internal buffer is above highWaterMark.
      if (!destination.write(chunk)) {
        await once(destination, 'drain'); // also rejects if the destination emits 'error'
      }
    }
    destination.end();
    await finished(destination);
  } catch (err) {
    source.destroy();
    destination.destroy();
    throw err;
  }
}
```

**Why it works.** `write()` returns `false` once the destination's buffer reaches `highWaterMark`; the producer should then pause until `'drain'`. Awaiting `drain` inside `for await` pauses reading, so memory stays bounded by roughly one highWaterMark per stream. The naive `on('data')` version ignores the return value: a fast disk read and a slow network write buffer the whole file in memory and can crash with out-of-memory. It also ignores errors. `pipeline` does all of this for you and is what you should use in real code.

**Say it.** I check the return value of write and await the drain event when it is false, which pauses reading and keeps memory bounded; on any error I destroy both streams and rethrow.

**Follow-up.** Q: What does highWaterMark actually limit? A: It is a threshold, not a hard cap: it is the buffer size (bytes, or objects in object mode) at which write() starts returning false and readables stop reading ahead. Default is 64 KiB for streams in Node 22 (16 objects in object mode).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

function slowSink(hwm: number) {
  const received: Buffer[] = [];
  let maxBuffered = 0;
  const sink = new Writable({
    highWaterMark: hwm,
    write(chunk, _enc, cb) {
      maxBuffered = Math.max(maxBuffered, sink.writableLength);
      received.push(chunk);
      setImmediate(cb); // slow consumer
    },
  });
  return { sink, received, max: () => maxBuffered };
}

const chunks = Array.from({ length: 200 }, (_, i) => Buffer.from(String(i).padStart(8, '0')));
const s1 = slowSink(32);
await copy(Readable.from(chunks), s1.sink);
assert.equal(Buffer.concat(s1.received).toString(), Buffer.concat(chunks).toString());
assert.ok(s1.max() <= 40, `buffer grew to ${s1.max()}`);
assert.equal(s1.sink.writableFinished, true);

// The naive version buffers everything.
const s2 = slowSink(32);
const src = Readable.from(chunks);
src.on('data', (c) => s2.sink.write(c));
await new Promise((r) => src.on('end', r));
s2.sink.end();
await finished(s2.sink);
assert.ok(s2.max() > 400);

const failing = new Writable({ write(_c, _e, cb) { cb(new Error('disk full')); } });
failing.on('error', () => {});
await assert.rejects(copy(Readable.from(chunks), failing), /disk full/);
```

</details>

</details>

---

<a id="node-34"></a>
### node-34. Read a large file line by line

*Streams · Easy*

Write `grepFile(path, needle)` that returns `{ lineNumber, line }` for every line containing `needle`, without loading the whole file into memory. Use `readline` with `for await`.

```ts
// app.log: "ok\nERROR db timeout\nok\nERROR disk full"
await grepFile('app.log', 'ERROR')
// [{ lineNumber: 2, line: 'ERROR db timeout' }, { lineNumber: 4, line: 'ERROR disk full' }]
```

**Starter**

```ts
export async function grepFile(path: string, needle: string): Promise<{ lineNumber: number; line: string }[]> {
  // TODO
  throw new Error('not implemented');
}
```

<details>
<summary>Solution</summary>

```ts
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export async function grepFile(path: string, needle: string): Promise<{ lineNumber: number; line: string }[]> {
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity, // treat \r\n as a single line break
  });
  const matches: { lineNumber: number; line: string }[] = [];
  let lineNumber = 0;
  for await (const line of rl) {
    lineNumber++;
    if (line.includes(needle)) matches.push({ lineNumber, line });
  }
  return matches;
}
```

**Why it works.** `fs.readFile` loads the whole file and fails or thrashes on multi-GB logs. A read stream reads 64 KiB chunks, and `readline` splits them into lines, handling lines that span chunks. `for await` over the interface consumes lines one at a time with backpressure, so memory is about one chunk plus the current line. `crlfDelay: Infinity` treats Windows `\r\n` as one line break. A missing file rejects the `for await` with ENOENT.

**Say it.** I stream the file with createReadStream, wrap it in readline, and iterate lines with for await, so memory stays constant no matter how big the file is.

**Follow-up.** Q: How would you make it faster on a huge file? A: Skip readline and scan raw Buffer chunks for the needle bytes, or split the file into byte ranges processed in parallel by worker threads (aligning each range to line boundaries).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'grep-'));
try {
  const file = join(dir, 'app.log');
  await writeFile(file, 'ok\nERROR db timeout\nok\r\nERROR disk full');
  assert.deepEqual(await grepFile(file, 'ERROR'), [
    { lineNumber: 2, line: 'ERROR db timeout' },
    { lineNumber: 4, line: 'ERROR disk full' },
  ]);
  assert.deepEqual(await grepFile(file, 'nothing'), []);

  const big = join(dir, 'big.log');
  const lines = Array.from({ length: 50_000 }, (_, i) => (i % 10_000 === 0 ? `ERROR ${i}` : `line ${i}`));
  await writeFile(big, lines.join('\n'));
  const found = await grepFile(big, 'ERROR');
  assert.deepEqual(found.map((m) => m.lineNumber), [1, 10_001, 20_001, 30_001, 40_001]);

  await assert.rejects(grepFile(join(dir, 'missing.log'), 'x'), { code: 'ENOENT' });
} finally {
  await rm(dir, { recursive: true, force: true });
}
```

</details>

</details>

---

<a id="node-35"></a>
### node-35. Stream a CSV and aggregate

*Streams · Medium*

A CSV of sales (`region,product,amount`, with a header row) is too large for memory. Write `totalsByRegion(input: Readable)` that streams it and returns total `amount` per region. Skip blank lines; throw on a row with a non-numeric amount, including the line number. Assume no quoted fields.

```
region,product,amount
EU,book,10.5
US,pen,2
EU,pen,4.5
-> { EU: 15, US: 2 }
```

**Starter**

```ts
import { Readable } from 'node:stream';

export async function totalsByRegion(input: Readable): Promise<Record<string, number>> {
  // TODO
  throw new Error('not implemented');
}
```

<details>
<summary>Solution</summary>

```ts
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';

export async function totalsByRegion(input: Readable): Promise<Record<string, number>> {
  const rl = createInterface({ input, crlfDelay: Infinity });
  const totals = new Map<string, number>();
  let lineNo = 0;
  let columns: { region: number; amount: number } | undefined;

  for await (const line of rl) {
    lineNo++;
    if (!line.trim()) continue;
    const cells = line.split(',').map((c) => c.trim());
    if (!columns) {
      // Read column positions from the header instead of hard-coding them.
      columns = { region: cells.indexOf('region'), amount: cells.indexOf('amount') };
      if (columns.region < 0 || columns.amount < 0) throw new Error('Missing region or amount column');
      continue;
    }
    const amount = Number(cells[columns.amount]);
    if (cells[columns.amount] === '' || !Number.isFinite(amount)) {
      throw new Error(`Invalid amount on line ${lineNo}: "${cells[columns.amount]}"`);
    }
    const region = cells[columns.region];
    totals.set(region, (totals.get(region) ?? 0) + amount);
  }
  return Object.fromEntries(totals);
}
```

**Why it works.** `readline` accepts any Readable (file, HTTP request body, S3 object stream) and yields lines, so memory stays O(number of regions), not O(file size). The header row maps column names to indexes, which survives column reordering. Validate each row and report the line number; the caller decides whether to fail or skip. Trap: floating point sums (`0.1 + 0.2`); for money, sum integer cents. Real CSV has quoted fields with commas and newlines, so use a proper parser (e.g. csv-parse) in production.

**Say it.** I stream lines through readline, map columns from the header, validate and accumulate into a Map per region, so memory depends on the number of groups, not the file size.

**Follow-up.** Q: The upload comes as an HTTP request; how do you avoid buffering it? A: Pass `req` (a Readable) directly to the same function, set a max body size, and respond only after the stream is fully processed or fails.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

const csv = 'region,product,amount\nEU,book,10.5\nUS,pen,2\n\nEU,pen,4.5\n';
// Split at awkward places to prove line handling across chunks.
const chunks = [csv.slice(0, 7), csv.slice(7, 30), csv.slice(30)];
assert.deepEqual(await totalsByRegion(Readable.from(chunks)), { EU: 15, US: 2 });

assert.deepEqual(await totalsByRegion(Readable.from(['amount,region\r\n', '3,APAC\r\n1,APAC'])), { APAC: 4 });
assert.deepEqual(await totalsByRegion(Readable.from(['region,product,amount\n'])), {});
await assert.rejects(totalsByRegion(Readable.from(['region,product,amount\nEU,book,abc\n'])), /line 2/);
```

</details>

</details>

---

<a id="node-36"></a>
### node-36. Readable.from and generator pipelines

*Streams · Easy*

1. Write an async generator `range(start, end)` and turn it into a stream with `Readable.from`.
2. Build a `pipeline` with async generator stages: keep even numbers, format each as `"n\n"`, and collect the output into a string.

```ts
await evensAsLines(1, 6) // "2\n4\n6\n"
```

**Starter**

```ts
export async function* range(start: number, end: number): AsyncGenerator<number> {
  // TODO
}

export async function evensAsLines(start: number, end: number): Promise<string> {
  // TODO: Readable.from(range(...)) + pipeline with generator stages
  throw new Error('not implemented');
}
```

<details>
<summary>Solution</summary>

```ts
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export async function* range(start: number, end: number): AsyncGenerator<number> {
  for (let i = start; i <= end; i++) yield i;
}

export async function evensAsLines(start: number, end: number): Promise<string> {
  let output = '';
  await pipeline(
    Readable.from(range(start, end)), // object-mode stream of numbers
    async function* (source: AsyncIterable<number>) {
      for await (const n of source) if (n % 2 === 0) yield n;
    },
    async function* (source: AsyncIterable<number>) {
      for await (const n of source) yield `${n}\n`;
    },
    async function (source: AsyncIterable<string>) {
      for await (const line of source) output += line;
    },
  );
  return output;
}
```

**Why it works.** `Readable.from` turns any iterable or async iterable into an object-mode Readable that pulls from the generator only when downstream wants data, so backpressure works automatically. `pipeline` accepts async generator functions as transform stages and an async function as the final consumer, which is often simpler than subclassing Transform. Errors thrown in any stage destroy the whole pipeline and reject the promise. Trap: `Readable.from('abc')` emits the whole string as one chunk, not per character.

**Say it.** Readable.from wraps the generator in a lazy object-mode stream, and pipeline lets me chain async generator functions as transforms, with backpressure and error propagation built in.

**Follow-up.** Q: How do you stream a large DB query result to an HTTP response as NDJSON? A: Use the driver's cursor as an async iterable, `Readable.from(cursor)` (or a generator mapping rows to `JSON.stringify(row) + '\n'`), and `pipeline(..., res)`.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

assert.equal(await evensAsLines(1, 6), '2\n4\n6\n');
assert.equal(await evensAsLines(5, 5), '');
const fromGen: number[] = [];
for await (const n of Readable.from(range(1, 3))) fromGen.push(n);
assert.deepEqual(fromGen, [1, 2, 3]);
assert.equal((await evensAsLines(1, 1000)).split('\n').length, 501);
```

</details>

</details>

---

<a id="node-37"></a>
### node-37. Count bytes and lines in a stream

*Streams · Easy*

Write `countStream(readable)` that resolves with `{ bytes, lines }` for a binary stream, where `lines` is the number of newline characters (like `wc -l`). Do not decode to strings and do not buffer the whole stream.

```ts
countStream(fs.createReadStream('data.txt')) // { bytes: 1048576, lines: 20000 }
Readable.from([Buffer.from('a\nb'), Buffer.from('\n')]) -> { bytes: 4, lines: 2 }
```

**Starter**

```ts
import { Readable } from 'node:stream';

export async function countStream(readable: Readable): Promise<{ bytes: number; lines: number }> {
  // TODO
  throw new Error('not implemented');
}
```

<details>
<summary>Solution</summary>

```ts
import { Readable } from 'node:stream';

const NEWLINE = 0x0a;

export async function countStream(readable: Readable): Promise<{ bytes: number; lines: number }> {
  let bytes = 0;
  let lines = 0;
  for await (const chunk of readable) {
    const buf: Buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    bytes += buf.length;
    // indexOf on a Buffer scans natively, much faster than a JS loop.
    let i = buf.indexOf(NEWLINE);
    while (i !== -1) {
      lines++;
      i = buf.indexOf(NEWLINE, i + 1);
    }
  }
  return { bytes, lines };
}
```

**Why it works.** Iterating a Readable with `for await` gives Buffer chunks and handles backpressure and errors (a stream error rejects the loop). Count `buf.length` for bytes, not string length: `'é'` is 1 character but 2 bytes. Newlines can be counted directly on bytes because `\n` (0x0a) never appears inside a multi-byte UTF-8 sequence, so no decoding is needed. Memory is one chunk at a time.

**Say it.** I iterate the stream's Buffer chunks, add their byte lengths, and count 0x0a bytes with Buffer.indexOf, which is safe for UTF-8 and never loads the whole file.

**Follow-up.** Q: How would you add this as a pass-through step, e.g. to measure upload size while saving it? A: Use a Transform (or a generator stage in pipeline) that counts and re-yields each chunk, and abort when bytes exceed a limit.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

assert.deepEqual(await countStream(Readable.from([Buffer.from('a\nb'), Buffer.from('\n')])), { bytes: 4, lines: 2 });
assert.deepEqual(await countStream(Readable.from([Buffer.from('héllo')])), { bytes: 6, lines: 0 });
assert.deepEqual(await countStream(Readable.from([])), { bytes: 0, lines: 0 });

const dir = await mkdtemp(join(tmpdir(), 'wc-'));
try {
  const file = join(dir, 'data.txt');
  await writeFile(file, 'x'.repeat(99) + '\n'.repeat(1) + 'line\n'.repeat(30_000));
  assert.deepEqual(await countStream(createReadStream(file, { highWaterMark: 1000 })), { bytes: 100 + 150_000, lines: 30_001 });
} finally {
  await rm(dir, { recursive: true, force: true });
}
```

</details>

</details>

---

<a id="node-38"></a>
### node-38. Minimal JSON API with node:http

*HTTP · Medium*

Using only `node:http`, write `createApp()` returning a server with:
- `GET /health` -> `200 {"ok":true}`
- `POST /users` with JSON `{ "name": string }` -> `201` with `{ id, name }`
- `GET /users/:id` -> the user or `404`
- Invalid JSON or missing name -> `400`; body over 1 KB -> `413`; unknown route -> `404`.

All responses are JSON.

**Starter**

```ts
import http from 'node:http';

export function createApp(): http.Server {
  // TODO
  throw new Error('not implemented');
}
```

<details>
<summary>Solution</summary>

```ts
import http from 'node:http';

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MAX_BODY = 1024;

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(json),
  });
  res.end(json);
}

export function createApp(): http.Server {
  const users = new Map<string, { id: string; name: string }>();
  let nextId = 1;

  async function route(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const userMatch = /^\/users\/([^/]+)$/.exec(url.pathname);

    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/users') {
      const body = await readJson(req);
      const name = (body as { name?: unknown } | null)?.name;
      if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'name is required');
      const user = { id: String(nextId++), name: name.trim() };
      users.set(user.id, user);
      return send(res, 201, user);
    }
    if (req.method === 'GET' && userMatch) {
      const user = users.get(decodeURIComponent(userMatch[1]));
      if (!user) throw new HttpError(404, 'User not found');
      return send(res, 200, user);
    }
    throw new HttpError(404, 'Not found');
  }

  return http.createServer((req, res) => {
    route(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      // Never leak internal error details on a 500.
      const message = status === 500 ? 'Internal Server Error' : err.message;
      if (status === 413) res.setHeader('connection', 'close');
      if (!res.headersSent) send(res, status, { error: message });
      else res.destroy();
    });
  });
}
```

**Why it works.** The request is a Readable, so the body is collected with `for await` while enforcing a size limit (otherwise a client can exhaust memory). Routing is a match on method plus path parsed with `URL`. A single `.catch` turns thrown `HttpError`s into JSON responses and everything else into a generic 500, so an async error never becomes an unhandled rejection or a hung request. Set `content-type` and `content-length` explicitly. Trap: forgetting to respond on an error path leaves the client waiting until it times out.

**Say it.** I read the body as a stream with a size cap, parse JSON in a try/catch, route on method and pathname, and funnel every error through one catch that maps it to a status code.

**Follow-up.** Q: What is missing for production? A: Validation with a schema (zod), request timeouts (`server.requestTimeout`, `headersTimeout`), auth, structured logging with request ids, graceful shutdown, and a persistent store instead of a Map.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

const server = createApp();
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
try {
  let res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  res = await fetch(`${base}/users`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Ann' }) });
  assert.equal(res.status, 201);
  const created = await res.json();
  assert.deepEqual(created, { id: '1', name: 'Ann' });

  res = await fetch(`${base}/users/1`);
  assert.deepEqual(await res.json(), created);
  assert.equal((await fetch(`${base}/users/42`)).status, 404);

  assert.equal((await fetch(`${base}/users`, { method: 'POST', body: '{bad' })).status, 400);
  assert.equal((await fetch(`${base}/users`, { method: 'POST', body: '{}' })).status, 400);
  assert.equal((await fetch(`${base}/users`, { method: 'POST', body: JSON.stringify({ name: 'x'.repeat(2000) }) })).status, 413);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
} finally {
  server.closeAllConnections();
  server.close();
}
```

</details>

</details>

---

<a id="node-39"></a>
### node-39. Express-style middleware chain

*Middleware · Medium*

Implement `compose(stack)` that runs Express-style middleware: `(req, res, next)` handlers and error handlers with 4 params `(err, req, res, next)`.
- `next()` goes to the next normal middleware; `next(err)` skips to the next error handler.
- A thrown error or rejected promise from a middleware is treated as `next(err)`.
- If the chain runs out, call `done(err?)`.

```ts
compose([logger, auth, handler, errorHandler])(req, res, done);
```

**Starter**

```ts
export type Next = (err?: unknown) => void;
export type Middleware = (req: any, res: any, next: Next) => unknown;
export type ErrorMiddleware = (err: unknown, req: any, res: any, next: Next) => unknown;

export function compose(stack: (Middleware | ErrorMiddleware)[]) {
  return (req: any, res: any, done: (err?: unknown) => void): void => {
    // TODO
  };
}
```

<details>
<summary>Solution</summary>

```ts
export type Next = (err?: unknown) => void;
export type Middleware = (req: any, res: any, next: Next) => unknown;
export type ErrorMiddleware = (err: unknown, req: any, res: any, next: Next) => unknown;

export function compose(stack: (Middleware | ErrorMiddleware)[]) {
  return (req: any, res: any, done: (err?: unknown) => void): void => {
    let index = 0;

    const next: Next = (err) => {
      const layer = stack[index++];
      if (!layer) return done(err);

      // Express tells error handlers apart by their declared arity.
      const isErrorHandler = layer.length === 4;
      const hasError = err !== undefined;
      if (hasError !== isErrorHandler) return next(err); // skip layers that don't match

      try {
        const result = hasError
          ? (layer as ErrorMiddleware)(err, req, res, next)
          : (layer as Middleware)(req, res, next);
        if (result instanceof Promise) result.catch(next); // async errors go to error handlers too
      } catch (e) {
        next(e);
      }
    };

    next();
  };
}
```

**Why it works.** Keep an index into the stack; `next` takes the next layer and either calls it or skips it. Without an error, error handlers are skipped; with an error, normal middleware is skipped until a 4-argument handler is found. Wrapping each call in try/catch and attaching `.catch(next)` to returned promises routes both sync throws and async rejections to the error handlers (Express 4 did not do the latter, which is why `express-async-errors` existed; Express 5 does). If nothing handles the request, `done` acts as the final 404/500 handler.

**Say it.** next pulls the next layer by index, skipping error handlers when there is no error and normal middleware when there is one, and I convert throws and rejected promises into next(err).

**Follow-up.** Q: How does Koa's model differ? A: Koa middleware is `async (ctx, next) => { ...; await next(); ... }`, an onion: code after `await next()` runs on the way back out, which makes timing and response post-processing easy, and errors are caught with a plain try/catch around `await next()`.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

const tick = () => new Promise((r) => setTimeout(r, 5));
const log: string[] = [];
const app = compose([
  (req, _res, next) => { log.push(`log ${req.path}`); next(); },
  async (req, _res, next) => {
    await tick();
    if (!req.user) throw Object.assign(new Error('unauthorized'), { status: 401 });
    next();
  },
  (req, res) => { res.body = `hello ${req.user}`; },
  (err: any, _req: any, res: any, _next: Next) => { res.status = err.status ?? 500; res.body = err.message; },
]);

const run = (req: any) => new Promise<any>((resolve) => {
  const res: any = {};
  app(req, res, (err) => resolve({ res, err, fellThrough: true }));
  setTimeout(() => resolve({ res }), 30);
});

const ok = await run({ path: '/a', user: 'ann' });
assert.equal(ok.res.body, 'hello ann');
assert.deepEqual(log, ['log /a']);

const denied = await run({ path: '/b' });
assert.equal(denied.res.status, 401);
assert.equal(denied.res.body, 'unauthorized');

const empty = await new Promise<unknown>((resolve) => compose([(_q, _s, next) => next(new Error('x'))])({}, {}, resolve));
assert.match(String(empty), /x/);
const notFound = await new Promise<unknown>((resolve) => compose([])({}, {}, (e) => resolve(e ?? 'no error')));
assert.equal(notFound, 'no error');
```

</details>

</details>

---

<a id="node-40"></a>
### node-40. Graceful shutdown

*Reliability · Hard*

On `SIGTERM` (e.g. a Kubernetes rolling deploy), a server should: stop accepting new requests, let in-flight requests finish, close resources (DB pool, Redis) in reverse order of creation, then exit with code 0. If draining takes longer than `timeoutMs`, force exit with code 1.

Write `createGracefulShutdown({ server, resources, timeoutMs, exit })` returning `{ track(handler), shutdown(signal) }`. `track` wraps a request handler; after shutdown starts it rejects new work. `shutdown` is idempotent. Make it testable with fakes.

**Starter**

```ts
export interface ServerLike { close(cb: (err?: Error) => void): void }
export interface Resource { name: string; close(): Promise<void> }

export function createGracefulShutdown(opts: {
  server: ServerLike;
  resources: Resource[];
  timeoutMs: number;
  exit: (code: number) => void;
}) {
  // TODO
}
```

<details>
<summary>Solution</summary>

```ts
export interface ServerLike { close(cb: (err?: Error) => void): void; closeIdleConnections?(): void }
export interface Resource { name: string; close(): Promise<void> }

export class ShuttingDownError extends Error {
  name = 'ShuttingDownError';
}

export function createGracefulShutdown(opts: {
  server: ServerLike;
  resources: Resource[];
  timeoutMs: number;
  exit: (code: number) => void;
  log?: (msg: string) => void;
}) {
  const { server, resources, timeoutMs, exit, log = () => {} } = opts;
  let shuttingDown = false;
  let inFlight = 0;
  let onDrained: (() => void) | undefined;
  let shutdownPromise: Promise<void> | undefined;

  function track<T>(handler: () => Promise<T>): Promise<T> {
    // In a real server: respond 503 with "Connection: close".
    if (shuttingDown) return Promise.reject(new ShuttingDownError('Server is shutting down'));
    inFlight++;
    return handler().finally(() => {
      inFlight--;
      if (inFlight === 0) onDrained?.();
    });
  }

  async function run(signal: string) {
    log(`${signal} received, draining ${inFlight} request(s)`);
    shuttingDown = true;
    let code = 0;
    let timer: NodeJS.Timeout | undefined;

    const serverClosed = new Promise<void>((resolve) => {
      server.close((err) => {
        if (err) log(`server close error: ${err.message}`);
        resolve();
      });
      server.closeIdleConnections?.(); // keep-alive sockets would otherwise block close()
    });
    const drained = inFlight === 0 ? Promise.resolve() : new Promise<void>((r) => { onDrained = r; });
    const timedOut = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), timeoutMs); });

    const outcome = await Promise.race([Promise.all([serverClosed, drained]).then(() => 'drained' as const), timedOut]);
    clearTimeout(timer);
    if (outcome === 'timeout') {
      log(`forcing shutdown with ${inFlight} request(s) still running`);
      code = 1;
    }

    // Close in reverse order: things created last may depend on things created first.
    for (const resource of [...resources].reverse()) {
      try {
        await resource.close();
        log(`closed ${resource.name}`);
      } catch (err) {
        code = 1;
        log(`failed to close ${resource.name}: ${(err as Error).message}`);
      }
    }
    exit(code);
  }

  function shutdown(signal: string): Promise<void> {
    shutdownPromise ??= run(signal);
    return shutdownPromise;
  }

  return { track, shutdown, get inFlight() { return inFlight; } };
}

// Wiring in a real app:
// const { track, shutdown } = createGracefulShutdown({ server, resources: [db, redis], timeoutMs: 10_000, exit: process.exit });
// process.once('SIGTERM', () => shutdown('SIGTERM'));
// process.once('SIGINT', () => shutdown('SIGINT'));
```

**Why it works.** Order matters: flip a flag so new requests are refused, call `server.close()` to stop accepting connections, wait for in-flight requests to reach zero, then close resources in reverse order, then exit. A timeout guarantees the process exits even if a request hangs (Kubernetes sends SIGKILL after `terminationGracePeriodSeconds` anyway). Making `shutdown` idempotent handles SIGTERM followed by SIGINT. Injecting `server`, `resources` and `exit` makes it unit-testable. Trap: calling `process.exit()` right away drops in-flight requests and unflushed logs.

**Say it.** On SIGTERM I stop accepting work, close the server, wait for in-flight requests with a timeout, close resources in reverse order and exit with 0, or 1 if I had to force it.

**Follow-up.** Q: Kubernetes still routes traffic for a few seconds after SIGTERM. How do you avoid 502s? A: Fail the readiness probe first (return 503 from /ready), wait a few seconds for endpoints to update, then start closing the server.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

function setup(timeoutMs: number) {
  const events: string[] = [];
  const server = { close(cb: (err?: Error) => void) { events.push('server.close'); setTimeout(() => cb(), 1); } };
  const resources = ['db', 'redis'].map((name) => ({
    name,
    async close() { events.push(`close ${name}`); },
  }));
  const exits: number[] = [];
  const gs = createGracefulShutdown({ server, resources, timeoutMs, exit: (c) => { events.push(`exit ${c}`); exits.push(c); } });
  return { gs, events, exits };
}
const work = (ms: number, events: string[], label: string) => () =>
  new Promise<string>((r) => setTimeout(() => { events.push(`done ${label}`); r(label); }, ms));

{
  const { gs, events, exits } = setup(200);
  const r1 = gs.track(work(30, events, 'r1'));
  const r2 = gs.track(work(10, events, 'r2'));
  const p = gs.shutdown('SIGTERM');
  assert.equal(gs.shutdown('SIGINT'), p); // idempotent
  await assert.rejects(gs.track(work(1, events, 'late')), ShuttingDownError);
  await p;
  assert.deepEqual(await Promise.all([r1, r2]), ['r1', 'r2']);
  assert.deepEqual(events, ['server.close', 'done r2', 'done r1', 'close redis', 'close db', 'exit 0']);
  assert.deepEqual(exits, [0]);
}
{
  const { gs, events, exits } = setup(20);
  gs.track(work(150, events, 'stuck'));
  await gs.shutdown('SIGTERM');
  assert.deepEqual(exits, [1]);
  assert.deepEqual(events, ['server.close', 'close redis', 'close db', 'exit 1']);
}
```

</details>

</details>

---

<a id="node-41"></a>
### node-41. Circuit breaker

*Reliability · Hard*

Wrap calls to a flaky dependency in a `CircuitBreaker(fn, { failureThreshold, resetTimeoutMs, now })`:
- **closed**: calls go through; `failureThreshold` consecutive failures open the circuit.
- **open**: calls fail fast with `CircuitOpenError` without calling `fn`. After `resetTimeoutMs`, move to half-open.
- **half-open**: allow one trial call. Success closes the circuit; failure opens it again. Other calls during the trial fail fast.

Inject the clock (`now`) for testing.

**Starter**

```ts
export class CircuitOpenError extends Error {}

export class CircuitBreaker<A extends unknown[], R> {
  state: 'closed' | 'open' | 'half-open' = 'closed';
  constructor(fn: (...args: A) => Promise<R>, opts: { failureThreshold: number; resetTimeoutMs: number; now?: () => number }) {}
  async call(...args: A): Promise<R> {
    throw new Error('not implemented');
  }
}
```

<details>
<summary>Solution</summary>

```ts
export class CircuitOpenError extends Error {
  name = 'CircuitOpenError';
}

export class CircuitBreaker<A extends unknown[], R> {
  state: 'closed' | 'open' | 'half-open' = 'closed';
  #fn: (...args: A) => Promise<R>;
  #failureThreshold: number;
  #resetTimeoutMs: number;
  #now: () => number;
  #failures = 0;
  #openedAt = 0;
  #trialInFlight = false;

  constructor(fn: (...args: A) => Promise<R>, opts: { failureThreshold: number; resetTimeoutMs: number; now?: () => number }) {
    this.#fn = fn;
    this.#failureThreshold = opts.failureThreshold;
    this.#resetTimeoutMs = opts.resetTimeoutMs;
    this.#now = opts.now ?? Date.now;
  }

  async call(...args: A): Promise<R> {
    if (this.state === 'open') {
      if (this.#now() - this.#openedAt < this.#resetTimeoutMs) {
        throw new CircuitOpenError('Circuit is open');
      }
      this.state = 'half-open';
    }

    const isTrial = this.state === 'half-open';
    if (isTrial) {
      if (this.#trialInFlight) throw new CircuitOpenError('Circuit is half-open, trial in progress');
      this.#trialInFlight = true;
    }

    try {
      const result = await this.#fn(...args);
      this.#failures = 0;
      this.state = 'closed';
      return result;
    } catch (err) {
      this.#failures++;
      if (isTrial || this.#failures >= this.#failureThreshold) this.#open();
      throw err;
    } finally {
      if (isTrial) this.#trialInFlight = false;
    }
  }

  #open() {
    this.state = 'open';
    this.#openedAt = this.#now();
  }
}
```

**Why it works.** When a dependency is down, retrying every request wastes threads, sockets and latency budget and keeps the dependency overloaded. The breaker counts consecutive failures and, past the threshold, fails fast for a cool-down period. Then a single trial call probes recovery: success closes the circuit, failure restarts the cool-down. Only one trial runs at a time, so a recovering service is not flooded. Injecting `now` makes state transitions testable without waiting. Trap: counting client errors like 400/404 as failures; usually only timeouts and 5xx should trip it.

**Say it.** It's a small state machine: closed counts consecutive failures, open fails fast until the cool-down passes, and half-open lets exactly one trial call decide whether to close or reopen.

**Follow-up.** Q: How would you combine it with retries and timeouts? A: Timeout innermost (each attempt is bounded), then the breaker (each attempt counts), then retry outermost with backoff; and when the breaker is open, don't retry, return a fallback (cached value, degraded response) or 503.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

let now = 0;
let healthy = false;
let calls = 0;
const cb = new CircuitBreaker(async (x: number) => {
  calls++;
  if (!healthy) throw new Error('service down');
  return x * 2;
}, { failureThreshold: 3, resetTimeoutMs: 1000, now: () => now });

for (let i = 0; i < 3; i++) await assert.rejects(cb.call(1), /service down/);
assert.equal(cb.state, 'open');
await assert.rejects(cb.call(1), CircuitOpenError);
assert.equal(calls, 3); // fn not called while open

now = 1000;
await assert.rejects(cb.call(1), /service down/); // trial fails
assert.equal(cb.state, 'open');
now = 1500;
await assert.rejects(cb.call(1), CircuitOpenError); // cool-down restarted at t=1000

now = 2000;
healthy = true;
assert.equal(await cb.call(21), 42);
assert.equal(cb.state, 'closed');

// A success resets the consecutive failure count.
healthy = false;
await assert.rejects(cb.call(1));
await assert.rejects(cb.call(1));
healthy = true;
await cb.call(1);
healthy = false;
await assert.rejects(cb.call(1));
assert.equal(cb.state, 'closed');
```

</details>

</details>

---

<a id="node-42"></a>
### node-42. Idempotency-Key middleware

*Middleware · Hard*

Clients retry `POST /payments` on timeouts, which can charge twice. Write `idempotent(store, handler)` that wraps a handler `(req) => Promise<{ status, body }>`:
- No `idempotency-key` header: just call the handler.
- First request with a key: mark it in progress, run the handler, store the response.
- Same key again after completion: return the stored response with header `idempotent-replayed: true`, without running the handler.
- Same key while the first is still running: `409`.
- Same key with a different body: `422`.
- If the handler throws, forget the key so the client can retry.

**Starter**

```ts
export interface Req { method: string; headers: Record<string, string | undefined>; body: unknown }
export interface Res { status: number; body: unknown; headers?: Record<string, string> }

export function idempotent(store: unknown, handler: (req: Req) => Promise<Res>): (req: Req) => Promise<Res> {
  // TODO
  throw new Error('not implemented');
}
```

<details>
<summary>Solution</summary>

```ts
import { createHash } from 'node:crypto';

export interface Req { method: string; headers: Record<string, string | undefined>; body: unknown }
export interface Res { status: number; body: unknown; headers?: Record<string, string> }

type IdemRecord = { fingerprint: string; state: 'in_progress' | 'done'; response?: Res };

export interface IdempotencyStore {
  // Must be atomic (e.g. Redis SET key value NX EX ttl, or a unique DB constraint).
  createIfAbsent(key: string, record: IdemRecord): Promise<boolean>;
  get(key: string): Promise<IdemRecord | undefined>;
  set(key: string, record: IdemRecord): Promise<void>;
  delete(key: string): Promise<void>;
}

export class MemoryStore implements IdempotencyStore {
  #map = new Map<string, IdemRecord>();
  async createIfAbsent(key: string, record: IdemRecord) {
    if (this.#map.has(key)) return false;
    this.#map.set(key, record);
    return true;
  }
  async get(key: string) { return this.#map.get(key); }
  async set(key: string, record: IdemRecord) { this.#map.set(key, record); }
  async delete(key: string) { this.#map.delete(key); }
}

const fingerprintOf = (req: Req) => createHash('sha256').update(JSON.stringify(req.body ?? null)).digest('hex');

export function idempotent(store: IdempotencyStore, handler: (req: Req) => Promise<Res>): (req: Req) => Promise<Res> {
  return async (req) => {
    const key = req.headers['idempotency-key'];
    if (!key) return handler(req);

    const fingerprint = fingerprintOf(req);
    const created = await store.createIfAbsent(key, { fingerprint, state: 'in_progress' });

    if (!created) {
      const existing = await store.get(key);
      if (!existing) return { status: 409, body: { error: 'Request state changed, retry' } };
      if (existing.fingerprint !== fingerprint) {
        return { status: 422, body: { error: 'Idempotency-Key reused with a different request body' } };
      }
      if (existing.state === 'in_progress') {
        return { status: 409, body: { error: 'A request with this Idempotency-Key is in progress' } };
      }
      const stored = existing.response!;
      return { ...stored, headers: { ...stored.headers, 'idempotent-replayed': 'true' } };
    }

    try {
      const response = await handler(req);
      await store.set(key, { fingerprint, state: 'done', response });
      return response;
    } catch (err) {
      await store.delete(key); // nothing was committed, so a retry may run again
      throw err;
    }
  };
}
```

**Why it works.** The key must be claimed atomically (insert-if-absent) so two concurrent retries cannot both run the handler; the loser sees `in_progress` and gets 409. After completion, the stored response is replayed so the client sees the same result as the first call. A body fingerprint catches clients reusing a key for a different operation. On failure the key is deleted so a retry can run. In production, scope keys per user, set a TTL (e.g. 24 h), and write the stored response in the same transaction as the business change where possible.

**Say it.** I atomically claim the key as in-progress, run the handler once, store its response for replays, return 409 for concurrent duplicates and 422 for a mismatched body, and release the key if the handler fails.

**Follow-up.** Q: What if the process crashes after charging the card but before storing the response? A: The key stays in_progress until its TTL expires; to be safe, pass the idempotency key to the payment provider too and record the result in the same DB transaction as the payment row.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

let charges = 0;
let failNext = false;
const handler = async (req: Req): Promise<Res> => {
  await new Promise((r) => setTimeout(r, 20));
  if (failNext) { failNext = false; throw new Error('gateway timeout'); }
  charges++;
  return { status: 201, body: { paymentId: `p${charges}`, amount: (req.body as any).amount } };
};
const pay = idempotent(new MemoryStore(), handler);
const req = (key: string | undefined, amount = 100): Req => ({ method: 'POST', headers: { 'idempotency-key': key }, body: { amount } });

const [first, concurrent] = await Promise.all([pay(req('k1')), pay(req('k1'))]);
assert.equal(first.status, 201);
assert.equal(concurrent.status, 409);

const replay = await pay(req('k1'));
assert.deepEqual(replay.body, first.body);
assert.equal(replay.headers?.['idempotent-replayed'], 'true');
assert.equal(charges, 1);

assert.equal((await pay(req('k1', 999))).status, 422);

failNext = true;
await assert.rejects(pay(req('k2')), /gateway timeout/);
assert.equal((await pay(req('k2'))).status, 201); // retry allowed after failure
await pay(req(undefined));
await pay(req(undefined));
assert.equal(charges, 4);
```

</details>

</details>

---

<a id="node-43"></a>
### node-43. Verify an HMAC webhook signature

*Security · Medium*

A payment provider sends webhooks with header `signature: t=<unix seconds>,v1=<hex>`, where `v1 = HMAC_SHA256(secret, "<t>.<rawBody>")`. Write `verifyWebhook({ rawBody, header, secret, toleranceSec = 300, now })` that returns `true` only if the signature matches and the timestamp is within tolerance. Compare in constant time. Also write `signWebhook` for tests.

```ts
verifyWebhook({ rawBody, header: signWebhook(rawBody, secret, t), secret, now: () => t * 1000 }) // true
// body changed, wrong secret, timestamp 10 minutes old, malformed header -> false
```

**Starter**

```ts
export function verifyWebhook(opts: {
  rawBody: string | Buffer;
  header: string | undefined;
  secret: string;
  toleranceSec?: number;
  now?: () => number;
}): boolean {
  // TODO
  throw new Error('not implemented');
}
```

<details>
<summary>Solution</summary>

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

function computeSignature(rawBody: string | Buffer, secret: string, timestamp: number): string {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
}

export function signWebhook(rawBody: string | Buffer, secret: string, timestamp: number): string {
  return `t=${timestamp},v1=${computeSignature(rawBody, secret, timestamp)}`;
}

export function verifyWebhook(opts: {
  rawBody: string | Buffer;
  header: string | undefined;
  secret: string;
  toleranceSec?: number;
  now?: () => number;
}): boolean {
  const { rawBody, header, secret, toleranceSec = 300, now = Date.now } = opts;
  if (!header) return false;

  const parts = new Map(
    header.split(',').map((part) => {
      const [k, ...rest] = part.trim().split('=');
      return [k, rest.join('=')] as const;
    }),
  );
  const timestamp = Number(parts.get('t'));
  const received = parts.get('v1');
  if (!Number.isInteger(timestamp) || !received || !/^[0-9a-f]+$/i.test(received)) return false;

  // Reject old (or far-future) timestamps to stop replay attacks.
  if (Math.abs(now() / 1000 - timestamp) > toleranceSec) return false;

  const expected = Buffer.from(computeSignature(rawBody, secret, timestamp), 'hex');
  const actual = Buffer.from(received, 'hex');
  // timingSafeEqual throws if lengths differ, so check first.
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
```

**Why it works.** Recompute the HMAC over the exact raw bytes of the body (not re-serialized JSON, which may differ in whitespace or key order) prefixed with the timestamp, then compare. `===` on strings can return early at the first different character, leaking timing information; `crypto.timingSafeEqual` compares in constant time but throws on different lengths, so check length first. The timestamp is part of the signed data, so an attacker cannot change it, and the tolerance window blocks replays of old captured requests.

**Say it.** I recompute HMAC-SHA256 over the timestamp and raw body, reject stale timestamps to prevent replays, and compare with timingSafeEqual after a length check.

**Follow-up.** Q: In Express, why does verification fail after `express.json()`? A: The body is already parsed, and re-stringifying changes bytes. Use `express.raw({ type: 'application/json' })` for the webhook route (or the `verify` option to keep the raw buffer), verify, then parse.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

const secret = 'whsec_test';
const rawBody = '{"id":"evt_1","type":"payment.succeeded"}';
const t = 1_700_000_000;
const now = () => t * 1000 + 5_000;
const header = signWebhook(rawBody, secret, t);

assert.equal(verifyWebhook({ rawBody, header, secret, now }), true);
assert.equal(verifyWebhook({ rawBody: Buffer.from(rawBody), header, secret, now }), true);
assert.equal(verifyWebhook({ rawBody: rawBody.replace('evt_1', 'evt_2'), header, secret, now }), false);
assert.equal(verifyWebhook({ rawBody, header, secret: 'wrong', now }), false);
assert.equal(verifyWebhook({ rawBody, header, secret, now: () => (t + 600) * 1000 }), false);
assert.equal(verifyWebhook({ rawBody, header: `t=${t},v1=abcd`, secret, now }), false); // short signature, no throw
assert.equal(verifyWebhook({ rawBody, header: 'garbage', secret, now }), false);
assert.equal(verifyWebhook({ rawBody, header: undefined, secret, now }), false);
```

</details>

</details>

---

<a id="node-44"></a>
### node-44. Hash and verify passwords with scrypt

*Security · Easy*

Write `hashPassword(password)` and `verifyPassword(password, stored)` using `crypto.scrypt` with a random 16-byte salt. Store the result as one string `salt:hash` (hex). Verification must use a constant-time comparison and return `false` (not throw) for malformed stored values.

```ts
const stored = await hashPassword('hunter2');   // 'a3f1...:9bc0...'
await verifyPassword('hunter2', stored)          // true
await verifyPassword('wrong', stored)            // false
```

**Starter**

```ts
export async function hashPassword(password: string): Promise<string> {
  // TODO
  throw new Error('not implemented');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  // TODO
  throw new Error('not implemented');
}
```

<details>
<summary>Solution</summary>

```ts
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16); // unique per user, defeats rainbow tables
  const hash = await scryptAsync(password, salt, KEY_LENGTH);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  if (expected.length !== KEY_LENGTH) return false;
  const actual = await scryptAsync(password, Buffer.from(saltHex, 'hex'), KEY_LENGTH);
  return timingSafeEqual(actual, expected);
}
```

**Why it works.** Passwords need a slow, memory-hard KDF (scrypt, argon2, bcrypt), not a fast hash like SHA-256, so brute-forcing leaked hashes is expensive. A random salt per password makes identical passwords hash differently. Use the async `scrypt`: the sync version blocks the event loop for tens of milliseconds per login (async runs on the libuv threadpool). Compare with `timingSafeEqual` after checking lengths. In production, also store the cost parameters (N, r, p) in the string so you can raise them later and rehash on login.

**Say it.** I derive a key with async scrypt and a random per-user salt, store salt and hash together, and on login recompute with the stored salt and compare with timingSafeEqual.

**Follow-up.** Q: Why can many concurrent logins slow down unrelated file I/O? A: Async crypto and fs share the libuv threadpool (4 threads by default); heavy scrypt load queues fs work behind it. Increase UV_THREADPOOL_SIZE or rate-limit login attempts.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

const stored = await hashPassword('hunter2');
assert.match(stored, /^[0-9a-f]{32}:[0-9a-f]{128}$/);
assert.equal(await verifyPassword('hunter2', stored), true);
assert.equal(await verifyPassword('hunter3', stored), false);
assert.notEqual(await hashPassword('hunter2'), stored); // different salt each time
assert.equal(await verifyPassword('hunter2', 'garbage'), false);
assert.equal(await verifyPassword('hunter2', 'abcd:1234'), false);
```

</details>

</details>

---

<a id="node-45"></a>
### node-45. Cancel a long async job with AbortController

*Cancellation · Medium*

Write `processAll(items, worker, { signal, timeoutMs })` that processes items one by one with `worker(item, signal)`. It must stop as soon as the caller aborts the signal or `timeoutMs` passes, reject with the abort reason, and pass the signal down so the current item's work is cancelled too.

```ts
const ac = new AbortController();
const job = processAll(files, uploadFile, { signal: ac.signal, timeoutMs: 30_000 });
cancelButton.onclick = () => ac.abort(); // job rejects with AbortError, upload stops
```

**Starter**

```ts
export async function processAll<T>(
  items: T[],
  worker: (item: T, signal: AbortSignal) => Promise<void>,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<number> {
  // TODO: return the number of processed items
  throw new Error('not implemented');
}
```

<details>
<summary>Solution</summary>

```ts
export async function processAll<T>(
  items: T[],
  worker: (item: T, signal: AbortSignal) => Promise<void>,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<number> {
  const signals: AbortSignal[] = [];
  if (opts.signal) signals.push(opts.signal);
  if (opts.timeoutMs !== undefined) signals.push(AbortSignal.timeout(opts.timeoutMs));
  // One signal that aborts when either the caller aborts or the deadline passes.
  const signal = AbortSignal.any(signals);

  let done = 0;
  for (const item of items) {
    signal.throwIfAborted(); // stop between items
    try {
      await worker(item, signal); // and let the worker stop mid-item
    } catch (err) {
      // Workers often wrap the reason in their own AbortError; surface the real one.
      if (signal.aborted) throw signal.reason;
      throw err;
    }
    done++;
  }
  return done;
}
```

**Why it works.** `AbortSignal.any` merges the caller's signal with `AbortSignal.timeout`, so there is one signal to check and pass down. `throwIfAborted()` stops the loop between items, and passing the signal to the worker (which forwards it to `fetch`, streams, `timers/promises` or DB drivers) cancels the in-progress item instead of waiting for it. Workers often reject with their own generic AbortError, so if the signal is aborted we rethrow `signal.reason`. The reason is an `AbortError` for a plain `abort()` or a `TimeoutError` for the deadline, so callers can tell them apart. Trap: only checking a flag between items means a single slow item can still run for minutes.

**Say it.** I combine the caller's signal and a timeout signal with AbortSignal.any, check it before each item and pass it into the worker so in-flight work is cancelled too.

**Follow-up.** Q: How do you cancel work when an HTTP client disconnects? A: Create an AbortController per request, abort it on `res.on('close')` if the response has not finished, and pass its signal to downstream calls.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const processed: number[] = [];
const worker = async (n: number, signal: AbortSignal) => {
  await delay(10, undefined, { signal });
  processed.push(n);
};
const items = Array.from({ length: 20 }, (_, i) => i);

assert.equal(await processAll([1, 2], worker), 2);

processed.length = 0;
const ac = new AbortController();
setTimeout(() => ac.abort(), 35);
const t0 = Date.now();
await assert.rejects(processAll(items, worker, { signal: ac.signal }), { name: 'AbortError' });
assert.ok(processed.length >= 1 && processed.length < 5);
assert.ok(Date.now() - t0 < 100);

processed.length = 0;
await assert.rejects(processAll(items, worker, { timeoutMs: 30 }), { name: 'TimeoutError' });
assert.ok(processed.length < 5);

await assert.rejects(processAll(items, worker, { signal: AbortSignal.abort(new Error('cancelled by user')) }), /cancelled by user/);
```

</details>

</details>

---

<a id="node-46"></a>
### node-46. Offload CPU work to a worker thread

*worker_threads · Medium*

`GET /report` computes something CPU-heavy (here: a naive recursive Fibonacci) and every other request stalls while it runs. Write `fibInWorker(n, { signal })` that runs the computation in a `worker_threads` Worker and resolves with the result. Reject if the worker throws or exits abnormally, and terminate it if the signal aborts.

```ts
await fibInWorker(25) // 75025, while the main event loop stays responsive
```

**Starter**

```ts
import { Worker } from 'node:worker_threads';

export function fibInWorker(n: number, opts: { signal?: AbortSignal } = {}): Promise<number> {
  // TODO
  throw new Error('not implemented');
}
```

<details>
<summary>Solution</summary>

```ts
import { Worker } from 'node:worker_threads';

// Inline worker source (CommonJS); in a real project this would be a separate file.
const workerSource = `
const { parentPort, workerData } = require('node:worker_threads');
function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
if (!Number.isInteger(workerData) || workerData < 0) throw new RangeError('n must be a non-negative integer');
parentPort.postMessage(fib(workerData));
`;

export function fibInWorker(n: number, opts: { signal?: AbortSignal } = {}): Promise<number> {
  const { signal } = opts;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);

    const worker = new Worker(workerSource, { eval: true, workerData: n });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => {
      finish(() => reject(signal!.reason));
      worker.terminate();
    };

    worker.once('message', (result: number) => finish(() => resolve(result)));
    worker.once('error', (err) => finish(() => reject(err)));
    worker.once('exit', (code) => finish(() => reject(new Error(`Worker exited with code ${code}`))));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
```

**Why it works.** JavaScript runs on one thread, so a long CPU-bound function blocks every request. A Worker runs in its own thread with its own event loop and V8 isolate; data goes in via `workerData` or `postMessage` (structured clone) and the result comes back as a message. Listen for `error` (uncaught exception in the worker) and `exit` (crash or terminate) as well as `message`, and settle only once. `terminate()` gives real cancellation, unlike a promise. Creating a worker costs tens of milliseconds, so production code uses a pool (e.g. Piscina) sized to the CPU count.

**Say it.** I move the CPU-heavy function into a worker thread, get the result back as a message, reject on error or abnormal exit, and terminate the worker on abort, so the main event loop stays free.

**Follow-up.** Q: Would you use worker_threads for slow database queries? A: No, those are I/O and already async; workers help only with CPU-bound work like image processing, compression, parsing huge JSON or crypto in JS. For I/O, more threads add nothing.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

let ticks = 0;
const interval = setInterval(() => ticks++, 2);
try {
  const [a, b] = await Promise.all([fibInWorker(25), fibInWorker(30)]);
  assert.equal(a, 75025);
  assert.equal(b, 832040);
  assert.ok(ticks > 0, 'main thread stayed responsive');

  await assert.rejects(fibInWorker(-1), RangeError);

  const ac = new AbortController();
  const t0 = Date.now();
  const p = fibInWorker(45, { signal: ac.signal }); // would take many seconds
  setTimeout(() => ac.abort(), 30);
  await assert.rejects(p, { name: 'AbortError' });
  assert.ok(Date.now() - t0 < 500);
} finally {
  clearInterval(interval);
}
```

</details>

</details>

---

<a id="node-47"></a>
### node-47. Base64, base64url and decoding a JWT payload

*Buffer · Easy*

1. Implement `toBase64Url(input)` and `fromBase64Url(str)` yourself on top of standard base64 (do not use the `'base64url'` encoding).
2. Implement `decodeJwtPayload(token)` that returns the parsed JSON payload of a JWT (no signature check).

```ts
toBase64Url('hello?>')            // 'aGVsbG8_Pg'   (base64 is 'aGVsbG8/Pg==')
fromBase64Url('aGVsbG8_Pg').toString() // 'hello?>'
decodeJwtPayload('xxx.eyJzdWIiOiIxMjMifQ.yyy') // { sub: '123' }
```

**Starter**

```ts
export function toBase64Url(input: string | Buffer): string {
  throw new Error('not implemented');
}
export function fromBase64Url(str: string): Buffer {
  throw new Error('not implemented');
}
export function decodeJwtPayload(token: string): unknown {
  throw new Error('not implemented');
}
```

<details>
<summary>Solution</summary>

```ts
export function toBase64Url(input: string | Buffer): string {
  return Buffer.from(input) // strings are encoded as UTF-8
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function fromBase64Url(str: string): Buffer {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

export function decodeJwtPayload(token: string): unknown {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT: expected 3 parts');
  return JSON.parse(fromBase64Url(parts[1]).toString('utf8'));
}
```

**Why it works.** Base64 encodes every 3 bytes as 4 characters from `A-Z a-z 0-9 + /`, padding with `=`. Base64url swaps `+` and `/` for URL-safe `-` and `_` and drops padding, which is why JWTs and many tokens use it. Decoding reverses the swap and restores padding to a multiple of 4. Always go through Buffer with an explicit encoding: `btoa` only handles Latin-1, so emoji or Cyrillic break it. Decoding a JWT payload is not verification: never trust its claims without checking the signature.

**Say it.** I base64-encode the UTF-8 bytes, swap plus and slash for dash and underscore and strip padding; decoding reverses that and re-pads to a multiple of four.

**Follow-up.** Q: Node already supports `'base64url'`, so when would you write this? A: You wouldn't in Node (use `buf.toString('base64url')`); but you'd need it in environments without it, and interviewers use it to check you understand the encoding and padding.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

assert.equal(toBase64Url('hello?>'), 'aGVsbG8_Pg');
assert.equal(fromBase64Url('aGVsbG8_Pg').toString(), 'hello?>');
for (const s of ['', 'a', 'ab', 'abc', 'Привіт 👋', 'ÿþ']) {
  assert.equal(toBase64Url(s), Buffer.from(s).toString('base64url'));
  assert.equal(fromBase64Url(toBase64Url(s)).toString(), s);
}
const bin = Buffer.from([0xfb, 0xff, 0xbf]);
assert.equal(toBase64Url(bin), '-_-_');
assert.deepEqual(fromBase64Url('-_-_'), bin);

const token = ['{"alg":"HS256"}', '{"sub":"123","name":"Анна"}'].map((p) => toBase64Url(p)).join('.') + '.sig';
assert.deepEqual(decodeJwtPayload(token), { sub: '123', name: 'Анна' });
assert.throws(() => decodeJwtPayload('not-a-jwt'), /3 parts/);
```

</details>

</details>

---

<a id="node-48"></a>
### node-48. Walk a directory tree recursively

*File system · Easy*

Write an async generator `walk(dir, { ignore })` that yields the path of every file under `dir`, recursing into subdirectories and skipping directory names in `ignore` (e.g. `node_modules`, `.git`). Then write `findByExtension(dir, ext)` returning a sorted array.

```ts
for await (const file of walk('src', { ignore: ['node_modules'] })) console.log(file);
await findByExtension('src', '.ts') // ['src/a.ts', 'src/lib/b.ts']
```

**Starter**

```ts
export async function* walk(dir: string, opts: { ignore?: string[] } = {}): AsyncGenerator<string> {
  // TODO
}

export async function findByExtension(dir: string, ext: string): Promise<string[]> {
  // TODO
  throw new Error('not implemented');
}
```

<details>
<summary>Solution</summary>

```ts
import { readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';

export async function* walk(dir: string, opts: { ignore?: string[] } = {}): AsyncGenerator<string> {
  const ignore = new Set(opts.ignore ?? []);
  // withFileTypes avoids an extra stat() call per entry.
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!ignore.has(entry.name)) yield* walk(full, opts);
    } else if (entry.isFile()) {
      yield full;
    }
    // Symlinks are skipped on purpose: following them can loop forever.
  }
}

export async function findByExtension(dir: string, ext: string): Promise<string[]> {
  const result: string[] = [];
  for await (const file of walk(dir, { ignore: ['node_modules', '.git'] })) {
    if (extname(file) === ext) result.push(file);
  }
  return result.sort();
}
```

**Why it works.** `readdir` with `withFileTypes: true` returns `Dirent` objects, so you can tell files from directories without a `stat` per entry. The async generator recurses with `yield*` and streams paths lazily, so the caller can stop early and memory does not grow with the tree size (only with its depth). Skipping symlinks avoids cycles. Use `path.join`, not string concatenation, for cross-platform separators. Node 20+ also has `readdir(dir, { recursive: true })` and `fs.promises.glob` (Node 22) for simple cases.

**Say it.** I read each directory with withFileTypes, yield files and recurse into subdirectories with yield star, skipping ignored names and symlinks, so it streams paths lazily.

**Follow-up.** Q: How would you speed this up for a huge tree? A: Read sibling directories in parallel with a concurrency limit (e.g. 16) instead of one at a time; disk and the libuv threadpool handle parallel readdir calls well.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const root = await mkdtemp(join(tmpdir(), 'walk-'));
try {
  await mkdir(join(root, 'lib', 'deep'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(join(root, 'a.ts'), '');
  await writeFile(join(root, 'readme.md'), '');
  await writeFile(join(root, 'lib', 'b.ts'), '');
  await writeFile(join(root, 'lib', 'deep', 'c.ts'), '');
  await writeFile(join(root, 'node_modules', 'pkg', 'index.ts'), '');
  await symlink(root, join(root, 'lib', 'loop'));

  assert.deepEqual(await findByExtension(root, '.ts'), [
    join(root, 'a.ts'), join(root, 'lib', 'b.ts'), join(root, 'lib', 'deep', 'c.ts'),
  ].sort());

  const all: string[] = [];
  for await (const f of walk(root)) all.push(f);
  assert.equal(all.length, 5);

  const first: string[] = [];
  for await (const f of walk(root)) { first.push(f); break; }
  assert.equal(first.length, 1);
} finally {
  await rm(root, { recursive: true, force: true });
}
```

</details>

</details>

---

<a id="node-49"></a>
### node-49. Batch writes by size or time

*Batching · Medium*

Writing analytics events to the DB one by one is too slow. Build `Batcher({ maxSize, maxWaitMs, flush })`:
- `add(item)` returns a promise that resolves when the batch containing the item is flushed (rejects if that flush fails).
- Flush when the batch reaches `maxSize`, or `maxWaitMs` after its first item, whichever comes first.
- `close()` flushes what is left; `add` after close throws.

```ts
const b = new Batcher({ maxSize: 100, maxWaitMs: 50, flush: (rows) => db.insertMany(rows) });
await b.add(event); // resolves once it's in the DB
```

**Starter**

```ts
export class Batcher<T> {
  constructor(opts: { maxSize: number; maxWaitMs: number; flush: (items: T[]) => Promise<void> }) {}
  add(item: T): Promise<void> { throw new Error('not implemented'); }
  close(): Promise<void> { throw new Error('not implemented'); }
}
```

<details>
<summary>Solution</summary>

```ts
type Batch<T> = {
  items: T[];
  waiters: { resolve: () => void; reject: (err: unknown) => void }[];
  timer?: NodeJS.Timeout;
};

export class Batcher<T> {
  #maxSize: number;
  #maxWaitMs: number;
  #flushFn: (items: T[]) => Promise<void>;
  #current: Batch<T> = { items: [], waiters: [] };
  #inFlight = new Set<Promise<void>>();
  #closed = false;

  constructor(opts: { maxSize: number; maxWaitMs: number; flush: (items: T[]) => Promise<void> }) {
    this.#maxSize = opts.maxSize;
    this.#maxWaitMs = opts.maxWaitMs;
    this.#flushFn = opts.flush;
  }

  add(item: T): Promise<void> {
    if (this.#closed) throw new Error('Batcher is closed');
    const batch = this.#current;
    const done = new Promise<void>((resolve, reject) => batch.waiters.push({ resolve, reject }));
    batch.items.push(item);
    if (batch.items.length === 1) {
      batch.timer = setTimeout(() => this.#flushCurrent(), this.#maxWaitMs);
    }
    if (batch.items.length >= this.#maxSize) this.#flushCurrent();
    return done;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#flushCurrent();
    await Promise.allSettled([...this.#inFlight]);
  }

  #flushCurrent() {
    const batch = this.#current;
    if (batch.items.length === 0) return;
    clearTimeout(batch.timer);
    this.#current = { items: [], waiters: [] }; // new adds go to a fresh batch

    const p = this.#flushFn(batch.items).then(
      () => batch.waiters.forEach((w) => w.resolve()),
      (err) => batch.waiters.forEach((w) => w.reject(err)),
    );
    this.#inFlight.add(p);
    p.finally(() => this.#inFlight.delete(p));
  }
}
```

**Why it works.** Items collect in the current batch; the first item starts a timer and reaching `maxSize` flushes immediately, so latency is bounded by `maxWaitMs` and batch size by `maxSize`. Swapping in a fresh batch before calling `flush` means new adds never mix into a batch being written. Each caller gets a promise tied to its batch, so errors reach the right callers. `close()` (call it during graceful shutdown) flushes the rest and waits for in-flight writes so no data is lost. Trap: forgetting to clear the timer, which then flushes a later batch early.

**Say it.** I buffer items, start a timer on the first one and flush on size or timeout, swap in a fresh batch before writing, and resolve or reject each caller's promise with its batch result.

**Follow-up.** Q: What if the DB is down and events keep coming? A: Bound memory: cap the number of in-flight batches or buffered items and apply backpressure (make add wait) or drop and count events; retry failed batches with backoff, or spill to a durable queue.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

const flushed: number[][] = [];
let fail = false;
const b = new Batcher<number>({
  maxSize: 3,
  maxWaitMs: 20,
  flush: async (items) => {
    await new Promise((r) => setTimeout(r, 5));
    if (fail) throw new Error('db down');
    flushed.push(items);
  },
});

const t0 = Date.now();
await Promise.all([1, 2, 3, 4, 5, 6, 7].map((n) => b.add(n)));
assert.deepEqual(flushed, [[1, 2, 3], [4, 5, 6], [7]]);
assert.ok(Date.now() - t0 >= 15); // the last item waited for maxWaitMs

fail = true;
await assert.rejects(Promise.all([b.add(8), b.add(9)]), /db down/);
fail = false;

const last = b.add(10);
await b.close();
await last;
assert.deepEqual(flushed.at(-1), [10]);
assert.throws(() => b.add(11), /closed/);
```

</details>

</details>

---

<a id="node-50"></a>
### node-50. Request context with AsyncLocalStorage

*AsyncLocalStorage · Easy*

Every log line should include the current request id, without passing it through every function. Using `AsyncLocalStorage`:
- `requestContext(req, handler)` reads `x-request-id` (or generates a UUID) and runs `handler` inside that context.
- `log(msg)` returns and records `"[<id>] msg"`, or `"[-] msg"` outside a request.

Concurrent requests must never see each other's id, across `await`s and timers.

**Starter**

```ts
export const lines: string[] = [];

export function requestContext<T>(req: { headers: Record<string, string | undefined> }, handler: () => Promise<T>): Promise<T> {
  // TODO
  throw new Error('not implemented');
}

export function log(msg: string): string {
  // TODO
  throw new Error('not implemented');
}
```

<details>
<summary>Solution</summary>

```ts
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

type Context = { requestId: string };
const storage = new AsyncLocalStorage<Context>();
export const lines: string[] = [];

export function requestContext<T>(req: { headers: Record<string, string | undefined> }, handler: () => Promise<T>): Promise<T> {
  const requestId = req.headers['x-request-id'] ?? randomUUID();
  // Everything started inside run(), including later awaits and timers, sees this store.
  return storage.run({ requestId }, handler);
}

export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

export function log(msg: string): string {
  const line = `[${currentRequestId() ?? '-'}] ${msg}`;
  lines.push(line);
  return line;
}
```

**Why it works.** `AsyncLocalStorage.run(store, fn)` attaches `store` to the async context created by `fn`; promises, timers and I/O callbacks started inside it inherit that context, so `getStore()` returns the right value even after many `await`s, while concurrent requests have separate contexts. This is how loggers (pino with mixins), tracing (OpenTelemetry) and ORMs carry request-scoped data. Trap: a module-level `let currentRequestId` gets overwritten by whichever request ran last, because requests interleave at every `await`.

**Say it.** I run each request's handler inside AsyncLocalStorage.run with its id, and anywhere downstream getStore returns that request's context, even across awaits and timers.

**Follow-up.** Q: How would you use it in Express? A: Add an early middleware: `app.use((req, res, next) => storage.run({ requestId }, next))`; everything later in the chain for that request, including async route handlers, sees the store.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function handler(name: string, ms: number) {
  log(`${name} start`);
  await wait(ms);
  await new Promise<void>((r) => setTimeout(() => { log(`${name} timer`); r(); }, 1));
  return log(`${name} end`);
}

const [a, b] = await Promise.all([
  requestContext({ headers: { 'x-request-id': 'req-A' } }, () => handler('a', 20)),
  requestContext({ headers: { 'x-request-id': 'req-B' } }, () => handler('b', 5)),
]);
assert.equal(a, '[req-A] a end');
assert.equal(b, '[req-B] b end');
assert.ok(lines.filter((l) => l.includes(' a ')).every((l) => l.startsWith('[req-A]')));
assert.ok(lines.filter((l) => l.includes(' b ')).every((l) => l.startsWith('[req-B]')));
assert.equal(lines.length, 6);

assert.equal(log('outside'), '[-] outside');
const generated = await requestContext({ headers: {} }, async () => currentRequestId());
assert.match(generated!, /^[0-9a-f-]{36}$/);
```

</details>

</details>

---

