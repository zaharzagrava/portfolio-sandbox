import ivm from 'isolated-vm';
import {
  OUTPUT_MAX_BYTES,
  validateOutput,
  type FunctionInput,
  type SandboxFailure,
  type SandboxResult,
} from '../domain/contract';
import { sourceHash } from '../domain/source-hash';

export type { SandboxFailure, SandboxResult };

export interface SandboxOptions {
  memoryMb?: number;
  /** Empty isolates kept ready; each is used once and destroyed. */
  poolSize?: number;
  /** Isolates alive at once; further runs wait. */
  concurrency?: number;
  outputMaxBytes?: number;
}

/**
 * Runs before the seller's code in the same fresh context. Removes what makes a function impure or lets it build code
 * from strings (S45 AS-14): the clock, randomness, `eval`, every `Function` constructor, WebAssembly and shared memory.
 * The globals Node would add (`require`, `process`, `fetch`, timers) do not exist in an isolate to begin with.
 */
const PRELUDE = `(function () {
  var g = globalThis;
  function deny(name, why) { return function () { throw new Error(name + ' is ' + why); }; }
  function lock(target, key, value) {
    Object.defineProperty(target, key, { value: value, writable: false, configurable: false, enumerable: false });
  }
  lock(g, 'eval', deny('eval', 'not allowed'));
  var blockedFunction = deny('Function constructor', 'not allowed');
  var protos = [
    Object.getPrototypeOf(function () {}),
    Object.getPrototypeOf(async function () {}),
    Object.getPrototypeOf(function* () {}),
    Object.getPrototypeOf(async function* () {}),
  ];
  for (var i = 0; i < protos.length; i++) {
    var ctor = protos[i].constructor;
    try { ctor.prototype.constructor = blockedFunction; } catch (e) {}
    try { lock(protos[i], 'constructor', blockedFunction); } catch (e) {}
  }
  lock(g, 'Function', blockedFunction);
  var BlockedDate = deny('Date', 'not available');
  BlockedDate.now = deny('Date.now', 'not available');
  lock(g, 'Date', BlockedDate);
  lock(Math, 'random', deny('Math.random', 'not available'));
  lock(g, 'WebAssembly', undefined);
  lock(g, 'SharedArrayBuffer', undefined);
  lock(g, 'Atomics', undefined);
})();`;

/**
 * The entry wrapper runs after the seller's source. Errors thrown by seller code are caught here and returned as data,
 * so anything that reaches the host as an exception is an isolate-level failure (timeout, memory) and can be told
 * from "the function threw" by the isolate's state and not by a message pattern (G-27).
 */
const ENTRY = `globalThis.__entry = function (json) {
  var out;
  try {
    if (typeof run !== 'function') return JSON.stringify({ k: 'entry-missing' });
    out = run(JSON.parse(json));
  } catch (e) {
    var d = '';
    try { d = String(e && e.message !== undefined ? e.message : e); } catch (x) { d = 'error'; }
    return JSON.stringify({ k: 'runtime', d: d.slice(0, 300) });
  }
  try {
    var s = JSON.stringify({ k: 'ok', v: out });
    return s === undefined ? JSON.stringify({ k: 'invalid', d: 'the function returned nothing' }) : s;
  } catch (e) {
    return JSON.stringify({ k: 'invalid', d: 'the result cannot be serialised' });
  }
};`;

class Semaphore {
  private waiting: Array<() => void> = [];
  private taken = 0;
  constructor(private readonly size: number) {}
  async acquire(): Promise<void> {
    if (this.taken < this.size) {
      this.taken++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }
  release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.taken--;
  }
}

/**
 * Untrusted seller JavaScript (S45 FR-022/FR-023). Every run gets a FRESH V8 isolate with its own heap capped at 32 MB
 * and a hardened global; it is destroyed when the run ends. Nothing is cached between runs or between shops, so no state
 * survives a run. A pool of empty single-use isolates is refilled in the background so a run does not pay for the
 * isolate's creation. Process-level isolation (the function-runner container) is the second wall for the judge.
 */
export class FunctionSandbox {
  private readonly memoryMb: number;
  private readonly poolSize: number;
  private readonly outputMax: number;
  private readonly gate: Semaphore;
  private pool: ivm.Isolate[] = [];
  private refilling = false;
  private disposed = false;
  /** Isolates alive right now (a test reads this to prove they are destroyed). */
  live = 0;

  constructor(options: SandboxOptions = {}) {
    this.memoryMb = options.memoryMb ?? 32;
    this.poolSize = options.poolSize ?? 4;
    this.outputMax = options.outputMaxBytes ?? OUTPUT_MAX_BYTES;
    this.gate = new Semaphore(options.concurrency ?? 8);
    // The pool fills after the first run: an app that never evaluates holds no isolate.
  }

  static hash(source: string) {
    return sourceHash(source);
  }

  async run(
    source: string,
    input: FunctionInput,
    timeoutMs: number,
  ): Promise<SandboxResult> {
    await this.gate.acquire();
    const started = performance.now();
    const isolate = this.take();
    let settled = false;
    const work = this.execute(
      isolate,
      source,
      input,
      timeoutMs,
      started,
    ).finally(() => {
      settled = true;
      this.destroy(isolate);
      this.gate.release();
      this.refill();
    });
    // The engine's time limit cannot interrupt a long native built-in (a huge `Array.fill` runs for seconds): the caller
    // is answered at the host-side deadline and the isolate is asked back; its slot frees when it really ends.
    let timer: NodeJS.Timeout | undefined;
    const guard = new Promise<SandboxResult>((resolve) => {
      timer = setTimeout(
        () => {
          if (settled) return;
          try {
            if (!isolate.isDisposed) isolate.dispose();
          } catch {
            // still running: it is destroyed when its call returns
          }
          resolve({
            ok: false,
            error: 'timeout',
            detail: 'time limit exceeded',
            ms: performance.now() - started,
          });
        },
        timeoutMs * 2 + 150,
      );
    });
    try {
      return await Promise.race([work, guard]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async execute(
    isolate: ivm.Isolate,
    source: string,
    input: FunctionInput,
    timeoutMs: number,
    started: number,
  ): Promise<SandboxResult> {
    const elapsed = () => performance.now() - started;
    const fail = (error: SandboxFailure, detail: string): SandboxResult => ({
      ok: false,
      error,
      detail: detail.slice(0, 300),
      ms: elapsed(),
    });
    try {
      const context = await isolate.createContext();
      await (
        await isolate.compileScript(PRELUDE, { filename: 'prelude.js' })
      ).run(context, { timeout: 1_000 });
      let script: ivm.Script;
      try {
        script = await isolate.compileScript(source, {
          filename: 'shop-function.js',
        });
      } catch (error) {
        return fail('compile-error', (error as Error).message);
      }
      try {
        await script.run(context, { timeout: timeoutMs });
      } catch (error) {
        return this.isolateFailure(isolate, error, fail, timeoutMs);
      }
      await (
        await isolate.compileScript(ENTRY, { filename: 'entry.js' })
      ).run(context, { timeout: 1_000 });
      const entry = (await context.global.get('__entry', {
        reference: true,
      })) as ivm.Reference<(json: string) => string>;
      let raw: unknown;
      try {
        // Data crosses the boundary as a JSON string copy - no references into the host heap.
        raw = await entry.apply(undefined, [JSON.stringify(input)], {
          timeout: timeoutMs,
          result: { copy: true },
          arguments: { copy: true },
        });
      } catch (error) {
        return this.isolateFailure(isolate, error, fail, timeoutMs);
      }
      if (typeof raw !== 'string') return fail('invalid-output', 'no result');
      const bytes = Buffer.byteLength(raw);
      if (bytes > this.outputMax + 64)
        return fail('invalid-output', 'output exceeds 64 KiB');
      let envelope: { k?: string; d?: string; v?: unknown };
      try {
        envelope = JSON.parse(raw);
      } catch {
        return fail('invalid-output', 'the result is not JSON');
      }
      if (envelope.k === 'entry-missing')
        return fail('entry-missing', 'define function run(input)');
      if (envelope.k === 'runtime')
        return fail('runtime', envelope.d ?? 'error');
      if (envelope.k !== 'ok')
        return fail('invalid-output', envelope.d ?? 'invalid');
      const checked = validateOutput(input, envelope.v, bytes);
      if (!checked.ok) return fail('invalid-output', checked.detail);
      return { ok: true, output: checked.output, ms: elapsed() };
    } catch (error) {
      return this.isolateFailure(isolate, error, fail, timeoutMs);
    }
  }

  /** An exception that reached the host is the isolate's own: out of memory (it is disposed) or out of time. */
  private isolateFailure(
    isolate: ivm.Isolate,
    error: unknown,
    fail: (error: SandboxFailure, detail: string) => SandboxResult,
    timeoutMs: number,
  ): SandboxResult {
    const message = (error as Error)?.message ?? 'error';
    if (isolate.isDisposed) {
      // Whether a runaway native call dies of the heap cap or of the host deadline is a race; a run that already spent
      // its whole time budget is a timeout either way.
      const result = fail('memory', 'memory limit exceeded');
      if (!result.ok && result.ms > timeoutMs)
        return fail('timeout', 'time limit exceeded');
      return result;
    }
    if (/timed out/i.test(message))
      return fail('timeout', 'time limit exceeded');
    return fail('runtime', message);
  }

  private take(): ivm.Isolate {
    this.live++;
    const ready = this.pool.pop();
    if (ready && !ready.isDisposed) return ready;
    return this.create();
  }

  private create(): ivm.Isolate {
    return new ivm.Isolate({ memoryLimit: this.memoryMb });
  }

  private destroy(isolate: ivm.Isolate) {
    if (!isolate.isDisposed) isolate.dispose();
    this.live--;
  }

  /** Tops the pool up in the background; never blocks a run. */
  private refill() {
    if (this.disposed || this.refilling || this.pool.length >= this.poolSize)
      return;
    this.refilling = true;
    setImmediate(() => {
      this.refilling = false;
      if (this.disposed) return;
      while (this.pool.length < this.poolSize) this.pool.push(this.create());
    });
  }

  dispose() {
    this.disposed = true;
    for (const isolate of this.pool.splice(0))
      if (!isolate.isDisposed) isolate.dispose();
  }
}
