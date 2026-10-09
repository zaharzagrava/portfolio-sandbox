import { DateTime } from 'luxon';

export type PeriodKind = 'week' | 'month';

export interface Period {
  kind: PeriodKind;
  /** "2026-W40" / "2026-10" */
  id: string;
  start: Date;
  end: Date;
  /** Tie-breaker resolution: seconds for weeks (604,800 < 2^20), minutes for months (44,640 < 2^20). */
  unitMs: number;
}

/** ISO weeks and calendar months, UTC - one global leaderboard calendar for every viewer. */
export function periodOf(kind: PeriodKind, at: Date): Period {
  const t = DateTime.fromJSDate(at, { zone: 'utc' });
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

export function parsePeriod(
  kind: PeriodKind,
  id: string | undefined,
  now = new Date(),
): Period {
  if (!id) return periodOf(kind, now);
  const at =
    kind === 'week'
      ? DateTime.fromObject(
          {
            weekYear: Number(id.slice(0, 4)),
            weekNumber: Number(id.slice(6)),
            weekday: 1,
          },
          { zone: 'utc' },
        )
      : DateTime.fromFormat(id, 'yyyy-MM', { zone: 'utc' });
  if (!at.isValid) throw new Error(`bad period ${id}`);
  return periodOf(kind, at.toJSDate());
}

/**
 * Score = revenue · 2^20 + (time left in the period at the last sale, in units).
 * Equal revenue → whoever reached it EARLIER has more time left → ranks higher.
 * Exact in a double while revenue < 2^33 cents ($85.9M per shop per period).
 */
export const TIE_BITS = 2 ** 20;

export function scoreFor(
  revenueCents: number,
  lastSaleAt: Date,
  period: Period,
): number {
  const left = Math.max(
    0,
    Math.floor((period.end.getTime() - lastSaleAt.getTime()) / period.unitMs),
  );
  return revenueCents * TIE_BITS + Math.min(left, TIE_BITS - 1);
}

export const revenueFromScore = (score: number) => Math.floor(score / TIE_BITS);
