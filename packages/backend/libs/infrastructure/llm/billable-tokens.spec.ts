import * as fc from 'fast-check';
import { billableTokens, estimateTokens } from './billable-tokens';
import { costMicros } from './pricing';

const usage = (
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
) => ({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens });

const component = fc.integer({ min: 0, max: 5_000_000 });
const anyUsage = fc.record({
  inputTokens: component,
  outputTokens: component,
  cacheReadTokens: component,
  cacheWriteTokens: component,
});
const usageKey = fc.constantFrom(
  'inputTokens' as const,
  'outputTokens' as const,
  'cacheReadTokens' as const,
  'cacheWriteTokens' as const,
);

describe('billable tokens and estimates', () => {
  it.each([
    // input, output, cacheRead, cacheWrite, expected = input + cacheWrite + output + ceil(cacheRead / 10)
    [0, 0, 0, 0, 0],
    [100, 50, 0, 0, 150],
    [100, 50, 10, 0, 151],
    [100, 50, 11, 0, 152],
    [100, 50, 1, 0, 151],
    [100, 50, 1_000, 20, 270],
    [0, 0, 9, 0, 1],
  ])(
    'S46 AS-62: usage in %i, out %i, cache read %i, cache write %i bills %i tokens',
    (input, output, read, write, expected) => {
      expect(billableTokens(usage(input, output, read, write))).toBe(expected);
    },
  );

  it.each([
    [0, 0],
    [1, 1],
    [3, 1],
    [4, 1],
    [5, 2],
    [4_000, 1_000],
    [4_001, 1_001],
  ])(
    'S46 AS-62: %i characters estimate to %i tokens (ceil(chars / 4))',
    (chars, expected) => {
      expect(estimateTokens(chars)).toBe(expected);
    },
  );

  it('S46 AS-62: billableTokens is a non-negative integer and monotonic in every component', () => {
    fc.assert(
      fc.property(
        anyUsage,
        usageKey,
        fc.integer({ min: 0, max: 1_000_000 }),
        (u, key, extra) => {
          const base = billableTokens(u);
          const more = billableTokens({ ...u, [key]: u[key] + extra });
          expect(Number.isInteger(base)).toBe(true);
          expect(base).toBeGreaterThanOrEqual(0);
          expect(more).toBeGreaterThanOrEqual(base);
        },
      ),
    );
  });

  it('S46 AS-62: costMicros is a non-negative integer and monotonic in every component', () => {
    fc.assert(
      fc.property(
        anyUsage,
        fc.constantFrom(
          'claude-opus-5-5',
          'claude-sonnet-5-5',
          'claude-haiku-4-5',
        ),
        usageKey,
        fc.integer({ min: 0, max: 1_000_000 }),
        (u, model, key, extra) => {
          const base = costMicros(model, u);
          const more = costMicros(model, { ...u, [key]: u[key] + extra });
          expect(Number.isInteger(base)).toBe(true);
          expect(base).toBeGreaterThanOrEqual(0);
          expect(more).toBeGreaterThanOrEqual(base);
        },
      ),
    );
  });
});
