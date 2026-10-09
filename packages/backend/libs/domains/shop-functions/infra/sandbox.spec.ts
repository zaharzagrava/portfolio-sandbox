import { FunctionSandbox } from './sandbox';
import { applyDiscounts } from '../domain/contract';

const input = {
  currency: 'usd',
  lines: [
    { productId: 'p1', category: 'cases', quantity: 3, unitPrice: 2_000 },
  ],
};

/** The sandbox is the security boundary for seller code - real isolates, no mocks. */
describe('FunctionSandbox (isolated-vm)', () => {
  const sandbox = new FunctionSandbox();
  afterAll(() => sandbox.dispose());

  it('runs a valid discount function and validates its output', async () => {
    const res = await sandbox.run(
      `function run(input) { return { discounts: input.lines.filter(l => l.quantity >= 3).map((l, i) => ({ lineIndex: i, type: 'percentage', value: 15, message: '3+ cases: 15% off' })) }; }`,
      input,
      50,
    );
    expect(res).toMatchObject({
      ok: true,
      output: { discounts: [{ lineIndex: 0, value: 15 }] },
    });
  });

  it('kills infinite loops at the time budget', async () => {
    const res = await sandbox.run(
      'function run() { while (true) {} }',
      input,
      20,
    );
    expect(res).toMatchObject({ ok: false, error: 'timeout' });
    expect(res.ms).toBeLessThan(500);
  });

  it('has no Node APIs: require / process / fetch are undefined', async () => {
    for (const probe of [
      "require('fs')",
      'process.env',
      "fetch('http://example.com')",
    ]) {
      const res = await sandbox.run(
        `function run() { ${probe}; return { discounts: [] }; }`,
        input,
        50,
      );
      expect(res).toMatchObject({ ok: false, error: 'runtime' });
      expect((res as { detail: string }).detail).toMatch(/not defined/);
    }
  });

  it('memory bombs hit the isolate cap, not the host', async () => {
    const res = await sandbox.run(
      'function run() { const a = []; while (true) a.push(new Array(1e6).fill(1)); }',
      input,
      2_000,
    );
    expect(res.ok).toBe(false);
  });

  it('output is validated and clamped by the host', async () => {
    expect(
      await sandbox.run(
        `function run() { return { discounts: [{ lineIndex: 0, type: 'free money', value: 1 }] }; }`,
        input,
        50,
      ),
    ).toMatchObject({ ok: false, error: 'invalid-output' });
    expect(
      applyDiscounts(input.lines, {
        discounts: [
          { lineIndex: 0, type: 'percentage', value: 200, message: 'oops' },
        ],
      }),
    ).toEqual([0]);
    expect(
      applyDiscounts(input.lines, {
        discounts: [
          { lineIndex: 0, type: 'fixedPerUnit', value: 500, message: '-$5' },
        ],
      }),
    ).toEqual([1_500]);
  });
});
