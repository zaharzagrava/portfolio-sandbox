import fc from 'fast-check';
import { decideSpam, type SpamThresholds } from './spam-filter';

const T: SpamThresholds = { ipPerMinute: 20, repeatPerHour: 3 };

describe('S36 AS-41: spam decision (pure)', () => {
  it.each([
    [19, 1, { valid: true }],
    [20, 1, { valid: true }],
    [21, 1, { valid: false, reason: 'ip_burst' }],
    [1, 2, { valid: true }],
    [1, 3, { valid: true }],
    [1, 4, { valid: false, reason: 'repeat_clicker' }],
    [21, 4, { valid: false, reason: 'ip_burst' }],
    [1, 1, { valid: true }],
  ])(
    'address %i this minute, repeat %i this hour',
    (address, repeat, verdict) => {
      expect(
        decideSpam({ addressMinute: address, repeatHour: repeat }, T),
      ).toEqual(verdict);
    },
  );

  it.each([
    [{ ipPerMinute: 0, repeatPerHour: 3 }],
    [{ ipPerMinute: -1, repeatPerHour: 3 }],
    [{ ipPerMinute: 20, repeatPerHour: 0.5 }],
    [{ ipPerMinute: 2.5, repeatPerHour: 3 }],
    [{ ipPerMinute: Number.NaN, repeatPerHour: 3 }],
  ])('thresholds %j are rejected', (thresholds) => {
    expect(() =>
      decideSpam(
        { addressMinute: 1, repeatHour: 1 },
        thresholds as SpamThresholds,
      ),
    ).toThrow(RangeError);
  });

  it('property: more clicks never turn an invalid verdict valid', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 60 }),
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 0, max: 30 }),
        fc.integer({ min: 0, max: 5 }),
        (address, repeat, moreAddress, moreRepeat) => {
          const before = decideSpam(
            { addressMinute: address, repeatHour: repeat },
            T,
          );
          const after = decideSpam(
            {
              addressMinute: address + moreAddress,
              repeatHour: repeat + moreRepeat,
            },
            T,
          );
          if (!before.valid) expect(after.valid).toBe(false);
        },
      ),
      { seed: 36, numRuns: 300 },
    );
  });
});
