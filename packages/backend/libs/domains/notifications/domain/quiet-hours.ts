import { DateTime } from 'luxon';

export interface QuietHours {
  timezone: string;
  /** "22:00" - local wall-clock time. */
  start: string | null;
  /** "07:30"; may be earlier than start (window crosses midnight). */
  end: string | null;
}

/**
 * If `now` falls inside the user's quiet window (their local time zone,
 * DST-aware), returns when the window ends; otherwise null (send now).
 *
 * Wall-clock arithmetic is done in the user's zone with Luxon: "07:30 local"
 * on a DST-change morning is still 07:30 on the clock, not "start + 9.5h".
 * An invalid zone falls back to UTC rather than silently never sending.
 */
export function quietHoursEnd(now: Date, quiet: QuietHours): Date | null {
  if (!quiet.start || !quiet.end || quiet.start === quiet.end) return null;
  let local = DateTime.fromJSDate(now, { zone: quiet.timezone });
  if (!local.isValid) local = DateTime.fromJSDate(now, { zone: 'utc' });

  const minutes = local.hour * 60 + local.minute;
  const start = toMinutes(quiet.start);
  const end = toMinutes(quiet.end);
  const crossesMidnight = start > end;
  const inside = crossesMidnight
    ? minutes >= start || minutes < end
    : minutes >= start && minutes < end;
  if (!inside) return null;

  const [h, m] = quiet.end.split(':').map(Number);
  let endsAt = local.set({ hour: h, minute: m, second: 0, millisecond: 0 });
  if (endsAt <= local) endsAt = endsAt.plus({ days: 1 });
  return endsAt.toJSDate();
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
