import fc from 'fast-check';
import { overUnits, overageAmount } from './usage-overage';
import { attributedTo, periodContains } from './usage-period';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

describe('S18 period attribution', () => {
  const start = new Date('2026-04-01T00:00:00.000Z');
  const end = new Date('2026-05-01T00:00:00.000Z');

  it.each([
    ['the first instant of the period', '2026-04-01T00:00:00.000Z', true],
    ['the last millisecond of the period', '2026-04-30T23:59:59.999Z', true],
    [
      'the instant the period ends belongs to the next one',
      '2026-05-01T00:00:00.000Z',
      false,
    ],
    ['one millisecond before the period', '2026-03-31T23:59:59.999Z', false],
  ])('S18 AS-25: %s', (_name, iso, inside) => {
    expect(periodContains(start, end, new Date(iso))).toBe(inside);
  });

  it('S18 AS-25: an event on the boundary counts in exactly one of two consecutive periods', () => {
    const may = new Date('2026-06-01T00:00:00.000Z');
    for (const iso of [
      '2026-04-30T23:59:59.999Z',
      '2026-05-01T00:00:00.000Z',
    ]) {
      const ts = new Date(iso);
      expect(
        [periodContains(start, end, ts), periodContains(end, may, ts)].filter(
          Boolean,
        ),
      ).toHaveLength(1);
    }
  });

  it('S18 AS-26: attribution uses the event time, never the ingestion instant', () => {
    const ts = new Date('2026-04-28T10:00:00.000Z');
    const ingestedAt = new Date('2026-05-03T09:00:00.000Z');
    expect(attributedTo({ ts, ingestedAt }, start, end)).toBe(true);
    expect(
      attributedTo(
        { ts, ingestedAt },
        end,
        new Date('2026-06-01T00:00:00.000Z'),
      ),
    ).toBe(false);
  });
});

describe('S18 overage', () => {
  it.each([
    [0, 10000, 50, 0],
    [9999, 10000, 50, 0],
    [10000, 10000, 50, 0],
    [10001, 10000, 50, 50],
    [11000, 10000, 50, 50],
    [11001, 10000, 50, 100],
    [12500, 10000, 50, 150],
    [13300, 10000, 50, 200],
    [13001, 10000, 50, 200],
    [500, 0, 20, 20],
    [1000, 0, 20, 20],
    [1001, 0, 20, 40],
    [20000, 10000, 0, 0],
  ])(
    'S18 AS-34: %p used, %p included, rate %p -> %p',
    (used, included, rate, amount) => {
      expect(overageAmount(used, included, rate)).toBe(amount);
    },
  );

  it('S18 AS-33: no overage at or below the allowance, over units are 0', () => {
    expect(overUnits(10000, 10000)).toBe(0);
    expect(overUnits(0, 10000)).toBe(0);
    expect(overUnits(12500, 10000)).toBe(2500);
  });

  it('S18 AS-34: a started block of 1,000 units is billed in full (0 -> 0, 1 -> 50, 1000 -> 50, 1001 -> 100, 2500 -> 150)', () => {
    expect(
      [0, 1, 1000, 1001, 2500].map((over) => overageAmount(over, 0, 50)),
    ).toEqual([0, 50, 50, 100, 150]);
  });

  it.each([
    ['used above the safe integer range', () => overageAmount(2 ** 53, 0, 50)],
    [
      'a result above the safe integer range',
      () => overageAmount(2 ** 52, 0, 2 ** 40),
    ],
    ['a negative quantity', () => overageAmount(-1, 0, 50)],
    ['a fractional quantity', () => overageAmount(1.5, 0, 50)],
    ['a negative rate', () => overageAmount(10, 0, -1)],
    ['a negative allowance', () => overageAmount(10, -1, 1)],
    ['NaN', () => overageAmount(Number.NaN, 0, 1)],
  ])('S18 AS-34: %s rejects amount_out_of_range', (_name, call) => {
    expect(codeOf(call)).toBe('amount_out_of_range');
  });

  it('S18 AS-34: the amount is monotonic in usage and equals ceil(units / 1000) x rate', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.integer({ min: 0, max: 10_000 }),
        (a, extra, included, rate) => {
          const b = a + extra;
          const over = Math.max(0, a - included);
          expect(overageAmount(a, included, rate)).toBe(
            Math.ceil(over / 1000) * rate,
          );
          expect(overageAmount(b, included, rate)).toBeGreaterThanOrEqual(
            overageAmount(a, included, rate),
          );
        },
      ),
    );
  });
});
