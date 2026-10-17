import { FunctionSandbox } from './sandbox';
import { functionDiscounts } from '../domain/discount-amount';

const input = {
  currency: 'USD',
  lines: [
    { productId: 'p1', category: 'cases', quantity: 3, unitPriceMinor: 2_000 },
  ],
};
const VALID = `function run(input) { return { discounts: input.lines.filter(l => l.quantity >= 3).map((l, i) => ({ lineIndex: i, type: 'percentage', value: 15, message: '3+ cases: 15% off' })) }; }`;

/** The sandbox is the security boundary for seller code - real isolates, no mocks. */
describe('FunctionSandbox (isolated-vm)', () => {
  const sandbox = new FunctionSandbox();
  afterAll(() => sandbox.dispose());

  const failure = async (source: string, budget = 50) => {
    const res = await sandbox.run(source, input, budget);
    if (res.ok) throw new Error('expected a failure');
    return res;
  };

  it('S45 AS-14: runs a valid discount function and validates its output', async () => {
    const res = await sandbox.run(VALID, input, 50);
    expect(res).toMatchObject({
      ok: true,
      output: { discounts: [{ lineIndex: 0, value: 15 }] },
    });
  });

  it('S45 AS-14: kills infinite loops at the time budget', async () => {
    const res = await failure('function run() { while (true) {} }', 20);
    expect(res.error).toBe('timeout');
    expect(res.ms).toBeLessThan(220);
  });

  it('S45 AS-14: has no Node APIs: require / process / fetch / timers are not defined', async () => {
    for (const probe of [
      "require('fs')",
      'process.env',
      "fetch('http://example.com')",
      'setTimeout(function () {}, 1)',
    ]) {
      const res = await failure(
        `function run() { ${probe}; return { discounts: [] }; }`,
      );
      expect(res.error).toBe('runtime');
      expect(res.detail).toMatch(/not defined/);
    }
  });

  it('S45 AS-14: a memory bomb hits the isolate cap, only that runtime is destroyed, the next run works', async () => {
    const res = await failure(
      'function run() { var a = []; while (true) a.push(new Array(1e7).fill(1)); }',
      1_000,
    );
    expect(res.error).toBe('memory');
    const slow = await failure(
      'function run() { const a = []; while (true) a.push(new Array(1e6).fill(1)); }',
      2_000,
    );
    expect(slow.error).toBe('memory');
    expect(await sandbox.run(VALID, input, 50)).toMatchObject({ ok: true });
  });

  it('S45 AS-14: output is validated and clamped by the host', async () => {
    expect(
      await failure(
        `function run() { return { discounts: [{ lineIndex: 0, type: 'free money', value: 1, message: 'm' }] }; }`,
      ),
    ).toMatchObject({ error: 'invalid-output' });
    const lines = input.lines;
    expect(
      functionDiscounts(lines, {
        discounts: [
          { lineIndex: 0, type: 'percentage', value: 200, message: 'oops' },
        ],
      }),
    ).toEqual([6_000]);
    expect(
      functionDiscounts(lines, {
        discounts: [
          { lineIndex: 0, type: 'fixedPerUnit', value: 500, message: '-$5' },
        ],
      }),
    ).toEqual([1_500]);
  });

  it.each<[string, string]>([
    ['Date.now()', 'Date.now()'],
    ['new Date()', 'new Date()'],
    ['Math.random()', 'Math.random()'],
    ['eval', "eval('1 + 1')"],
    ['Function constructor', "Function('return 1')()"],
    ['constructor of a function', "(function () {}).constructor('return 1')()"],
    [
      'constructor of an async function',
      "(async function () {}).constructor('return 1')",
    ],
    [
      'globalThis.constructor escape',
      "globalThis.constructor.constructor('return process')()",
    ],
    ['dynamic import', "import('fs')"],
  ])(
    'S45 AS-14: %s is refused with a runtime failure',
    async (_name, probe) => {
      const res = await failure(
        `function run() { ${probe}; return { discounts: [] }; }`,
      );
      expect(res.error).toBe('runtime');
      expect(res.detail).toMatch(/not (defined|allowed|available|supported)/i);
    },
  );

  it('S45 AS-14: a throw whose message mentions memory is a runtime failure, not a memory failure', async () => {
    const res = await failure(
      "function run() { throw new Error('out of memory, disposed, timed out'); }",
    );
    expect(res.error).toBe('runtime');
  });

  it.each<[string, string]>([
    [
      'unknown type',
      "{ discounts: [{ lineIndex: 0, type: 'x', value: 1, message: 'm' }] }",
    ],
    [
      'zero value',
      "{ discounts: [{ lineIndex: 0, type: 'fixedPerUnit', value: 0, message: 'm' }] }",
    ],
    [
      'float fixedPerUnit',
      "{ discounts: [{ lineIndex: 0, type: 'fixedPerUnit', value: 1.5, message: 'm' }] }",
    ],
    [
      'non-integer lineIndex',
      "{ discounts: [{ lineIndex: 0.5, type: 'fixedPerUnit', value: 1, message: 'm' }] }",
    ],
    [
      'lineIndex outside the input',
      "{ discounts: [{ lineIndex: 4, type: 'fixedPerUnit', value: 1, message: 'm' }] }",
    ],
    [
      '51 discounts',
      "{ discounts: Array(51).fill({ lineIndex: 0, type: 'fixedPerUnit', value: 1, message: 'm' }) }",
    ],
    [
      'message over 80',
      "{ discounts: [{ lineIndex: 0, type: 'fixedPerUnit', value: 1, message: 'x'.repeat(81) }] }",
    ],
    ['not an object', "'discounts'"],
    ['undefined', 'undefined'],
    ['a function', '(function () {})'],
    ['a BigInt', '1n'],
    ['a unknown key', '{ discounts: [], extra: true }'],
    ['over 64 KiB', "{ discounts: [], pad: 'x'.repeat(70000) }"],
  ])(
    'S45 AS-14: an output with %s is invalid-output',
    async (_name, returned) => {
      const res = await failure(`function run() { return ${returned}; }`);
      expect(res.error).toBe('invalid-output');
    },
  );

  it('S45 AS-14: a syntax error is compile-error and a missing or non-callable run is entry-missing', async () => {
    expect((await failure('function run( {')).error).toBe('compile-error');
    expect((await failure('var x = 1;')).error).toBe('entry-missing');
    expect((await failure('var run = 5;')).error).toBe('entry-missing');
  });

  it('S45 AS-14: no state survives a run and nothing is shared between two runs of the same source', async () => {
    const leaky = `function run(input) { var seen = globalThis.x === 1; globalThis.x = 1; return { discounts: seen ? [{ lineIndex: 0, type: 'fixedPerUnit', value: 1, message: 'leak' }] : [] }; }`;
    for (let i = 0; i < 3; i++)
      expect(await sandbox.run(leaky, input, 50)).toMatchObject({
        ok: true,
        output: { discounts: [] },
      });
  });

  it('S45 AS-14: a native built-in that ignores the time limit is answered at the host-side deadline', async () => {
    const started = performance.now();

    const res = await failure(
      'function run() { var a = []; while (true) a.push(new Array(1e7).fill(1)); }',
      20,
    );

    expect(res.error).toBe('timeout');
    expect(performance.now() - started).toBeLessThan(400);
    await new Promise((resolve) => setTimeout(resolve, 600)); // the engine then ends the isolate itself
    expect(sandbox.live).toBe(0);
  });

  it('S45 AS-14: the isolate is destroyed after every run, whatever the result', async () => {
    await sandbox.run(VALID, input, 50);
    await sandbox.run('function run() { throw new Error("x") }', input, 50);
    await sandbox.run('function run() { while (true) {} }', input, 20);
    await sandbox.run('function run( {', input, 20);
    expect(sandbox.live).toBe(0);
  });

  it('S45 AS-31: runs beyond the concurrency limit wait instead of allocating more isolates', async () => {
    const small = new FunctionSandbox({ concurrency: 2, poolSize: 0 });
    let peak = 0;
    const watch = setInterval(() => (peak = Math.max(peak, small.live)), 1);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => small.run(VALID, input, 50)),
    );
    clearInterval(watch);
    small.dispose();
    expect(results.every((r) => r.ok)).toBe(true);
    expect(peak).toBeLessThanOrEqual(2);
  });
});
