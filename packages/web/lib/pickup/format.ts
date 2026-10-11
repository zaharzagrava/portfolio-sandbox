import type { PickupOpeningHours } from '@marketplace-sandbox/contracts';

/** Distance text of W02 FR-072: metres rounded to 10 below 1 km ("850 m"), kilometres with one decimal otherwise ("2.4 km"). */
export function formatDistance(meters: number): string {
  const m = Number.isFinite(meters) && meters > 0 ? meters : 0;
  const rounded = Math.round(m / 10) * 10;
  if (rounded < 1000) return `${rounded} m`;
  return `${(Math.round(m / 100) / 10).toFixed(1)} km`;
}

export type OpeningStatus =
  | { kind: 'unknown' }
  | { kind: 'open'; closesAt: string }
  | { kind: 'closed'; opensAt?: { day: string; time: string } };

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const DAY_LABEL: Record<(typeof DAYS)[number], string> = { sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat' };
const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

type Interval = { open: string; close: string };
type Weekly = Partial<Record<(typeof DAYS)[number], Interval[] | undefined>>;

/** Weekday index and "HH:mm" of `now` in the zone; `null` when the zone is unknown. */
function localClock(now: Date, timeZone: string): { day: number; time: string } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
    const day = WEEKDAY_INDEX[get('weekday')];
    const hour = get('hour') === '24' ? '00' : get('hour');
    if (day === undefined) return null;
    return { day, time: `${hour}:${get('minute')}` };
  } catch {
    return null;
  }
}

/** A pure function of the opening hours, the current time and the point's own time zone (FR-073). */
export function openingStatus(hours: PickupOpeningHours | null | undefined, now: Date): OpeningStatus {
  if (!hours || typeof hours !== 'object' || !('weekly' in hours) || !hours.weekly || typeof hours.timezone !== 'string') return { kind: 'unknown' };
  const clock = localClock(now, hours.timezone);
  if (!clock) return { kind: 'unknown' };
  const weekly = hours.weekly as Weekly;
  const intervalsOf = (dayIndex: number) => [...(weekly[DAYS[dayIndex]] ?? [])].sort((a, b) => (a.open < b.open ? -1 : 1));

  for (const interval of intervalsOf(clock.day)) {
    if (interval.open <= clock.time && clock.time < interval.close) return { kind: 'open', closesAt: interval.close };
  }

  for (let offset = 0; offset <= 7; offset++) {
    const dayIndex = (clock.day + offset) % 7;
    for (const interval of intervalsOf(dayIndex)) {
      const later = offset === 0 ? interval.open > clock.time : offset < 7 || interval.open <= clock.time;
      if (later) return { kind: 'closed', opensAt: { day: DAY_LABEL[DAYS[dayIndex]], time: interval.open } };
    }
  }
  return { kind: 'closed' };
}

export function openingText(status: OpeningStatus): string {
  switch (status.kind) {
    case 'unknown':
      return 'Hours not provided';
    case 'open':
      return `Open now · closes ${status.closesAt}`;
    case 'closed':
      return status.opensAt ? `Closed · opens ${status.opensAt.day} ${status.opensAt.time}` : 'Closed';
  }
}
