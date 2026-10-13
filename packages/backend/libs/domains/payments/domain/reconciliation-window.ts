/** Days and windows of the daily reconciliation (S14 FR-033, research R-9). Pure: `now` is a parameter. */
export const RECONCILIATION_MAX_ATTEMPTS = 3;
/** A run may be asked for a closed day at most this many days back. */
export const RECONCILIATION_MAX_AGE_DAYS = 90;

export type DayError = 'day_invalid' | 'day_not_closed' | 'day_out_of_range';

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

/** The day string when it is a real calendar date written `YYYY-MM-DD`, else null. */
export function parseDay(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = DAY.exec(raw);
  if (!m) return null;
  const date = new Date(`${raw}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || utcDay(date) !== raw ? null : raw;
}

export function dayWindow(day: string): {
  fromInclusive: Date;
  toExclusive: Date;
} {
  const from = new Date(`${day}T00:00:00.000Z`);
  return {
    fromInclusive: from,
    toExclusive: new Date(from.getTime() + MS_PER_DAY),
  };
}

/** The previous UTC day: what the nightly job reconciles when it is given no day. */
export function defaultDay(now: Date): string {
  return utcDay(
    new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
        MS_PER_DAY,
    ),
  );
}

/** A day may run when it is a real date, closed (before today, UTC) and at most 90 days old. */
export function validateDay(
  raw: unknown,
  now: Date,
): { ok: true; day: string } | { ok: false; code: DayError } {
  const day = parseDay(raw);
  if (!day) return { ok: false, code: 'day_invalid' };
  const today = utcDay(now);
  if (day >= today) return { ok: false, code: 'day_not_closed' };
  const ageDays = Math.round(
    (new Date(`${today}T00:00:00.000Z`).getTime() -
      new Date(`${day}T00:00:00.000Z`).getTime()) /
      MS_PER_DAY,
  );
  if (ageDays > RECONCILIATION_MAX_AGE_DAYS)
    return { ok: false, code: 'day_out_of_range' };
  return { ok: true, day };
}

/** The last `days` closed days that have no `COMPLETED` run, oldest first. */
export function catchUpDays(
  now: Date,
  completed: ReadonlySet<string>,
  days: number,
): string[] {
  const yesterday = new Date(`${defaultDay(now)}T00:00:00.000Z`).getTime();
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = utcDay(new Date(yesterday - i * MS_PER_DAY));
    if (!completed.has(day)) out.push(day);
  }
  return out;
}
