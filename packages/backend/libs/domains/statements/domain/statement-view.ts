import type {
  AdjustmentCauseKind,
  StatementTotals,
} from '@marketplace-sandbox/contracts';

/**
 * The composition of a statement (S16 FR-013, research R-6). Pure: the figures of one shop and month, the adjustments
 * booked in it and the adjustments that refer to it. Net is always gross minus commission, so an adjustment that only
 * moves commission moves net the other way.
 */
export interface OwnFigures {
  grossMinor: number;
  commissionMinor: number;
  lineCount: number;
  payoutsPaidMinor: number;
}

export interface AdjustmentFigures {
  id: string;
  shopId: string;
  refersToMonth: string;
  bookedMonth: string;
  causeKind: AdjustmentCauseKind;
  causeRef: string;
  grossDeltaMinor: number;
  commissionDeltaMinor: number;
  lineCountDelta: number;
  payoutsPaidDeltaMinor: number;
  reason: string;
  createdAt: string;
}

export const ZERO_FIGURES: OwnFigures = {
  grossMinor: 0,
  commissionMinor: 0,
  lineCount: 0,
  payoutsPaidMinor: 0,
};

export function totalsOf(figures: OwnFigures): StatementTotals {
  return {
    grossMinor: figures.grossMinor,
    commissionMinor: figures.commissionMinor,
    netMinor: figures.grossMinor - figures.commissionMinor,
    lineCount: figures.lineCount,
    payoutsPaidMinor: figures.payoutsPaidMinor,
  };
}

export function plusAdjustments(
  own: OwnFigures,
  adjustments: AdjustmentFigures[],
): OwnFigures {
  return adjustments.reduce<OwnFigures>(
    (sum, a) => ({
      grossMinor: sum.grossMinor + a.grossDeltaMinor,
      commissionMinor: sum.commissionMinor + a.commissionDeltaMinor,
      lineCount: sum.lineCount + a.lineCountDelta,
      payoutsPaidMinor: sum.payoutsPaidMinor + a.payoutsPaidDeltaMinor,
    }),
    own,
  );
}

export interface Composition {
  own: StatementTotals;
  total: StatementTotals;
  corrected: StatementTotals;
}

/**
 * `total` is `own` plus what was booked into this month; `corrected` is `own` plus what refers to it. In an
 * `as_known_at` answer `own` is a recomputation with the knowledge of that instant, which already carries every
 * correction known then, so `corrected` equals `own` there (adding the referencing adjustments would count them twice).
 */
export function compose(
  own: OwnFigures,
  booked: AdjustmentFigures[],
  referencing: AdjustmentFigures[],
  asKnownAt: boolean,
): Composition {
  return {
    own: totalsOf(own),
    total: totalsOf(plusAdjustments(own, booked)),
    corrected: totalsOf(asKnownAt ? own : plusAdjustments(own, referencing)),
  };
}
