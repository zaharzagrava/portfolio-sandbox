/** Incremental-pull watermark rules (AS-16, AS-17, FR-010). Pure: the clock is passed in. */
export const OVERLAP_MS = 5 * 60_000;

/** The provider is asked for changes since exactly `W - 5 min`. */
export function sinceFor(watermark: Date): Date {
  return new Date(watermark.getTime() - OVERLAP_MS);
}

/**
 * New watermark after a complete pass: the largest fetched `updatedAt`, clamped to `now`, never below `current`.
 * `null` only when there was neither a watermark nor a fetched item.
 */
export function advanceWatermark(input: {
  current: Date | null;
  fetched: readonly Date[];
  now: Date;
}): Date | null {
  const { current, fetched, now } = input;
  let max: number | null = null;
  for (const d of fetched) {
    const t = d.getTime();
    if (Number.isNaN(t)) continue;
    if (max === null || t > max) max = t;
  }
  if (max === null) return current;
  const clamped = Math.min(max, now.getTime());
  if (current && current.getTime() >= clamped) return current;
  return new Date(clamped);
}
