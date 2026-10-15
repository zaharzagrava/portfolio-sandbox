/**
 * The payout period and the next scheduled run (S15 FR-001, FR-010, AS-13, AS-35). Pure: `now` is a parameter. A
 * period is the Monday (a UTC calendar date) that starts the week being paid.
 */
const DAY_MS = 86_400_000;
const MAX_WEEKS_BACK = 52;
const WARSAW = 'Europe/Warsaw';
const RUN_HOUR_LOCAL = 6;

const ymd = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The Monday (UTC date) of the week containing `now`. */
export function periodStartOf(now: Date): string {
  const day = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const sinceMonday = (new Date(day).getUTCDay() + 6) % 7;
  return ymd(day - sinceMonday * DAY_MS);
}

export type PeriodCheck = { ok: true; periodStart: string } | { ok: false };

/** A real calendar date, a Monday, not after the current week, not older than 52 weeks. */
export function validatePeriod(input: unknown, now: Date): PeriodCheck {
  const refused: PeriodCheck = { ok: false };
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input))
    return refused;
  const at = Date.parse(`${input}T00:00:00Z`);
  if (Number.isNaN(at) || ymd(at) !== input) return refused;
  if (new Date(at).getUTCDay() !== 1) return refused;
  const current = Date.parse(`${periodStartOf(now)}T00:00:00Z`);
  if (at > current) return refused;
  if (at < current - MAX_WEEKS_BACK * 7 * DAY_MS) return refused;
  return { ok: true, periodStart: input };
}

const zoneFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: WARSAW,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Offset of Warsaw from UTC at an instant, in ms (+1 h or +2 h). */
function warsawOffsetMs(utcMs: number): number {
  const parts: Record<string, number> = {};
  for (const p of zoneFormat.formatToParts(new Date(utcMs)))
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** The UTC instant at which a Warsaw wall clock reads `y-m-d hour:00`. */
function warsawWallToUtc(
  y: number,
  m: number,
  d: number,
  hour: number,
): number {
  const wall = Date.UTC(y, m, d, hour);
  let guess = wall - warsawOffsetMs(wall);
  guess = wall - warsawOffsetMs(guess);
  return guess;
}

/** The next Monday 06:00 `Europe/Warsaw` strictly after `now`, as a UTC instant (daylight saving included). */
export function nextRunAt(now: Date): Date {
  const local = new Date(now.getTime() + warsawOffsetMs(now.getTime()));
  const midnight = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
  );
  for (let ahead = 0; ahead <= 7; ahead += 1) {
    const day = new Date(midnight + ahead * DAY_MS);
    if (day.getUTCDay() !== 1) continue;
    const at = warsawWallToUtc(
      day.getUTCFullYear(),
      day.getUTCMonth(),
      day.getUTCDate(),
      RUN_HOUR_LOCAL,
    );
    if (at > now.getTime()) return new Date(at);
  }
  throw new Error('no Monday found within eight days');
}
