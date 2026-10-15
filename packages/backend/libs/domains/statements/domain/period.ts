/**
 * Months and the period state machine (S16 FR-012, FR-016, FR-020, FR-030). A month is a UTC calendar month written
 * `YYYY-MM`; every bound is a UTC instant computed here and bound as a `timestamptz` parameter, so no query depends
 * on the session time zone (A3). A month with no `AccountingPeriod` row is `OPEN`.
 */
export type PeriodStatus = 'OPEN' | 'CLOSING' | 'CLOSED';

export const FIRST_MONTH = '2020-01';
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

export interface ParsedMonth {
  year: number;
  month: number;
}

export function parseMonth(value: string): ParsedMonth | null {
  const m = MONTH.exec(value);
  return m ? { year: Number(m[1]), month: Number(m[2]) } : null;
}

const format = (year: number, month: number): string =>
  `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;

/** The UTC month an instant belongs to (a `paidAt` with an offset is converted first). */
export const monthOf = (instant: Date): string =>
  format(instant.getUTCFullYear(), instant.getUTCMonth() + 1);

function parsed(month: string): ParsedMonth {
  const p = parseMonth(month);
  if (!p) throw new RangeError(`not a month: ${month}`);
  return p;
}

export function monthBounds(month: string): { start: Date; end: Date } {
  const { year, month: m } = parsed(month);
  return {
    start: new Date(Date.UTC(year, m - 1, 1)),
    end: new Date(Date.UTC(year, m, 1)),
  };
}

export function nextMonth(month: string): string {
  const { year, month: m } = parsed(month);
  return m === 12 ? format(year + 1, 1) : format(year, m + 1);
}

export function previousMonth(month: string): string {
  const { year, month: m } = parsed(month);
  return m === 1 ? format(year - 1, 12) : format(year, m - 1);
}

/** `2026-03` as the `DATE` the tables store. */
export const monthToDate = (month: string): string => `${month}-01`;
export const monthFromDate = (date: string | Date): string =>
  typeof date === 'string' ? date.slice(0, 7) : monthOf(date);

/** Statements cover `2020-01` up to the current UTC month (FR-016). */
export function isMonthAvailable(month: string, now: Date): boolean {
  return month >= FIRST_MONTH && month <= monthOf(now);
}

/** The month has ended at `now` (strictly after its last instant). */
export const hasEnded = (month: string, now: Date): boolean =>
  now.getTime() >= monthBounds(month).end.getTime();

const ALLOWED: ReadonlySet<string> = new Set([
  'OPEN>CLOSING',
  'CLOSING>CLOSED',
  'CLOSING>OPEN',
]);

export const canTransition = (from: PeriodStatus, to: PeriodStatus): boolean =>
  ALLOWED.has(`${from}>${to}`);

/**
 * The month an adjustment is booked in: the UTC month of the booking instant, or the earliest open month after it
 * when that month is not open (FR-030). A month absent from `states` is open.
 */
export function bookingMonth(
  at: Date,
  states: ReadonlyMap<string, PeriodStatus>,
): string {
  let month = monthOf(at);
  while ((states.get(month) ?? 'OPEN') !== 'OPEN') month = nextMonth(month);
  return month;
}
