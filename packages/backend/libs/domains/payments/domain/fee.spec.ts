import * as fc from 'fast-check';
import { splitCapture } from './fee';
import { JournalInvalid } from './ledger-errors';

const reasonOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof JournalInvalid) return e.reason;
    throw e;
  }
  return 'accepted';
};

describe('Platform fee split', () => {
  it.each([
    [2500, 50, 2450],
    [51, 50, 1],
    [100, 50, 50],
    [10_000, 50, 9_950],
    [99_999_999, 50, 99_999_949],
    [101, 100, 1],
  ])(
    'S14 AS-11: a capture of %d with fee %d credits clearing %d',
    (amount, fee, clearing) => {
      expect(splitCapture(amount, fee)).toEqual({
        providerMinor: -amount,
        clearingMinor: clearing,
        feeMinor: fee,
      });
    },
  );

  it.each([
    [50, 50, 'amount_not_above_fee'],
    [49, 50, 'amount_not_above_fee'],
    [0, 50, 'amount_not_above_fee'],
    [-1, 50, 'line_amount_invalid'],
    [-2500, 50, 'line_amount_invalid'],
    [25.5, 50, 'line_amount_invalid'],
    [Number.NaN, 50, 'line_amount_invalid'],
    [2 ** 53, 50, 'line_amount_invalid'],
    [51, 50, 'accepted'],
  ])(
    'S14 AS-13: a capture of %d with fee %d is %s',
    (amount, fee, expected) => {
      expect(reasonOf(() => splitCapture(amount, fee))).toBe(expected);
    },
  );

  it('S14 AS-11: the three lines of any capture sum to zero (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000 }),
        fc.integer({ min: 1, max: 99_999_999 }),
        (fee, extra) => {
          const s = splitCapture(fee + extra, fee);
          return s.providerMinor + s.clearingMinor + s.feeMinor === 0;
        },
      ),
    );
  });
});
