/** Time rules of an auction (S21 FR-001, FR-023, FR-024). Pure: `now` is passed in (the injected clock). */

export type ExtendInput = {
  endsAt: Date;
  originalEndsAt: Date;
  now: Date;
  /** Only a price-changing bid (`leading` or `outbid`) extends. */
  priceChanged: boolean;
  windowMs: number;
  extensionMs: number;
  capMs: number;
};

/** `endsAt = min(original + cap, max(endsAt, now + extension))` when `endsAt - now <= window` (AS-24, AS-25). */
export function extendEnd(input: ExtendInput): {
  endsAt: Date;
  extended: boolean;
} {
  const { endsAt, originalEndsAt, now } = input;
  if (!input.priceChanged || endsAt.getTime() - now.getTime() > input.windowMs)
    return { endsAt, extended: false };
  const capped = Math.min(
    originalEndsAt.getTime() + input.capMs,
    Math.max(endsAt.getTime(), now.getTime() + input.extensionMs),
  );
  // the cap never shortens an end that is already later (a cap lowered by configuration)
  const next = Math.max(endsAt.getTime(), capped);
  return next > endsAt.getTime()
    ? { endsAt: new Date(next), extended: true }
    : { endsAt, extended: false };
}

export type ScheduleLimits = {
  minLeadMs: number;
  minDurationMs: number;
  maxDurationMs: number;
};

export type ScheduleError = 'starts_too_soon' | 'duration_out_of_range';

/** `startsAt >= now + lead`, length between the limits (FR-001, AS-02). */
export function validateSchedule(
  input: { startsAt: Date; endsAt: Date; now: Date } & ScheduleLimits,
): ScheduleError | null {
  const start = input.startsAt.getTime();
  if (start < input.now.getTime() + input.minLeadMs) return 'starts_too_soon';
  const length = input.endsAt.getTime() - start;
  if (length < input.minDurationMs || length > input.maxDurationMs)
    return 'duration_out_of_range';
  return null;
}

/** `reserve >= starting price` (AS-02). */
export function reserveBelowStarting(
  startingPriceMinor: number,
  reservePriceMinor: number | undefined | null,
): boolean {
  return reservePriceMinor != null && reservePriceMinor < startingPriceMinor;
}
