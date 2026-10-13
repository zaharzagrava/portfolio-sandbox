import fc from 'fast-check';
import { PICKUP_LIMITS } from '@marketplace-sandbox/contracts';
import { decideAdjust, decideSet } from './stock-rules';

describe('S19 AS-17 set: changed or not', () => {
  it.each([
    [
      'no row, new quantity',
      null,
      { quantity: 4 },
      { kind: 'apply', version: 1 },
    ],
    [
      'same quantity',
      { quantity: 4, version: 2 },
      { quantity: 4 },
      { kind: 'noop', version: 2 },
    ],
    [
      'other quantity',
      { quantity: 4, version: 2 },
      { quantity: 9 },
      { kind: 'apply', version: 3 },
    ],
    [
      'zero on a stocked row',
      { quantity: 4, version: 1 },
      { quantity: 0 },
      { kind: 'apply', version: 2 },
    ],
    ['zero with no row', null, { quantity: 0 }, { kind: 'apply', version: 1 }],
  ])('%s', (_name, current, input, expected) => {
    expect(decideSet(current, input)).toEqual(expected);
  });
});

describe('S19 AS-19 set: version guard', () => {
  it.each([
    [
      'matching version',
      { quantity: 4, version: 3 },
      { quantity: 1, expectedVersion: 3 },
      { kind: 'apply', version: 4 },
    ],
    [
      'stale version',
      { quantity: 4, version: 3 },
      { quantity: 1, expectedVersion: 2 },
      { kind: 'conflict', currentVersion: 3 },
    ],
    [
      'future version',
      { quantity: 4, version: 3 },
      { quantity: 1, expectedVersion: 9 },
      { kind: 'conflict', currentVersion: 3 },
    ],
    [
      'zero means no row, row missing',
      null,
      { quantity: 1, expectedVersion: 0 },
      { kind: 'apply', version: 1 },
    ],
    [
      'zero means no row, row exists',
      { quantity: 4, version: 3 },
      { quantity: 1, expectedVersion: 0 },
      { kind: 'conflict', currentVersion: 3 },
    ],
    [
      'version expected, no row',
      null,
      { quantity: 1, expectedVersion: 1 },
      { kind: 'conflict', currentVersion: 0 },
    ],
    [
      'matching version, same quantity',
      { quantity: 4, version: 3 },
      { quantity: 4, expectedVersion: 3 },
      { kind: 'noop', version: 3 },
    ],
    [
      'stale version, same quantity',
      { quantity: 4, version: 3 },
      { quantity: 4, expectedVersion: 2 },
      { kind: 'conflict', currentVersion: 3 },
    ],
  ])('%s', (_name, current, input, expected) => {
    expect(decideSet(current, input)).toEqual(expected);
  });
});

describe('S19 AS-21 adjust', () => {
  const max = PICKUP_LIMITS.stockMax;

  it.each([
    ['decrement', 5, -1, { kind: 'apply', quantity: 4 }],
    ['down to zero', 5, -5, { kind: 'apply', quantity: 0 }],
    ['below zero', 5, -6, { kind: 'insufficient', available: 5 }],
    ['from zero', 0, -1, { kind: 'insufficient', available: 0 }],
    ['no row, increment', null, 3, { kind: 'apply', quantity: 3 }],
    ['no row, decrement', null, -1, { kind: 'insufficient', available: 0 }],
    ['up to the maximum', max - 1, 1, { kind: 'apply', quantity: max }],
    ['above the maximum', max, 1, { kind: 'limit' }],
  ])('%s', (_name, current, delta, expected) => {
    expect(decideAdjust(current, delta)).toEqual(expected);
  });

  it('keeps the quantity within 0…max for any sequence of deltas', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max }),
        fc.array(
          fc
            .integer({
              min: -PICKUP_LIMITS.deltaMax,
              max: PICKUP_LIMITS.deltaMax,
            })
            .filter((d) => d !== 0),
          { maxLength: 60 },
        ),
        (start, deltas) => {
          let quantity = start;
          for (const delta of deltas) {
            const decision = decideAdjust(quantity, delta);
            if (decision.kind === 'apply') quantity = decision.quantity;
            expect(quantity).toBeGreaterThanOrEqual(0);
            expect(quantity).toBeLessThanOrEqual(max);
          }
        },
      ),
    );
  });
});
