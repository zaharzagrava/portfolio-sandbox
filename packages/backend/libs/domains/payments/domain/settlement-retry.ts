/**
 * Settlement before the sale exists (AS-20): six attempts within ten minutes. The consumer's own attempt is the
 * first; the waits before attempts 2..6 are fixed, so the whole chain is 30+60+120+180+210 s = 600 s (research R-6).
 */
export const SETTLEMENT_RETRY_DELAYS_MS: readonly number[] = [
  30_000, 60_000, 120_000, 180_000, 210_000,
];

export const SETTLEMENT_ATTEMPTS = SETTLEMENT_RETRY_DELAYS_MS.length + 1;

/** What follows failed attempt `attempt` (1-based): the wait before the next one, or null: dead letter. */
export function nextSettlementStep(
  attempt: number,
): { delayMs: number } | null {
  if (!Number.isInteger(attempt) || attempt < 1) return null;
  const delay = SETTLEMENT_RETRY_DELAYS_MS[attempt - 1];
  return delay === undefined ? null : { delayMs: delay };
}
