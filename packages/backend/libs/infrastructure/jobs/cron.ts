import { DateTime, IANAZone } from 'luxon';

/**
 * Pure next-fire computation (S49 FR-040..FR-043): the expression is evaluated on the wall clock of the schedule's IANA
 * zone and the answer is a UTC instant strictly after the base instant. Nothing here reads the clock.
 *
 * Dialect: five fields (minute hour day-of-month month day-of-week) or six with a leading seconds field; lists, ranges,
 * steps, `*`, month and weekday names; no `L`, `W`, `#`, `?`.
 *
 * DST rules:
 *  - a local time that does not exist (spring forward) fires once, at the first instant after the gap;
 *  - a local time that occurs twice (fall back) fires once, at its first occurrence;
 *  - when the hour field is a wildcard the expression means "every elapsed hour": both passes of the repeated hour fire
 *    and the missing hour does not (23 / 25 fires on the two DST days).
 */

export class CronSyntaxError extends Error {
  constructor(detail: string) {
    super(`invalid cron expression: ${detail}`);
    this.name = 'CronSyntaxError';
  }
}

interface ParsedCron {
  seconds: number[];
  minutes: number[];
  hours: number[];
  months: Set<number>;
  dom: Set<number>;
  dow: Set<number>;
  domStar: boolean;
  dowStar: boolean;
  /** Hour field matches every hour of the day: scan elapsed time instead of walking the local calendar. */
  allHours: boolean;
}

const MONTH_NAMES = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
];
const DOW_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: string[];
  /** Value of names[0]. */
  nameBase?: number;
}

const SPECS: Record<'s' | 'm' | 'h' | 'dom' | 'mon' | 'dow', FieldSpec> = {
  s: { name: 'seconds', min: 0, max: 59 },
  m: { name: 'minutes', min: 0, max: 59 },
  h: { name: 'hours', min: 0, max: 23 },
  dom: { name: 'day-of-month', min: 1, max: 31 },
  mon: { name: 'month', min: 1, max: 12, names: MONTH_NAMES, nameBase: 1 },
  dow: { name: 'day-of-week', min: 0, max: 7, names: DOW_NAMES, nameBase: 0 },
};

function parseValue(token: string, spec: FieldSpec): number {
  if (/^\d+$/.test(token)) {
    const value = Number(token);
    if (value < spec.min || value > spec.max)
      throw new CronSyntaxError(
        `${spec.name} value ${value} is outside ${spec.min}-${spec.max}`,
      );
    return value;
  }
  const index = spec.names?.indexOf(token.toUpperCase()) ?? -1;
  if (index < 0) throw new CronSyntaxError(`${spec.name} has "${token}"`);
  return index + (spec.nameBase ?? 0);
}

function parseField(text: string, spec: FieldSpec): Set<number> {
  const out = new Set<number>();
  if (!/^[0-9A-Za-z*/,-]+$/.test(text))
    throw new CronSyntaxError(`${spec.name} has unsupported characters`);
  for (const item of text.split(',')) {
    const [range, stepText, extra] = item.split('/');
    if (extra !== undefined || range === '')
      throw new CronSyntaxError(`${spec.name} has "${item}"`);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1)
        throw new CronSyntaxError(`${spec.name} step "${stepText}"`);
      step = Number(stepText);
    }
    let from: number;
    let to: number;
    if (range === '*') {
      from = spec.min;
      to = spec === SPECS.dow ? 6 : spec.max;
    } else if (range.includes('-')) {
      const parts = range.split('-');
      if (parts.length !== 2)
        throw new CronSyntaxError(`${spec.name} "${item}"`);
      from = parseValue(parts[0], spec);
      to = parseValue(parts[1], spec);
      if (from > to)
        throw new CronSyntaxError(`${spec.name} range "${range}" is reversed`);
    } else {
      from = parseValue(range, spec);
      to = stepText === undefined ? from : spec.max;
    }
    for (let v = from; v <= to; v += step)
      out.add(spec === SPECS.dow && v === 7 ? 0 : v);
  }
  return out;
}

const sorted = (set: Set<number>): number[] => [...set].sort((a, b) => a - b);
const parseCache = new Map<string, ParsedCron>();

function parseCron(expression: string): ParsedCron {
  const cached = parseCache.get(expression);
  if (cached) return cached;
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5 && parts.length !== 6)
    throw new CronSyntaxError(
      'expected 5 fields, or 6 with a leading seconds field',
    );
  const [s, m, h, dom, mon, dow] = parts.length === 6 ? parts : ['0', ...parts];
  const hours = parseField(h, SPECS.h);
  const parsed: ParsedCron = {
    seconds: sorted(parseField(s, SPECS.s)),
    minutes: sorted(parseField(m, SPECS.m)),
    hours: sorted(hours),
    months: parseField(mon, SPECS.mon),
    dom: parseField(dom, SPECS.dom),
    dow: parseField(dow, SPECS.dow),
    domStar: dom.startsWith('*'),
    dowStar: dow.startsWith('*'),
    allHours: hours.size === 24,
  };
  if (parseCache.size > 1_000) parseCache.clear();
  parseCache.set(expression, parsed);
  return parsed;
}

function dayMatches(
  c: ParsedCron,
  month: number,
  day: number,
  weekday: number,
) {
  if (!c.months.has(month)) return false;
  const byDom = c.dom.has(day);
  const byDow = c.dow.has(weekday % 7);
  if (c.domStar && c.dowStar) return true;
  if (c.domStar) return byDow;
  if (c.dowStar) return byDom;
  return byDom || byDow;
}

const firstAtLeast = (values: number[], at: number): number | undefined =>
  values.find((v) => v >= at);

/** Next wall-clock time (as a UTC-labelled DateTime) at or after `start` that matches the expression. */
function nextFloating(c: ParsedCron, start: DateTime): DateTime {
  let dt = start;
  const horizon = start.year + 10;
  while (dt.year <= horizon) {
    if (!c.months.has(dt.month)) {
      dt = dt.plus({ months: 1 }).startOf('month');
      continue;
    }
    if (!dayMatches(c, dt.month, dt.day, dt.weekday)) {
      dt = dt.plus({ days: 1 }).startOf('day');
      continue;
    }
    const hour = firstAtLeast(c.hours, dt.hour);
    if (hour === undefined) {
      dt = dt.plus({ days: 1 }).startOf('day');
      continue;
    }
    if (hour !== dt.hour) {
      dt = dt.set({ hour, minute: 0, second: 0, millisecond: 0 });
      continue;
    }
    const minute = firstAtLeast(c.minutes, dt.minute);
    if (minute === undefined) {
      dt = dt.plus({ hours: 1 }).startOf('hour');
      continue;
    }
    if (minute !== dt.minute) {
      dt = dt.set({ minute, second: 0, millisecond: 0 });
      continue;
    }
    const second = firstAtLeast(c.seconds, dt.second);
    if (second === undefined) {
      dt = dt.plus({ minutes: 1 }).startOf('minute');
      continue;
    }
    return dt.set({ second, millisecond: 0 });
  }
  throw new CronSyntaxError('the expression never fires');
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * UTC instants whose local wall clock reads `floating`: none in a DST gap (then the instant the gap ends), one normally,
 * two in the repeated hour. Returns them earliest first.
 */
function resolveLocal(
  floating: DateTime,
  zone: string,
): { instants: number[]; gapEnd?: number } {
  const wall = floating.toMillis();
  const offsetAt = (ms: number) => DateTime.fromMillis(ms, { zone }).offset;
  const before = offsetAt(wall - DAY_MS);
  const after = offsetAt(wall + DAY_MS);
  const instants = [...new Set([before, after])]
    .map((offset) => ({ offset, at: wall - offset * MINUTE_MS }))
    .filter(({ offset, at }) => offsetAt(at) === offset)
    .map(({ at }) => at)
    .sort((a, b) => a - b);
  if (instants.length > 0) return { instants };

  // Gap: the offset jumps from `before` to `after` somewhere in [wall - after, wall - before]; find that instant.
  let lo = wall - after * MINUTE_MS;
  let hi = wall - before * MINUTE_MS;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (offsetAt(mid) === after) hi = mid;
    else lo = mid;
  }
  return { instants: [], gapEnd: hi };
}

/**
 * Next fire time strictly after `after`, evaluated in the schedule's IANA time zone. "Every day 09:00 Europe/Warsaw"
 * stays 09:00 local across DST switches (the UTC instant moves) - computing in UTC would drift an hour twice a year.
 * Throws `CronSyntaxError` for a bad expression or unknown zone, or an expression that can never fire (31 February).
 */
export function nextFireAt(cron: string, timezone: string, after: Date): Date {
  const parsed = parseCron(cron);
  if (!IANAZone.isValidZone(timezone))
    throw new CronSyntaxError(`unknown time zone "${timezone}"`);
  // smallest whole second strictly after the base
  const startMs = Math.floor(after.getTime() / 1000) * 1000 + 1000;
  return new Date(
    parsed.allHours
      ? scanElapsed(parsed, timezone, startMs)
      : walkLocal(parsed, timezone, startMs),
  );
}

/** Hour wildcard: step through elapsed time so a repeated hour fires twice and a skipped hour not at all. */
function scanElapsed(c: ParsedCron, zone: string, startMs: number): number {
  let t = startMs;
  const stop = startMs + 11 * 366 * DAY_MS;
  while (t < stop) {
    const dt = DateTime.fromMillis(t, { zone });
    if (!dayMatches(c, dt.month, dt.day, dt.weekday)) {
      t = dt.plus({ days: 1 }).startOf('day').toMillis();
      continue;
    }
    if (!c.minutes.includes(dt.minute)) {
      t += (60 - dt.second) * 1000;
      continue;
    }
    if (!c.seconds.includes(dt.second)) {
      const nextSecond = firstAtLeast(c.seconds, dt.second);
      t += ((nextSecond ?? 60) - dt.second) * 1000;
      continue;
    }
    return t;
  }
  throw new CronSyntaxError('the expression never fires');
}

/** Explicit hours: walk local calendar times and resolve each to an instant (gap -> end of gap, repeat -> first). */
function walkLocal(c: ParsedCron, zone: string, startMs: number): number {
  const local = DateTime.fromMillis(startMs, { zone });
  let floating = DateTime.fromObject(
    {
      year: local.year,
      month: local.month,
      day: local.day,
      hour: local.hour,
      minute: local.minute,
      second: local.second,
    },
    { zone: 'utc' },
  );
  for (let i = 0; i < 50_000; i++) {
    floating = nextFloating(c, floating);
    const { instants, gapEnd } = resolveLocal(floating, zone);
    const instant = instants.length > 0 ? instants[0] : gapEnd!;
    if (instant >= startMs) return instant;
    floating = floating.plus({ seconds: 1 });
  }
  throw new CronSyntaxError('the expression never fires');
}

/** True for a well-formed expression of this dialect in a known zone that fires at least once. */
export function isValidCron(cron: string, timezone = 'UTC'): boolean {
  try {
    nextFireAt(cron, timezone, new Date(0));
    return true;
  } catch {
    return false;
  }
}
