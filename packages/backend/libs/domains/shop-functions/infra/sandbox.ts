import ivm from 'isolated-vm';
import { createHash } from 'node:crypto';
import { FunctionInput, FunctionOutput } from '../domain/contract';

export type SandboxResult = { ok: true; output: FunctionOutput; ms: number } | { ok: false; error: 'timeout' | 'memory' | 'invalid-output' | 'runtime'; detail: string; ms: number };

const MEMORY_MB = 32;
const MAX_CACHED = 200;

interface Compiled {
  isolate: ivm.Isolate;
  context: ivm.Context;
  run: ivm.Reference<(input: string) => string>;
}

/**
 * Untrusted seller JavaScript (05/01 §7.6). Each function version gets its own
 * V8 ISOLATE (isolated-vm): separate heap with a hard memory cap, wall-clock
 * timeout, and NO Node APIs at all - no require, process, fs, fetch, timers.
 * (`node:vm` is explicitly NOT a sandbox: shared heap, prototype escapes.)
 * Isolates are compiled once per source hash and reused (LRU); any timeout or
 * OOM disposes the isolate, since its state is no longer trustworthy.
 * Process-level isolation (separate container, no network, read-only FS,
 * non-root, seccomp) is the second wall - see the section doc.
 */
export class FunctionSandbox {
  private readonly cache = new Map<string, Promise<Compiled>>();

  static hash(source: string) {
    return createHash('sha256').update(source).digest('hex');
  }

  async run(source: string, input: FunctionInput, timeoutMs: number): Promise<SandboxResult> {
    const key = FunctionSandbox.hash(source);
    const started = performance.now();
    let compiled: Compiled;
    try {
      compiled = await this.compiled(key, source);
    } catch (error) {
      return { ok: false, error: 'runtime', detail: `compile: ${(error as Error).message}`, ms: performance.now() - started };
    }
    try {
      // Data crosses the boundary as a JSON string copy - no references into the host heap.
      const raw = await compiled.run.apply(undefined, [JSON.stringify(input)], { timeout: timeoutMs, result: { copy: true }, arguments: { copy: true } });
      const parsed = FunctionOutput.safeParse(JSON.parse(String(raw)));
      if (!parsed.success) return { ok: false, error: 'invalid-output', detail: parsed.error.issues[0]?.message ?? 'invalid', ms: performance.now() - started };
      return { ok: true, output: parsed.data, ms: performance.now() - started };
    } catch (error) {
      const message = (error as Error).message;
      const kind = /timed out/i.test(message) ? 'timeout' : /memory|disposed/i.test(message) ? 'memory' : 'runtime';
      if (kind !== 'runtime' || compiled.isolate.isDisposed) this.evict(key);
      return { ok: false, error: kind, detail: message.slice(0, 300), ms: performance.now() - started };
    }
  }

  private compiled(key: string, source: string): Promise<Compiled> {
    let entry = this.cache.get(key);
    if (entry) {
      this.cache.delete(key); // LRU: re-insert as most recent
      this.cache.set(key, entry);
      return entry;
    }
    entry = (async () => {
      const isolate = new ivm.Isolate({ memoryLimit: MEMORY_MB });
      const context = await isolate.createContext();
      // Only the seller's code + a tiny JSON wrapper; the global has nothing but ECMAScript built-ins.
      const script = await isolate.compileScript(`${source}\n;globalThis.__entry = (json) => JSON.stringify(run(JSON.parse(json)));`, { filename: 'shop-function.js' });
      await script.run(context, { timeout: 50 });
      const run = (await context.global.get('__entry', { reference: true })) as ivm.Reference<(input: string) => string>;
      return { isolate, context, run };
    })();
    entry.catch(() => this.cache.delete(key));
    this.cache.set(key, entry);
    while (this.cache.size > MAX_CACHED) this.evict(this.cache.keys().next().value!);
    return entry;
  }

  private evict(key: string) {
    const entry = this.cache.get(key);
    this.cache.delete(key);
    void entry?.then((c) => !c.isolate.isDisposed && c.isolate.dispose()).catch(() => undefined);
  }

  dispose() {
    for (const key of [...this.cache.keys()]) this.evict(key);
  }
}
