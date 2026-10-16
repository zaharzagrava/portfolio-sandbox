/**
 * The payout destination rules (S15 FR-028…FR-030): format, mask, and when a changed destination starts to count.
 * Pure: `now` and the cooling period are parameters.
 */
const FORMAT = /^acct_[A-Za-z0-9]{8,64}$/;

/** The ids the scripted payout provider answers by (S15.R-27): without them the operator could never choose a double. */
const SCRIPTED_DOUBLES: ReadonlySet<string> = new Set([
  'acct_test_ok',
  'acct_test_reject',
  'acct_test_timeout',
]);

export const validateDestination = (id: string): boolean =>
  typeof id === 'string' && (FORMAT.test(id) || SCRIPTED_DOUBLES.has(id));

/** The first 5 and the last 3 characters: enough for support to recognise it, nothing a thief can use. */
export const maskDestination = (id: string): string =>
  `${id.slice(0, 5)}…${id.slice(-3)}`;

/**
 * When the destination being set starts to count: the first one at once, a different one after the cooling period,
 * `null` for the same value (nothing is written).
 */
export function effectiveFromFor(
  existingId: string | null,
  nextId: string,
  now: Date,
  coolingMs: number,
): Date | null {
  if (existingId === null) return now;
  if (existingId === nextId) return null;
  return new Date(now.getTime() + coolingMs);
}

/** A destination whose effective instant is still ahead is cooling: the shop is skipped, not paid to the old account. */
export const isCooling = (effectiveFrom: Date, now: Date): boolean =>
  now.getTime() < effectiveFrom.getTime();
