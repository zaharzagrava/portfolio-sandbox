/**
 * Pure matching of the provider statement against the ledger's `SALE` and `REFUND` journals (S14 FR-028…FR-031).
 * Nothing here posts, reads a store or calls the provider.
 */
export const ISSUE_KINDS = [
  'MISSING_IN_LEDGER',
  'MISSING_AT_PROVIDER',
  'AMOUNT_MISMATCH',
  'CURRENCY_MISMATCH',
  'DUPLICATE_AT_PROVIDER',
  'INVALID_PROVIDER_RECORD',
] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];

export type StatementLineType = 'charge' | 'refund' | 'dispute';

/** A validated line of the provider's statement; `amountMinor` is the magnitude, `type` carries the direction. */
export interface StatementLine {
  id: string;
  type: StatementLineType;
  /** The provider reference the ledger stores: a payment-intent id for a charge, a refund id, a dispute id. */
  reference: string;
  amountMinor: number;
  currency: string;
  createdAt: Date;
}

/** What the ledger knows for one provider reference (a `SALE` by `paymentRef`, a `REFUND` by `refundRef`). */
export interface LedgerSide {
  kind: 'SALE' | 'REFUND';
  reference: string;
  amountMinor: number;
  currency: string;
}

export interface MatchIssue {
  kind: IssueKind;
  reference: string;
  details: Record<string, unknown>;
}

export type ParsedLine =
  | { kind: 'line'; line: StatementLine }
  | { kind: 'invalid'; position: number }
  | { kind: 'skipped'; type: 'transfer' | 'unknown' };

const TYPE_OF: Record<string, StatementLineType> = {
  charge: 'charge',
  payment: 'charge',
  refund: 'refund',
  payment_refund: 'refund',
  dispute: 'dispute',
};
/** Types that belong to payouts (S15): counted as skipped, not as unknown. */
const PAYOUT_TYPES = new Set(['transfer', 'payout', 'payout_failure']);

/**
 * Trusts nothing the provider sent (FR-028): an invalid line is reported by its position only, never by its body; a
 * line of a type this capability does not match is skipped and counted.
 */
export function parseStatementLine(raw: unknown, position: number): ParsedLine {
  const invalid: ParsedLine = { kind: 'invalid', position };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return invalid;
  const r = raw as Record<string, unknown>;
  const rawType = typeof r.type === 'string' ? r.type : '';
  const type = TYPE_OF[rawType];
  if (!type)
    return {
      kind: 'skipped',
      type: PAYOUT_TYPES.has(rawType) ? 'transfer' : 'unknown',
    };
  if (typeof r.id !== 'string' || r.id === '') return invalid;
  if (typeof r.reference !== 'string' || r.reference === '') return invalid;
  if (typeof r.amount !== 'number' || !Number.isSafeInteger(r.amount))
    return invalid;
  if (typeof r.currency !== 'string' || !/^[A-Za-z]{3}$/.test(r.currency))
    return invalid;
  if (typeof r.created !== 'number' || !Number.isFinite(r.created))
    return invalid;
  return {
    kind: 'line',
    line: {
      id: r.id,
      type,
      reference: r.reference,
      amountMinor: Math.abs(r.amount),
      currency: r.currency.toUpperCase(),
      createdAt: new Date(r.created * 1000),
    },
  };
}

export type LineOutcome =
  { outcome: 'matched' } | { outcome: 'issue'; issue: MatchIssue };

/** One statement line against the ledger's side for its reference (currency is judged before the amount). */
export function classifyLine(
  line: StatementLine,
  ledger: LedgerSide | undefined,
): LineOutcome {
  if (!ledger)
    return {
      outcome: 'issue',
      issue: {
        kind: 'MISSING_IN_LEDGER',
        reference: line.reference,
        details: {
          type: line.type,
          providerAmount: line.amountMinor,
          currency: line.currency,
        },
      },
    };
  if (ledger.currency !== line.currency)
    return {
      outcome: 'issue',
      issue: {
        kind: 'CURRENCY_MISMATCH',
        reference: line.reference,
        details: {
          type: line.type,
          ledger: ledger.currency,
          provider: line.currency,
        },
      },
    };
  if (ledger.amountMinor !== line.amountMinor)
    return {
      outcome: 'issue',
      issue: {
        kind: 'AMOUNT_MISMATCH',
        reference: line.reference,
        details: {
          type: line.type,
          ledger: ledger.amountMinor,
          provider: line.amountMinor,
        },
      },
    };
  return { outcome: 'matched' };
}

/** A journal of the day for which the provider has no line (after the boundary lookup by reference). */
export function classifyMissingAtProvider(ledger: LedgerSide): MatchIssue {
  return {
    kind: 'MISSING_AT_PROVIDER',
    reference: ledger.reference,
    details: {
      type: ledger.kind === 'SALE' ? 'charge' : 'refund',
      ledgerAmount: ledger.amountMinor,
      currency: ledger.currency,
    },
  };
}

export type DuplicateResult =
  | { result: 'new' }
  | { result: 'repeat' }
  | { result: 'duplicate'; issue: MatchIssue };

/**
 * Tells the three cases of a line apart (AS-40, AS-44): the first line of a reference, the same line seen again on
 * a repeated page (counted once), and a different line with the same reference (a duplicate at the provider).
 * Memory is the line ids and references of one day, stated bound ~1 MB for 25 000 lines (research R-9).
 */
export class DuplicateTracker {
  private readonly lineIds = new Set<string>();
  private readonly byReference = new Map<string, string[]>();

  add(line: StatementLine): DuplicateResult {
    if (this.lineIds.has(line.id)) return { result: 'repeat' };
    this.lineIds.add(line.id);
    const key = `${line.type}:${line.reference}`;
    const ids = this.byReference.get(key);
    if (!ids) {
      this.byReference.set(key, [line.id]);
      return { result: 'new' };
    }
    ids.push(line.id);
    return {
      result: 'duplicate',
      issue: {
        kind: 'DUPLICATE_AT_PROVIDER',
        reference: line.reference,
        details: { type: line.type, lineIds: [...ids] },
      },
    };
  }

  /** Number of distinct lines seen. */
  get size(): number {
    return this.lineIds.size;
  }
}

/** Whole-set reconciliation built from the same pieces the run uses page by page (used by tests and small days). */
export function reconcile(
  lines: readonly StatementLine[],
  ledger: readonly LedgerSide[],
): { matched: number; issues: MatchIssue[] } {
  const sides = new Map(ledger.map((s) => [`${s.kind}:${s.reference}`, s]));
  const seen = new Set<string>();
  const tracker = new DuplicateTracker();
  const issues = new Map<string, MatchIssue>();
  let matched = 0;
  for (const line of lines) {
    const t = tracker.add(line);
    if (t.result === 'repeat') continue;
    if (t.result === 'duplicate') {
      issues.set(`${t.issue.kind}:${t.issue.reference}`, t.issue);
      continue;
    }
    const key = `${line.type === 'refund' ? 'REFUND' : 'SALE'}:${line.reference}`;
    seen.add(key);
    const side = line.type === 'dispute' ? undefined : sides.get(key);
    const r = classifyLine(line, side);
    if (r.outcome === 'matched') matched++;
    else issues.set(`${r.issue.kind}:${r.issue.reference}`, r.issue);
  }
  for (const [key, side] of sides) {
    if (seen.has(key)) continue;
    const issue = classifyMissingAtProvider(side);
    issues.set(`${issue.kind}:${issue.reference}`, issue);
  }
  return { matched, issues: [...issues.values()] };
}
