import * as fc from 'fast-check';
import { MAX_QUANTITY, applyDelta } from './stock-rule';

describe('S05 AS-59: stock delta rule', () => {
  const q = 7;
  it.each([
    ['quantity 0 plus 1', 0, 1, { ok: true, quantity: 1 }],
    ['to exactly zero (-q)', q, -q, { ok: true, quantity: 0 }],
    [
      'below zero (-q-1)',
      q,
      -q - 1,
      { ok: false, reason: 'insufficient_stock' },
    ],
    [
      'to exactly the limit',
      MAX_QUANTITY - q,
      q,
      { ok: true, quantity: MAX_QUANTITY },
    ],
    [
      'above the limit (1e9-q+1 with q near the limit)',
      MAX_QUANTITY - q,
      q + 1,
      { ok: false, reason: 'quantity_limit' },
    ],
    [
      'from the limit minus one',
      MAX_QUANTITY,
      -1,
      { ok: true, quantity: MAX_QUANTITY - 1 },
    ],
    ['at 0 minus 1', 0, -1, { ok: false, reason: 'insufficient_stock' }],
    [
      'at the limit plus 1',
      MAX_QUANTITY,
      1,
      { ok: false, reason: 'quantity_limit' },
    ],
    ['zero delta', q, 0, { ok: false, reason: 'invalid_delta' }],
    ['delta +1e6', 0, 1_000_000, { ok: true, quantity: 1_000_000 }],
    ['delta +1e6+1', 0, 1_000_001, { ok: false, reason: 'invalid_delta' }],
    ['delta -1e6-1', 5, -1_000_001, { ok: false, reason: 'invalid_delta' }],
    ['fractional delta', 5, 0.5, { ok: false, reason: 'invalid_delta' }],
  ] as const)('%s', (_name, quantity, delta, expected) => {
    expect(applyDelta(quantity, delta)).toEqual(expected);
  });

  it('accepted prefix sums stay in [0, 1e9] and a rejected delta never changes the quantity', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: MAX_QUANTITY }),
        fc.array(
          fc.oneof(
            fc.integer({ min: -1_000_000, max: 1_000_000 }),
            fc.integer({ min: -2_000_000, max: 2_000_000 }),
            fc.constantFrom(0, 1, -1, MAX_QUANTITY),
          ),
          { maxLength: 200 },
        ),
        (start, deltas) => {
          let quantity = start;
          for (const delta of deltas) {
            const result = applyDelta(quantity, delta);
            if (result.ok) {
              expect(result.quantity).toBe(quantity + delta);
              quantity = result.quantity;
            }
            expect(quantity).toBeGreaterThanOrEqual(0);
            expect(quantity).toBeLessThanOrEqual(MAX_QUANTITY);
          }
        },
      ),
    );
  });
});
