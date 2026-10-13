import { DateTime } from 'luxon';
import { timezoneFallbackCounter } from './metrics';

export interface QuietHours {
  timezone: string;
  /** "22:00" - local wall-clock time. */
  start: string | null;
  /** "07:30"; may be earlier than start (window crosses midnight). */
  end: string | null;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * If `now` falls inside the user's quiet window (their local time zone, DST-aware), returns the instant the window
 * ends; otherwise null (send now). `now` comes from the injected clock.
 *
 * The window is judged on the zone's wall clock, so "07:30 local" on a DST-change morning is still 07:30 on the clock,
 * not "start + 9.5h". The end is the first instant after `now` whose wall clock is outside the window: when the end
 * time does not exist (skipped by spring-forward) that is the first valid instant after the gap; when it occurs twice
 * (fall-back) it is the first occurrence, or the second when `now` is already past the first.
 * An unknown zone behaves as UTC and is counted.
 */
export function quietHoursEnd(now: Date, quiet: QuietHours): Date | null {
  if (!quiet.start || !quiet.end || quiet.start === quiet.end) return null;
  let local = DateTime.fromJSDate(now, { zone: quiet.timezone });
  if (!local.isValid) {
    timezoneFallbackCounter.add(1);
    local = DateTime.fromJSDate(now, { zone: 'utc' });
  }
  const zone = local.zone;

  const minutes = local.hour * 60 + local.minute;
  const start = toMinutes(quiet.start);
  const end = toMinutes(quiet.end);
  const crossesMidnight = start > end;
  const inside = crossesMidnight
    ? minutes >= start || minutes < end
    : minutes >= start && minutes < end;
  if (!inside) return null;

  // The end falls on the next calendar day when the window crosses midnight and we are still before it.
  const day =
    crossesMidnight && minutes >= start ? local.plus({ days: 1 }) : local;
  const wallAsUtc = Date.UTC(
    day.year,
    day.month - 1,
    day.day,
    Math.floor(end / 60),
    end % 60,
  );
  const offsetAt = (ms: number) => zone.offset(ms); // minutes east of UTC

  // Instants whose wall clock reads the end time: one offset before the day, one after (they differ on a DST day).
  const candidates = [
    ...new Set([
      offsetAt(wallAsUtc - DAY_MS),
      offsetAt(wallAsUtc),
      offsetAt(wallAsUtc + DAY_MS),
    ]),
  ]
    .map((offset) => ({ offset, at: wallAsUtc - offset * MINUTE_MS }))
    .filter(({ offset, at }) => offsetAt(at) === offset)
    .map(({ at }) => at)
    .sort((a, b) => a - b);
  const next = candidates.find((at) => at > now.getTime());
  if (next !== undefined) return new Date(next);

  // The end time does not exist on that day: the first instant after the gap.
  const before = offsetAt(wallAsUtc - DAY_MS);
  let lo = wallAsUtc - 2 * DAY_MS; // offset === before
  let hi = wallAsUtc + 2 * DAY_MS; // offset !== before
  while (hi - lo > 1_000) {
    const mid = lo + Math.floor((hi - lo) / 2_000) * 1_000;
    if (offsetAt(mid) === before) lo = mid;
    else hi = mid;
  }
  return new Date(hi);
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
