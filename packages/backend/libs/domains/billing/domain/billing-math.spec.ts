import { addPeriod, daysBetween } from './periods';
import { overage, prorate, roundHalfAwayFromZero } from './proration';

/** Shared billing math (renewals, previews, upgrades, seat changes) - pure, no DB. */
describe('billing math', () => {
  it('anchors on the 31st clamp to month ends and come back to the 31st', () => {
    let d = new Date('2026-01-31T00:00:00Z');
    const ends: string[] = [];
    for (let i = 0; i < 4; i++) {
      d = addPeriod(d, 'MONTH', 31);
      ends.push(d.toISOString().slice(0, 10));
    }
    expect(ends).toEqual(['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
    expect(addPeriod(new Date('2028-02-29T00:00:00Z'), 'YEAR', 29).toISOString().slice(0, 10)).toBe('2029-02-28');
  });

  it('prorates an upgrade halfway through a 30-day period', () => {
    const lines = prorate({
      periodStart: new Date('2026-04-01T00:00:00Z'),
      periodEnd: new Date('2026-05-01T00:00:00Z'),
      changeAt: new Date('2026-04-16T00:00:00Z'),
      oldAmount: 1900,
      newAmount: 9900,
    });
    expect(lines).toEqual([
      expect.objectContaining({ kind: 'PRORATION_CREDIT', amount: -950 }),
      expect.objectContaining({ kind: 'PRORATION_CHARGE', amount: 4950 }),
    ]);
    expect(daysBetween(new Date('2026-04-01T00:00:00Z'), new Date('2026-05-01T00:00:00Z'))).toBe(30);
  });

  it('a downgrade nets to a credit; a change at period end prorates nothing', () => {
    const base = { periodStart: new Date('2026-04-01T00:00:00Z'), periodEnd: new Date('2026-05-01T00:00:00Z') };
    const down = prorate({ ...base, changeAt: new Date('2026-04-11T00:00:00Z'), oldAmount: 9900, newAmount: 1900 });
    expect(down.reduce((s, l) => s + l.amount, 0)).toBeLessThan(0);
    expect(prorate({ ...base, changeAt: base.periodEnd, oldAmount: 9900, newAmount: 1900 })).toEqual([]);
  });

  it('rounds half away from zero and prices overage in whole blocks', () => {
    expect(roundHalfAwayFromZero(2.5)).toBe(3);
    expect(roundHalfAwayFromZero(-2.5)).toBe(-3);
    expect(overage(10_001, 10_000, 50)).toEqual({ units: 1, amount: 50 });
    expect(overage(9_000, 10_000, 50)).toEqual({ units: 0, amount: 0 });
  });
});
