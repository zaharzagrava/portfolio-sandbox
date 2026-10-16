/** Minimum gap between two live `progress` events (S12 AS-16). */
export const PROGRESS_MIN_INTERVAL_MS = 1_000;

/**
 * Whether to publish a progress event now. Times are epoch milliseconds read by the caller from the injected clock.
 * First event, last batch, a gap of at least one second, or a clock that went backwards all publish.
 */
export function shouldPublishProgress(
  nowMs: number,
  lastEventAtMs: number | null,
  isLast: boolean,
): boolean {
  if (isLast || lastEventAtMs === null) return true;
  if (nowMs < lastEventAtMs) return true;
  return nowMs - lastEventAtMs >= PROGRESS_MIN_INTERVAL_MS;
}
