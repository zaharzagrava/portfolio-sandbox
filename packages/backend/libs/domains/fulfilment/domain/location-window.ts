/** A point is accepted when it is at most 5 minutes in the past and at most 10 s ahead of the server clock (FR-006). */
export const STALE_AFTER_MS = 300_000;
export const FUTURE_TOLERANCE_MS = 10_000;

export type PointWindow = 'ok' | 'stale' | 'future';

/** `ts` and `now` are epoch milliseconds; `now` comes from the injected clock. */
export function classifyPoint(ts: number, now: number): PointWindow {
  if (ts < now - STALE_AFTER_MS) return 'stale';
  if (ts > now + FUTURE_TOLERANCE_MS) return 'future';
  return 'ok';
}

/** Splits a batch into the points to keep and the counts of the dropped ones. */
export function partitionPoints<T extends { ts: number }>(
  points: readonly T[],
  now: number,
): { accepted: T[]; dropped: { stale: number; future: number } } {
  const accepted: T[] = [];
  const dropped = { stale: 0, future: 0 };
  for (const point of points) {
    const window = classifyPoint(point.ts, now);
    if (window === 'ok') accepted.push(point);
    else dropped[window]++;
  }
  return { accepted, dropped };
}
