import fc from 'fast-check';
import { MAX_STOCK, merge } from './stock-merge';

describe('S08 stock merge (three-way)', () => {
  it.each([
    [
      '(10,10,10) nothing',
      [10, 10, 10],
      { action: 'none', localDelta: 0, pushValue: null, result: 10 },
    ],
    [
      '(10,10,7) pull',
      [10, 10, 7],
      { action: 'pull', localDelta: -3, pushValue: null, result: 7 },
    ],
    [
      '(10,8,10) push',
      [10, 8, 10],
      { action: 'push', localDelta: 0, pushValue: 8, result: 8 },
    ],
    [
      '(10,8,7) pull -3 locally and push',
      [10, 8, 7],
      { action: 'merge', localDelta: -3, pushValue: 5, result: 5 },
    ],
    [
      '(10,5,5) converged',
      [10, 5, 5],
      { action: 'converged', localDelta: 0, pushValue: null, result: 5 },
    ],
    [
      '(3,0,1) oversold',
      [3, 0, 1],
      {
        action: 'push',
        localDelta: 0,
        pushValue: 0,
        result: 0,
        conflict: 'oversold',
      },
    ],
    [
      '(5,1e9,1e9) quantity_limit',
      [5, 1e9, 1e9],
      {
        action: 'converged',
        localDelta: 0,
        pushValue: null,
        result: 1e9,
        conflict: 'quantity_limit',
      },
    ],
  ] as const)('S08 AS-45: %s', (_name, [b, l, r], expected) => {
    const out = merge(b, l, r);
    expect(out).toEqual(expected);
    expect('conflict' in out).toBe('conflict' in expected);
  });

  it('S08 AS-45: oversold lowers the sides to the clamped value', () => {
    expect(merge(3, 1, 0)).toMatchObject({
      result: 0,
      conflict: 'oversold',
      localDelta: -1,
      pushValue: null,
    });
    expect(merge(5, 2, 1)).toMatchObject({
      result: 0,
      conflict: 'oversold',
      localDelta: -2,
      pushValue: 0,
    });
  });

  it('S08 AS-45: quantity_limit sets both sides to the cap', () => {
    expect(merge(0, 1e9, 5)).toMatchObject({
      result: 1e9,
      conflict: 'quantity_limit',
      localDelta: 0,
      pushValue: 1e9,
    });
    expect(merge(0, 5, 1e9)).toMatchObject({
      result: 1e9,
      conflict: 'quantity_limit',
      localDelta: 1e9 - 5,
      pushValue: null,
    });
  });

  const stock = fc.integer({ min: 0, max: MAX_STOCK });

  it('S08 AS-45: result is within [0, 1e9] and the plan brings both sides to the result', () => {
    fc.assert(
      fc.property(stock, stock, stock, (b, l, r) => {
        const m = merge(b, l, r);
        expect(m.result).toBeGreaterThanOrEqual(0);
        expect(m.result).toBeLessThanOrEqual(MAX_STOCK);
        expect(l + m.localDelta).toBe(m.result);
        expect(m.pushValue === null ? r : m.pushValue).toBe(m.result);
      }),
    );
  });

  it('S08 AS-45: result = L + R - B whenever that is in range and the sides differ', () => {
    fc.assert(
      fc.property(stock, stock, stock, (b, l, r) => {
        fc.pre(l !== r);
        const sum = l + r - b;
        fc.pre(sum >= 0 && sum <= MAX_STOCK);
        const m = merge(b, l, r);
        expect(m.result).toBe(sum);
        expect(m.conflict).toBeUndefined();
      }),
    );
  });

  it('S08 AS-45: swapping L and R gives the same result and conflict', () => {
    fc.assert(
      fc.property(stock, stock, stock, (b, l, r) => {
        const a = merge(b, l, r);
        const s = merge(b, r, l);
        expect(s.result).toBe(a.result);
        expect(s.conflict).toBe(a.conflict);
      }),
    );
  });

  it('S08 AS-45: deterministic, and inputs outside [0, 1e9] or non-integers throw', () => {
    expect(merge(4, 3, 9)).toEqual(merge(4, 3, 9));
    expect(() => merge(-1, 0, 0)).toThrow(RangeError);
    expect(() => merge(0, 1.5, 0)).toThrow(RangeError);
    expect(() => merge(0, 0, 1e9 + 1)).toThrow(RangeError);
  });
});
