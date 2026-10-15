import * as fc from 'fast-check';
import { commissionOf } from './commission';
import { lookupRate, type RateBelief } from './rate-lookup';
import { isZeroResidual, parseCause, residualOf } from './residual';
import type { AdjustmentFigures, OwnFigures } from './statement-view';

/**
 * AS-47: whatever the order of rate changes, late sales and late payouts, the frozen figures plus the adjustments
 * that refer to the month equal a fresh recomputation. The model below is the in-memory twin of the SQL pricing.
 */
interface Sale {
  category: string;
  total: number;
  paidAt: Date;
}
interface World {
  sales: Sale[];
  payouts: number[];
  beliefs: RateBelief[];
  clock: number;
}

const SHOP = 's';
const MARCH = new Date('2026-03-15T12:00:00Z');
const recompute = (world: World): OwnFigures => {
  const known = new Date(world.clock);
  let gross = 0;
  let commission = 0;
  for (const sale of world.sales) {
    const rate = lookupRate(world.beliefs, SHOP, sale.category, sale.paidAt, known);
    gross += sale.total;
    commission += rate ? commissionOf(sale.total, rate.rateBps) : 0;
  }
  return {
    grossMinor: gross,
    commissionMinor: commission,
    lineCount: world.sales.length,
    payoutsPaidMinor: world.payouts.reduce((a, b) => a + b, 0),
  };
};

type Op =
  | { type: 'rate'; category: string; bps: number }
  | { type: 'sale'; category: string; total: number }
  | { type: 'payout'; amount: number }
  | { type: 'again' };

const op = fc.oneof(
  fc.record({
    type: fc.constant('rate' as const),
    category: fc.constantFrom('a', 'b', '*'),
    bps: fc.integer({ min: 0, max: 10_000 }),
  }),
  fc.record({
    type: fc.constant('sale' as const),
    category: fc.constantFrom('a', 'b'),
    total: fc.integer({ min: 0, max: 5_000_000 }),
  }),
  fc.record({ type: fc.constant('payout' as const), amount: fc.integer({ min: 1, max: 1_000_000 }) }),
  fc.record({ type: fc.constant('again' as const) }),
);

const initial = (): World => ({
  sales: [
    { category: 'a', total: 10_000, paidAt: MARCH },
    { category: 'b', total: 777, paidAt: MARCH },
  ],
  payouts: [],
  beliefs: [
    {
      id: 'default',
      shopId: null,
      category: '*',
      rateBps: 1000,
      validFrom: null,
      validTo: null,
      recordedFrom: new Date(0),
      recordedTo: null,
    },
  ],
  clock: Date.parse('2026-04-02T02:00:00Z'),
});

describe('S16 AS-47 completeness of closed months', () => {
  it('S16 AS-47: snapshot plus adjustments equals a fresh recomputation after any sequence of changes and late facts', () => {
    fc.assert(
      fc.property(fc.array(op, { maxLength: 25 }), (ops: Op[]) => {
        const world = initial();
        const snapshot = recompute(world);
        const adjustments: AdjustmentFigures[] = [];
        const reconcile = (cause: string) => {
          const r = residualOf(recompute(world), snapshot, adjustments);
          if (isZeroResidual(r)) return;
          adjustments.push({
            id: String(adjustments.length),
            shopId: SHOP,
            refersToMonth: '2026-03',
            bookedMonth: '2026-04',
            causeKind: parseCause(cause).kind,
            causeRef: cause,
            ...r,
            reason: cause,
            createdAt: '',
          });
        };
        ops.forEach((step, i) => {
          world.clock += 60_000;
          if (step.type === 'rate') {
            // a retroactive belief for March: the previous belief of the same (category) is closed and replaced
            for (const b of world.beliefs)
              if (b.category === step.category && b.recordedTo === null)
                b.recordedTo = new Date(world.clock);
            world.beliefs.push({
              id: `r${i}`,
              shopId: null,
              category: step.category,
              rateBps: step.bps,
              validFrom: null,
              validTo: null,
              recordedFrom: new Date(world.clock),
              recordedTo: null,
            });
            reconcile(`rate_change:r${i}`);
          } else if (step.type === 'sale') {
            world.sales.push({ category: step.category, total: step.total, paidAt: MARCH });
            reconcile(`late_sale:o${i}`);
          } else if (step.type === 'payout') {
            world.payouts.push(step.amount);
            reconcile(`late_payout:p${i}`);
          } else {
            const before = adjustments.length;
            reconcile(`rate_change:again${i}`); // a repeated or concurrent trigger books nothing new
            if (before !== adjustments.length)
              throw new Error('a repeated trigger booked an adjustment');
          }
          const total = adjustments.reduce(
            (sum, a) => ({
              gross: sum.gross + a.grossDeltaMinor,
              commission: sum.commission + a.commissionDeltaMinor,
              lines: sum.lines + a.lineCountDelta,
              payouts: sum.payouts + a.payoutsPaidDeltaMinor,
            }),
            { gross: 0, commission: 0, lines: 0, payouts: 0 },
          );
          const fresh = recompute(world);
          expect(snapshot.grossMinor + total.gross).toBe(fresh.grossMinor);
          expect(snapshot.commissionMinor + total.commission).toBe(fresh.commissionMinor);
          expect(snapshot.lineCount + total.lines).toBe(fresh.lineCount);
          expect(snapshot.payoutsPaidMinor + total.payouts).toBe(fresh.payoutsPaidMinor);
        });
      }),
      { numRuns: 200 },
    );
  });

  it('S16 AS-42: a second change with the same reason is a second residual, not a collapsed one', () => {
    const snapshot = { grossMinor: 30500, commissionMinor: 3050, lineCount: 3, payoutsPaidMinor: 0 };
    const first = residualOf({ ...snapshot, commissionMinor: 2150 }, snapshot, []);
    expect(first.commissionDeltaMinor).toBe(-900);
    const second = residualOf({ ...snapshot, commissionMinor: 1850 }, snapshot, [
      { ...first },
    ]);
    expect(second.commissionDeltaMinor).toBe(-300);
  });

  it.each([
    ['rate_change:abc', { kind: 'rate_change', ref: 'abc' }],
    ['late_sale:o1', { kind: 'late_sale', ref: 'o1' }],
    ['late_payout:p1', { kind: 'late_payout', ref: 'p1' }],
    ['close:run1', { kind: 'rate_change', ref: 'close:run1' }],
  ])('S16 AS-40: cause %s is read as %j', (cause, parsed) => {
    expect(parseCause(cause)).toEqual(parsed);
  });

  it('S16 AS-40: an unknown cause is refused', () => {
    expect(() => parseCause('weather:x')).toThrow();
  });
});
