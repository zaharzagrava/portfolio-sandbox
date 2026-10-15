import type { Residual } from './residual';

/**
 * What a verification run finds in a closed month (S16 FR-043, FR-044, research R-8). Pure comparisons: the data comes
 * from the statements' own tables, the findings are upserted per (month, kind, shop) and cleared when a later run
 * agrees. A snapshot is never altered by any of it.
 */
export type FindingKind =
  | 'net_mismatch'
  | 'fee_mismatch'
  | 'missing_in_ledger'
  | 'missing_in_statement'
  | 'completeness_violation';

export interface FindingDraft {
  kind: FindingKind;
  /** `null` for platform-wide findings. */
  shopId: string | null;
  expectedMinor: number;
  actualMinor: number;
  differenceMinor: number;
}

export const draft = (
  kind: FindingKind,
  shopId: string | null,
  expectedMinor: number,
  actualMinor: number,
): FindingDraft => ({
  kind,
  shopId,
  expectedMinor,
  actualMinor,
  differenceMinor: actualMinor - expectedMinor,
});

/** Per shop: the net the books froze against what the ledger credited the shop for the same orders. */
export function netFindings(
  rows: { shopId: string; expectedMinor: number; actualMinor: number }[],
): FindingDraft[] {
  return rows
    .filter((r) => r.expectedMinor !== r.actualMinor)
    .map((r) =>
      draft('net_mismatch', r.shopId, r.expectedMinor, r.actualMinor),
    );
}

/** The commission the books froze against the fees the ledger credited to the platform, in total. */
export function feeFindings(
  expectedMinor: number,
  actualMinor: number,
): FindingDraft[] {
  return expectedMinor === actualMinor
    ? []
    : [draft('fee_mismatch', null, expectedMinor, actualMinor)];
}

/** A shop's sales without a ledger journal: expected is what they sold, actual is what the ledger knows (nothing). */
export function missingInLedgerFindings(
  rows: { shopId: string; grossMinor: number }[],
): FindingDraft[] {
  return rows
    .filter((r) => r.grossMinor > 0)
    .map((r) => draft('missing_in_ledger', r.shopId, r.grossMinor, 0));
}

/** Journals of the month whose order the statements never heard of: counted, expected zero. */
export function missingInStatementFindings(journals: number): FindingDraft[] {
  return journals > 0 ? [draft('missing_in_statement', null, 0, journals)] : [];
}

/**
 * Snapshot plus adjustments against a fresh recomputation (FR-029). The first measure that differs is the one
 * reported: commission, then gross, payouts, lines.
 */
export function completenessFinding(
  shopId: string,
  fresh: { commission: number; gross: number; payouts: number; lines: number },
  residual: Residual,
): FindingDraft | null {
  const measures: [number, number][] = [
    [residual.commissionDeltaMinor, fresh.commission],
    [residual.grossDeltaMinor, fresh.gross],
    [residual.payoutsPaidDeltaMinor, fresh.payouts],
    [residual.lineCountDelta, fresh.lines],
  ];
  for (const [delta, expected] of measures)
    if (delta !== 0)
      return draft(
        'completeness_violation',
        shopId,
        expected,
        expected - delta,
      );
  return null;
}

export const findingKey = (f: Pick<FindingDraft, 'kind' | 'shopId'>): string =>
  `${f.kind}:${f.shopId ?? '-'}`;
