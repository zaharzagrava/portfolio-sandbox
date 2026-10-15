import fc from 'fast-check';
import { overage, prorate, prorationDays } from './proration';

describe('S17 usage overage pricing (kept from the previous suite)', () => {
  it('S17 AS-26: overage is priced in whole blocks of 1,000 above the included quota', () => {
    expect(overage(10_001, 10_000, 50)).toEqual({ units: 1, amount: 50 });
    expect(overage(9_000, 10_000, 50)).toEqual({ units: 0, amount: 0 });
  });
});

const D = (iso: string) => new Date(iso);

describe('S17 AS-63: the day boundary is a UTC date', () => {
  const start = D('2026-04-01T12:00:00Z');
  const end = D('2026-05-01T12:00:00Z');

  it.each([
    { at: '2026-04-16T00:00:00Z', remaining: 15 },
    { at: '2026-04-16T12:00:00Z', remaining: 15 },
    { at: '2026-04-16T23:59:59Z', remaining: 15 },
    { at: '2026-04-17T00:00:00Z', remaining: 14 },
    { at: '2026-04-01T12:00:00Z', remaining: 30 },
    { at: '2026-03-20T00:00:00Z', remaining: 30 },
    { at: '2026-05-01T00:00:00Z', remaining: 0 },
    { at: '2026-05-01T12:00:00Z', remaining: 0 },
    { at: '2026-06-01T00:00:00Z', remaining: 0 },
  ])(
    'S17 AS-63: a change at $at has $remaining of 30 days remaining',
    ({ at, remaining }) => {
      expect(prorationDays(start, end, D(at))).toEqual({
        totalDays: 30,
        remainingDays: remaining,
      });
    },
  );

  describe.each(['UTC', 'America/Los_Angeles', 'Asia/Kolkata'])(
    'server time zone %s',
    (tz) => {
      const original = process.env.TZ;
      beforeAll(() => {
        process.env.TZ = tz;
      });
      afterAll(() => {
        process.env.TZ = original;
      });
      it('S17 AS-63: counts the same days whatever the server time zone', () => {
        expect(
          prorationDays(start, end, D('2026-04-16T23:59:59Z')).remainingDays,
        ).toBe(15);
        expect(
          prorationDays(start, end, D('2026-04-17T00:00:00Z')).remainingDays,
        ).toBe(14);
      });
    },
  );

  it('S17 AS-63: with zero remaining days (or an empty period) there are no lines', () => {
    const none = prorate({
      periodStart: start,
      periodEnd: end,
      changeAt: D('2026-05-01T00:00:00Z'),
      oldAmount: 1900,
      newAmount: 9900,
    });
    expect(none.lines).toEqual([]);
    expect(none.net).toBe(0);
    const empty = prorate({
      periodStart: start,
      periodEnd: start,
      changeAt: start,
      oldAmount: 1,
      newAmount: 2,
    });
    expect(empty.lines).toEqual([]);
  });
});

describe('S17 AS-64: rounding once, half away from zero, parts add up to the total', () => {
  const run = (
    days: { total: number; remaining: number },
    oldAmount: number,
    newAmount: number,
  ) => {
    const periodStart = D('2026-04-01T00:00:00Z');
    const periodEnd = new Date(periodStart.getTime() + days.total * 86_400_000);
    const changeAt = new Date(
      periodEnd.getTime() - days.remaining * 86_400_000,
    );
    return prorate({ periodStart, periodEnd, changeAt, oldAmount, newAmount });
  };

  it('S17 AS-64: 10 of 30 days, 1000 -> 2000: lines -333 and +666, net 333 (not 334)', () => {
    const result = run({ total: 30, remaining: 10 }, 1000, 2000);
    expect(result.lines.map((l) => [l.kind, l.amount])).toEqual([
      ['PRORATION_CREDIT', -333],
      ['PRORATION_CHARGE', 666],
    ]);
    expect(result.net).toBe(333);
  });

  it('S17 AS-64: 15 of 30 days, 1 -> 2: net 0.5 rounds half away from zero to 1; the zero credit line is omitted', () => {
    const result = run({ total: 30, remaining: 15 }, 1, 2);
    expect(result.lines.map((l) => [l.kind, l.amount])).toEqual([
      ['PRORATION_CHARGE', 1],
    ]);
    expect(result.net).toBe(1);
  });

  it('S17 AS-64: 31-day period, 7 remaining, 1900 -> 9900: -429 and +2235, total 1806', () => {
    const result = run({ total: 31, remaining: 7 }, 1900, 9900);
    expect(result.lines.map((l) => l.amount)).toEqual([-429, 2235]);
    expect(result.net).toBe(1806);
  });

  it('S17 AS-59: the worked upgrade, 15 of 30 days, starter -> pro: -950 and +4950', () => {
    const result = run({ total: 30, remaining: 15 }, 1900, 9900);
    expect(result.lines.map((l) => l.amount)).toEqual([-950, 4950]);
    expect(result.lines[0].description).toBe(
      'Unused time on previous plan (15/30 days)',
    );
    expect(result.lines[1].description).toBe(
      'Remaining time on new plan (15/30 days)',
    );
  });

  it('S17 AS-61: a downgrade pro -> starter, 15 of 30 days: -4950 and +950, net -4000', () => {
    const result = run({ total: 30, remaining: 15 }, 9900, 1900);
    expect(result.lines.map((l) => l.amount)).toEqual([-4950, 950]);
    expect(result.net).toBe(-4000);
  });

  it('S17 AS-62: seats 3 -> 5 on a 9900 per-seat price, 15 of 30 days: -14850 and +24750', () => {
    const result = run({ total: 30, remaining: 15 }, 3 * 9900, 5 * 9900);
    expect(result.lines.map((l) => l.amount)).toEqual([-14850, 24750]);
    expect(result.net).toBe(9900);
  });

  it('S17 AS-64: the lines add up to the exact net rounded once and each is within one unit of its exact value (>= 1,000 cases)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 366 }),
        fc.nat(366),
        fc.integer({ min: 0, max: 100_000_000 }),
        fc.integer({ min: 0, max: 100_000_000 }),
        (total, remainingRaw, oldAmount, newAmount) => {
          const remaining = Math.min(total, remainingRaw);
          if (remaining === 0) return;
          const result = run({ total, remaining }, oldAmount, newAmount);
          const exactNet = ((newAmount - oldAmount) * remaining) / total;
          const sum = result.lines.reduce((a, l) => a + l.amount, 0);
          expect(sum).toBe(result.net);
          // rounded once, half away from zero
          expect(Math.abs(result.net - exactNet)).toBeLessThanOrEqual(
            0.5 + 1e-6,
          );
          const credit = result.lines.find(
            (l) => l.kind === 'PRORATION_CREDIT',
          );
          const charge = result.lines.find(
            (l) => l.kind === 'PRORATION_CHARGE',
          );
          const exactCredit = -(oldAmount * remaining) / total;
          const exactCharge = (newAmount * remaining) / total;
          expect(Math.abs((credit?.amount ?? 0) - exactCredit)).toBeLessThan(
            1 + 1e-6,
          );
          expect(Math.abs((charge?.amount ?? 0) - exactCharge)).toBeLessThan(
            1 + 1e-6,
          );
          expect(result.lines.every((l) => l.amount !== 0)).toBe(true);
          expect(credit ? credit.amount <= 0 : true).toBe(true);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it('S17 AS-64: half-way nets round away from zero in both directions', () => {
    const up = run({ total: 2, remaining: 1 }, 0, 1); // net +0.5 -> +1
    expect(up.net).toBe(1);
    const down = run({ total: 2, remaining: 1 }, 1, 0); // net -0.5 -> -1
    expect(down.net).toBe(-1);
    expect(down.lines.reduce((a, l) => a + l.amount, 0)).toBe(-1);
  });
});
