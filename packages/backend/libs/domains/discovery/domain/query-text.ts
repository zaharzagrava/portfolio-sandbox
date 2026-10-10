export const MAX_QUERY_LENGTH = 100;
export const REDACTED = '[redacted]';

/**
 * Query normalisation (FR-052, AS-85): Unicode compatibility folding (fullwidth, ligatures), whitespace-class
 * control characters become spaces, other control characters are removed, whitespace collapses, trim. Case is kept
 * (the engine analyser lower-cases); the log form lower-cases separately.
 */
export function normaliseQuery(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/[\t\n\r\f\v]/g, ' ')
    .replace(/\p{Cc}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const length = (text: string): number => [...text].length;

/** Whether the normalised query is longer than the 100-character cap (the caller answers 400, never truncates). */
export const exceedsQueryLimit = (raw: string): boolean =>
  length(normaliseQuery(raw)) > MAX_QUERY_LENGTH;

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
/** Nine or more digits, optionally separated by single spaces or dashes: long numbers, phone and card numbers. */
const LONG_NUMBER = /\d(?:[ -]?\d){8,}/g;

/** Replaces emails and long or card-like digit runs with `[redacted]`. */
export const redactQuery = (text: string): string =>
  text.replace(EMAIL, REDACTED).replace(LONG_NUMBER, REDACTED);

/**
 * What may be logged for a query: normalised, redacted, lower-cased; `null` when it is shorter than two characters
 * (not logged at all).
 */
export function logForm(raw: string): string | null {
  const normalised = normaliseQuery(raw);
  if (length(normalised) < 2) return null;
  return redactQuery(normalised).toLowerCase();
}
