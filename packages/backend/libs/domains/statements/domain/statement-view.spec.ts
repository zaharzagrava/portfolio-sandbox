import { compose, type AdjustmentFigures } from './statement-view';

const own = {
  grossMinor: 30500,
  commissionMinor: 3050,
  lineCount: 3,
  payoutsPaidMinor: 0,
};
const adjustment = (patch: Partial<AdjustmentFigures>): AdjustmentFigures => ({
  id: 'a',
  shopId: 's',
  refersToMonth: '2026-03',
  bookedMonth: '2026-04',
  causeKind: 'rate_change',
  causeRef: 'c',
  grossDeltaMinor: 0,
  commissionDeltaMinor: -900,
  lineCountDelta: 0,
  payoutsPaidDeltaMinor: 0,
  reason: 'promo',
  createdAt: '2026-04-05T09:00:00.000Z',
  ...patch,
});

describe('S16 statement composition (FR-013)', () => {
  it('S16 AS-16: a referencing adjustment corrects the month but is not part of its total', () => {
    const view = compose(own, [], [adjustment({})], false);
    expect(view.own.commissionMinor).toBe(3050);
    expect(view.total).toEqual(view.own);
    expect(view.corrected).toEqual({
      grossMinor: 30500,
      commissionMinor: 2150,
      netMinor: 28350,
      lineCount: 3,
      payoutsPaidMinor: 0,
    });
  });

  it('S16 AS-17: an adjustment booked into an empty month moves net the other way', () => {
    const zero = {
      grossMinor: 0,
      commissionMinor: 0,
      lineCount: 0,
      payoutsPaidMinor: 0,
    };
    const view = compose(zero, [adjustment({})], [], false);
    expect(view.total.commissionMinor).toBe(-900);
    expect(view.total.netMinor).toBe(900);
  });

  it('S16 AS-45: every delta is summed, lines and payouts included', () => {
    const view = compose(
      own,
      [],
      [
        adjustment({
          grossDeltaMinor: 1000,
          commissionDeltaMinor: 100,
          lineCountDelta: 1,
          causeKind: 'late_sale',
        }),
        adjustment({
          commissionDeltaMinor: 0,
          payoutsPaidDeltaMinor: 25000,
          causeKind: 'late_payout',
        }),
      ],
      false,
    );
    expect(view.corrected).toEqual({
      grossMinor: 31500,
      commissionMinor: 3150,
      netMinor: 28350,
      lineCount: 4,
      payoutsPaidMinor: 25000,
    });
  });

  it('S16 AS-18: as known at, own already carries the corrections, so corrected equals own', () => {
    const view = compose(
      { ...own, commissionMinor: 2150 },
      [],
      [adjustment({})],
      true,
    );
    expect(view.corrected).toEqual(view.own);
  });
});
