const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
  ['second', 1],
];

/** "5 minutes ago" for a past instant, whole units rounded down (W01 AS-54). `now` is injectable for tests. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  const [unit, size] = UNITS.find(([, length]) => seconds >= length) ?? ['second', 1];
  return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(-Math.floor(seconds / size), unit);
}

/** "Jun 1, 2026, 8:00 AM" in the member's time zone. */
export const formatDateTime = (iso: string): string => new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
