import { DateTime } from 'luxon';
import { InvalidPeriodError, PeriodInFutureError } from './errors';

export { InvalidPeriodError, PeriodInFutureError } from './errors';

export type PeriodKind = 'week' | 'month';

export interface Period {
  kind: PeriodKind;
  /** "2026-W40" / "2026-10" */
  id: string;
  start: Date;
  /** Exclusive. */
  end: Date;
  /** Tie-breaker resolution: seconds for weeks (604,800 < 2^20), minutes for months (44,640 < 2^20). */
  unitMs: number;
}

const WEEK_ID = /^(\d{4})-W(\d{2})$/;
const MONTH_ID = /^(\d{4})-(\d{2})$/;

const toUtc = (at: Date | string): DateTime =>
  typeof at === 'string'
    ? DateTime.fromISO(at, { setZone: true }).toUTC()
    : DateTime.fromJSDate(at, { zone: 'utc' });

/** ISO weeks and calendar months, UTC: one global leaderboard calendar for every viewer. An offset input is converted first. */
export function periodOf(kind: PeriodKind, at: Date | string): Period {
  const t = toUtc(at);
  if (!t.isValid) throw new InvalidPeriodError(String(at));
  if (kind === 'week') {
    const start = t.startOf('week');
    return {
      kind,
      id: `${start.weekYear}-W${String(start.weekNumber).padStart(2, '0')}`,
      start: start.toJSDate(),
      end: start.plus({ weeks: 1 }).toJSDate(),
      unitMs: 1_000,
    };
  }
  const start = t.startOf('month');
  return {
    kind,
    id: start.toFormat('yyyy-MM'),
    start: start.toJSDate(),
    end: start.plus({ months: 1 }).toJSDate(),
    unitMs: 60_000,
  };
}

/** The week and the month a sale at `at` belongs to. */
export const periodsOf = (at: Date | string) => ({
  week: periodOf('week', at),
  month: periodOf('month', at),
});

/** Parses a period id of `kind`; a malformed or impossible id is an `InvalidPeriodError` (never a plain Error). */
export function parsePeriod(
  kind: PeriodKind,
  id: string | undefined,
  now: Date = new Date(),
): Period {
  if (id === undefined) return periodOf(kind, now);
  const match = (kind === 'week' ? WEEK_ID : MONTH_ID).exec(id);
  if (!match) throw new InvalidPeriodError(id);
  const [year, number] = [Number(match[1]), Number(match[2])];
  const at =
    kind === 'week'
      ? DateTime.fromObject(
          { weekYear: year, weekNumber: number, weekday: 1 },
          { zone: 'utc' },
        )
      : DateTime.fromObject({ year, month: number, day: 1 }, { zone: 'utc' });
  if (!at.isValid) throw new InvalidPeriodError(id);
  const period = periodOf(kind, at.toJSDate());
  if (period.id !== id) throw new InvalidPeriodError(id);
  return period;
}

/** A period starting after `now` is in the future. */
export function assertNotFuture(period: Period, now: Date): void {
  if (period.start.getTime() > now.getTime())
    throw new PeriodInFutureError(period.id);
}

/** The period is over (its end has passed). */
export const isClosed = (period: Period, now: Date): boolean =>
  period.end.getTime() <= now.getTime();

/** Freezing is allowed one hour after the period ends (grace for late events). */
export const SNAPSHOT_GRACE_MS = 3_600_000;
export const isSnapshotDue = (period: Period, now: Date): boolean =>
  period.end.getTime() + SNAPSHOT_GRACE_MS <= now.getTime();

/** Keys of a period live for 35 days after it ends. */
export const RETENTION_AFTER_END_MS = 35 * 86_400_000;
export const expiresAtMs = (period: Period): number =>
  period.end.getTime() + RETENTION_AFTER_END_MS;

export const isoSeconds = (at: Date): string =>
  at.toISOString().replace('.000Z', 'Z');
