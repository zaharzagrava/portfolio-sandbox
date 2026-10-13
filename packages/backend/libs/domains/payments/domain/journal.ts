import { createHash } from 'node:crypto';
import { v5 as uuidv5 } from 'uuid';
import { parseAccountId } from './account';
import { JournalInvalid, JournalUnbalanced } from './ledger-errors';

export const JOURNAL_KINDS = [
  'SALE',
  'REFUND',
  'SETTLEMENT',
  'SWEEP',
  'PAYOUT',
  'PAYOUT_REVERSAL',
  'AD_CHARGE',
  'ADJUSTMENT',
] as const;
export type JournalKind = (typeof JOURNAL_KINDS)[number];

/** The kinds a caller may post through `postJournal` (FR-008). */
export const CALLER_KINDS = [
  'PAYOUT',
  'PAYOUT_REVERSAL',
  'AD_CHARGE',
  'ADJUSTMENT',
] as const;
export type CallerJournalKind = (typeof CALLER_KINDS)[number];

export const MIN_LINES = 2;
export const MAX_LINES = 200;
export const MAX_REFERENCE_LENGTH = 200;

/** Namespace of the deterministic journal ids. */
const LEDGER_NS = '3c1f0a52-8d0e-4e8a-9a3b-5f6b1d2c7e90';

export interface JournalLineInput {
  accountId: string;
  amountMinor: number;
  /** Optional; a line naming another currency than the journal is refused. */
  currency?: string;
}

export interface JournalInput {
  kind: string;
  reference: string;
  currency: string;
  lines: JournalLineInput[];
}

export interface CanonicalLine {
  accountId: string;
  shard: number;
  amountMinor: number;
}

const CURRENCY = /^[A-Z]{3}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export function isValidReference(reference: unknown): reference is string {
  return (
    typeof reference === 'string' &&
    reference.length >= 1 &&
    reference.length <= MAX_REFERENCE_LENGTH &&
    !CONTROL.test(reference)
  );
}

/**
 * The pure rules of a journal (FR-001, FR-004, FR-008, FR-010): throws `JournalInvalid` with the first reason found
 * or `JournalUnbalanced`; touches nothing. `fromCaller` limits the kinds to those `postJournal` accepts.
 */
export function validateJournal(
  input: JournalInput,
  options: { fromCaller: boolean },
): void {
  const allowed: readonly string[] = options.fromCaller
    ? CALLER_KINDS
    : JOURNAL_KINDS;
  if (typeof input.kind !== 'string' || !allowed.includes(input.kind))
    throw new JournalInvalid('kind_not_allowed');
  if (!isValidReference(input.reference))
    throw new JournalInvalid('reference_invalid');
  if (typeof input.currency !== 'string' || !CURRENCY.test(input.currency))
    throw new JournalInvalid('currency_invalid');
  if (!Array.isArray(input.lines) || input.lines.length < MIN_LINES)
    throw new JournalInvalid('journal_too_few_lines');
  if (input.lines.length > MAX_LINES)
    throw new JournalInvalid('journal_too_large');

  let sum = 0n;
  for (const line of input.lines) {
    if (line.currency !== undefined && line.currency !== input.currency)
      throw new JournalInvalid('journal_currency_mismatch');
    const amount = line.amountMinor;
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount))
      throw new JournalInvalid('line_amount_invalid');
    if (amount === 0) throw new JournalInvalid('line_amount_zero');
    if (!parseAccountId(line.accountId))
      throw new JournalInvalid('account_unknown');
    sum += BigInt(amount);
  }
  if (sum !== 0n) throw new JournalUnbalanced(Number(sum));
}

/** Deterministic from (kind, reference): the same pair is the same journal everywhere (FR-005). */
export function journalId(kind: string, reference: string): string {
  return uuidv5(`${kind}:${reference}`, LEDGER_NS);
}

/** Order-independent digest of what a journal says; a second posting with another one is a `JournalConflict`. */
export function journalFingerprint(
  currency: string,
  lines: readonly CanonicalLine[],
): string {
  const canonical = lines
    .map((l) => `${l.accountId}\u0000${l.shard}\u0000${l.amountMinor}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(`${currency}\n${canonical}`).digest('hex');
}
