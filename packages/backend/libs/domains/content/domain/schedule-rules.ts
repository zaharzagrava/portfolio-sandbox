const DAY_MS = 24 * 3_600_000;

/** ISO-8601 date-time with an offset (`Z` or `±hh:mm`), seconds required. */
const ISO_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

export type ScheduleCheck =
  | { ok: true; at: Date }
  | {
      ok: false;
      code: 'invalid_format' | 'schedule_in_past' | 'schedule_too_far';
    };

/**
 * A schedule time must be ISO-8601 with an offset, strictly after `now` and at most `horizonDays` ahead (S27 AS-43).
 * `now` is an argument: the domain never reads the wall clock.
 */
export function checkSchedule(
  at: string,
  now: Date,
  horizonDays: number,
): ScheduleCheck {
  if (!ISO_WITH_OFFSET.test(at)) return { ok: false, code: 'invalid_format' };
  const time = new Date(at);
  if (Number.isNaN(time.getTime()))
    return { ok: false, code: 'invalid_format' };
  if (time.getTime() <= now.getTime())
    return { ok: false, code: 'schedule_in_past' };
  if (time.getTime() > now.getTime() + horizonDays * DAY_MS)
    return { ok: false, code: 'schedule_too_far' };
  return { ok: true, at: time };
}

/** A schedule is due at its time and never earlier (S27 AS-41). */
export const isDue = (scheduledAt: Date | null, now: Date): boolean =>
  scheduledAt !== null && now.getTime() >= scheduledAt.getTime();
