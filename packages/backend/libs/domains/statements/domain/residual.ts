import type { AdjustmentFigures, OwnFigures } from './statement-view';

/**
 * The adjustment of a (shop, month, cause) is the difference between a fresh recomputation with current knowledge and
 * what the books already say about the month: the frozen snapshot plus every adjustment that refers to it (S16 FR-028).
 * Zero in all four measures means nothing is booked. Attributing the whole residual to the triggering cause keeps the
 * completeness invariant (FR-029) without per-cause bookkeeping when causes overlap.
 */
export interface Residual {
  grossDeltaMinor: number;
  commissionDeltaMinor: number;
  lineCountDelta: number;
  payoutsPaidDeltaMinor: number;
}

export function residualOf(
  fresh: OwnFigures,
  snapshot: OwnFigures,
  earlier: Pick<
    AdjustmentFigures,
    | 'grossDeltaMinor'
    | 'commissionDeltaMinor'
    | 'lineCountDelta'
    | 'payoutsPaidDeltaMinor'
  >[],
): Residual {
  const booked = earlier.reduce(
    (sum, a) => ({
      gross: sum.gross + a.grossDeltaMinor,
      commission: sum.commission + a.commissionDeltaMinor,
      lines: sum.lines + a.lineCountDelta,
      payouts: sum.payouts + a.payoutsPaidDeltaMinor,
    }),
    { gross: 0, commission: 0, lines: 0, payouts: 0 },
  );
  return {
    grossDeltaMinor: fresh.grossMinor - (snapshot.grossMinor + booked.gross),
    commissionDeltaMinor:
      fresh.commissionMinor - (snapshot.commissionMinor + booked.commission),
    lineCountDelta: fresh.lineCount - (snapshot.lineCount + booked.lines),
    payoutsPaidDeltaMinor:
      fresh.payoutsPaidMinor - (snapshot.payoutsPaidMinor + booked.payouts),
  };
}

export const isZeroResidual = (r: Residual): boolean =>
  r.grossDeltaMinor === 0 &&
  r.commissionDeltaMinor === 0 &&
  r.lineCountDelta === 0 &&
  r.payoutsPaidDeltaMinor === 0;

export type ReconcileCause =
  | { kind: 'rate_change'; ref: string }
  | { kind: 'late_sale'; ref: string }
  | { kind: 'late_payout'; ref: string };

/**
 * `rate_change:<changeId>`, `late_sale:<orderId>`, `late_payout:<payoutId>`, or `close:<runId>` (the close's own
 * follow-up, which cannot know which cause it found: recorded as a `rate_change` whose reference is the run).
 */
export function parseCause(cause: string): ReconcileCause {
  const at = cause.indexOf(':');
  const kind = cause.slice(0, at);
  const ref = cause.slice(at + 1);
  if (kind === 'late_sale' || kind === 'late_payout') return { kind, ref };
  if (kind === 'rate_change') return { kind: 'rate_change', ref };
  if (kind === 'close') return { kind: 'rate_change', ref: cause };
  throw new RangeError(`unknown cause "${kind}"`);
}
