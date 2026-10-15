/**
 * A period is the half-open interval `[start, end)` in UTC (S18 FR-019): the instant a period ends belongs to the
 * next one. Usage is attributed by the event time `ts`; the ingestion instant never attributes anything.
 */
export function periodContains(start: Date, end: Date, instant: Date): boolean {
  return (
    instant.getTime() >= start.getTime() && instant.getTime() < end.getTime()
  );
}

export function attributedTo(
  event: { ts: Date; ingestedAt: Date },
  start: Date,
  end: Date,
): boolean {
  return periodContains(start, end, event.ts);
}

/** A period is final this long after its end: no event older than the 90-day window can still arrive (FR-030). */
export const PERIOD_FINAL_AFTER_DAYS = 91;

export function periodFinalAt(periodEnd: Date): Date {
  return new Date(periodEnd.getTime() + PERIOD_FINAL_AFTER_DAYS * 86_400_000);
}

export const isPeriodFinal = (periodEnd: Date, measuredAt: Date): boolean =>
  measuredAt.getTime() >= periodFinalAt(periodEnd).getTime();
