import { normaliseQuery, REDACTED, redactQuery } from './query-text';

const MIN_LENGTH = 2;
const escape = (word: string): string =>
  word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether the text holds any blocklisted word as a whole word (Unicode-aware, case-insensitive). */
export function containsBlocked(text: string, blocklist: string[]): boolean {
  if (blocklist.length === 0) return false;
  const words = blocklist
    .map((w) => w.trim())
    .filter((w) => w.length > 0)
    .map(escape);
  if (words.length === 0) return false;
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${words.join('|')})(?![\\p{L}\\p{N}_])`,
    'iu',
  );
  return pattern.test(text);
}

/**
 * Whether a logged query may become a public suggestion (FR-018, FR-021): already in the log form (normalised and
 * lower-case), two characters or more, no `[redacted]` marker, nothing a redactor would still replace (rows older than
 * the redactor may hold an email or a long number) and no blocklisted word.
 */
export function isEligibleQuery(query: string, blocklist: string[]): boolean {
  if (query.length === 0 || [...query].length < MIN_LENGTH) return false;
  if (normaliseQuery(query) !== query || query.toLowerCase() !== query)
    return false;
  if (query.includes(REDACTED)) return false;
  if (redactQuery(query) !== query) return false;
  return !containsBlocked(query, blocklist);
}
