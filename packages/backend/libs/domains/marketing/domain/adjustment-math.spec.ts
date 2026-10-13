import fc from 'fast-check';
import { billable } from './billing-math';
import { adjust, exactDay, nextSequence } from './adjustment-math';

describe('S36 AS-67: adjustment arithmetic (pure)', () => {
  it.each([
    [250, 300, -50],
    [250, 175, 75],
    [250, 250, 0],
    [0, 0, 0],
    [0, 125, -125],
  ])('exact %i, net billed %i gives delta %i', (exact, net, delta) => {
    expect(adjust(exact, net)).toEqual({ deltaMinor: delta });
  });

  it('applying the delta makes net equal exact; applying it twice changes nothing', () => {
    const { deltaMinor } = adjust(250, 300);
    const net = 300 + deltaMinor;
    expect(net).toBe(250);
    expect(adjust(250, net)).toEqual({ deltaMinor: 0 });
  });

  it('numbers adjustments in a stable sequence per campaign-hour', () => {
    expect(nextSequence([])).toBe(1);
    expect(nextSequence([1])).toBe(2);
    expect(nextSequence([3, 1, 2])).toBe(4);
  });

  describe('exactDay: the cap applied to the exact recomputation, hour by hour', () => {
    it('AS-61: exact [30, 20, 5] with CPC 25 and budget 1000', () => {
      const hours = [
        { hour: '2026-10-12T10', clicks: 30 },
        { hour: '2026-10-12T11', clicks: 20 },
        { hour: '2026-10-12T12', clicks: 5 },
      ];
      expect(exactDay(hours, 25, 1000).map((h) => h.amountMinor)).toEqual([
        750, 250, 0,
      ]);
      expect(exactDay(hours, 25, 1000).map((h) => h.billableClicks)).toEqual([
        30, 10, 0,
      ]);
    });

    it('applies hours in order whatever the input order', () => {
      const hours = [
        { hour: '2026-10-12T12', clicks: 5 },
        { hour: '2026-10-12T10', clicks: 30 },
        { hour: '2026-10-12T11', clicks: 20 },
      ];
      expect(exactDay(hours, 25, 1000).map((h) => h.hour)).toEqual([
        '2026-10-12T10',
        '2026-10-12T11',
        '2026-10-12T12',
      ]);
    });
  });

  it('property: for any growth of raw clicks, the final net equals billable(final exact clicks)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000 }),
        fc.integer({ min: 100, max: 100_000 }),
        fc.integer({ min: 0, max: 500 }),
        fc.array(fc.integer({ min: 0, max: 200 }), { maxLength: 8 }),
        (cpc, budget, startClicks, growth) => {
          let clicks = startClicks;
          let net = billable(clicks, cpc, budget, 0).amountMinor;
          for (const g of growth) {
            clicks += g;
            const exact = billable(clicks, cpc, budget, 0).amountMinor;
            net += adjust(exact, net).deltaMinor;
            expect(adjust(exact, net).deltaMinor).toBe(0); // idempotent
          }
          expect(net).toBe(billable(clicks, cpc, budget, 0).amountMinor);
        },
      ),
      { seed: 36, numRuns: 300 },
    );
  });
});
