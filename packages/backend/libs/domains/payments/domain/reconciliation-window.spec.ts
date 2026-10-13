import * as fc from 'fast-check';
import { retryCeilingMs, retryDelayMs } from '@app/infrastructure/jobs/backoff';
import {
  RECONCILIATION_MAX_ATTEMPTS,
  catchUpDays,
  dayWindow,
  defaultDay,
  validateDay,
} from './reconciliation-window';

const at = (iso: string) => new Date(iso);

describe('Reconciliation day window', () => {
  it.each([
    ['2026-10-04', '2026-10-04T00:00:00.000Z', '2026-10-05T00:00:00.000Z'],
    ['2026-10-31', '2026-10-31T00:00:00.000Z', '2026-11-01T00:00:00.000Z'],
    ['2026-12-31', '2026-12-31T00:00:00.000Z', '2027-01-01T00:00:00.000Z'],
    ['2028-02-28', '2028-02-28T00:00:00.000Z', '2028-02-29T00:00:00.000Z'],
    ['2028-02-29', '2028-02-29T00:00:00.000Z', '2028-03-01T00:00:00.000Z'],
    ['2026-02-28', '2026-02-28T00:00:00.000Z', '2026-03-01T00:00:00.000Z'],
  ])(
    'S14 AS-47: day %s runs from %s (inclusive) to %s (exclusive)',
    (day, from, to) => {
      const w = dayWindow(day);
      expect(w.fromInclusive.toISOString()).toBe(from);
      expect(w.toExclusive.toISOString()).toBe(to);
    },
  );

  it('S14 AS-47: a window is exactly 24 hours and consecutive days tile without gap or overlap (property)', () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date('2020-01-01T00:00:00Z'),
          max: new Date('2040-01-01T00:00:00Z'),
          noInvalidDate: true,
        }),
        (d) => {
          const day = d.toISOString().slice(0, 10);
          const next = new Date(dayWindow(day).toExclusive)
            .toISOString()
            .slice(0, 10);
          return (
            dayWindow(day).toExclusive.getTime() -
              dayWindow(day).fromInclusive.getTime() ===
              86_400_000 &&
            dayWindow(next).fromInclusive.getTime() ===
              dayWindow(day).toExclusive.getTime()
          );
        },
      ),
    );
  });
});

describe('Which days may run', () => {
  const now = at('2026-10-05T02:30:00Z');

  it.each([
    ['2026-10-05', 'day_not_closed'], // today
    ['2026-10-06', 'day_not_closed'], // future
    ['2027-01-01', 'day_not_closed'],
    ['2026-02-30', 'day_invalid'],
    ['2026-13-01', 'day_invalid'],
    ['2026-00-10', 'day_invalid'],
    ['2026-10-00', 'day_invalid'],
    ['2026-1-5', 'day_invalid'],
    ['yesterday', 'day_invalid'],
    ['', 'day_invalid'],
    ['2026-10-04T00:00:00Z', 'day_invalid'],
    ['2026-07-05', 'day_out_of_range'], // 92 days old
    ['2025-01-01', 'day_out_of_range'],
    ['2026-10-04', 'ok'],
    ['2026-07-07', 'ok'], // exactly 90 days old
    ['2026-07-06', 'day_out_of_range'], // 91 days
    ['2028-02-29', 'day_not_closed'], // valid leap day, but in the future
  ])('S14 AS-48: day %j is %s', (day, expected) => {
    const r = validateDay(day, now);
    expect(r.ok ? 'ok' : r.code).toBe(expected);
  });

  it('S14 AS-48: a non-string day is invalid', () => {
    for (const v of [null, 5, {}, []])
      expect(validateDay(v, now)).toEqual({ ok: false, code: 'day_invalid' });
  });

  it('S14 AS-48: a leap day is valid in a leap year only', () => {
    const feb = at('2028-03-02T02:30:00Z');
    expect(validateDay('2028-02-29', feb).ok).toBe(true);
    expect(validateDay('2027-02-29', at('2027-03-02T02:30:00Z')).ok).toBe(
      false,
    );
  });

  it('S14 AS-48: with no day at 02:30Z the run is for yesterday, also across a month and a year end', () => {
    expect(defaultDay(now)).toBe('2026-10-04');
    expect(defaultDay(at('2026-11-01T02:30:00Z'))).toBe('2026-10-31');
    expect(defaultDay(at('2027-01-01T00:00:00Z'))).toBe('2026-12-31');
    expect(defaultDay(at('2028-03-01T02:30:00Z'))).toBe('2028-02-29');
  });

  it('S14 AS-48: catch-up lists the days of the last N without a completed run, oldest first', () => {
    const done = new Set(['2026-10-04', '2026-10-03', '2026-10-01']);
    expect(catchUpDays(now, done, 7)).toEqual([
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-02',
    ]);
    expect(
      catchUpDays(
        now,
        new Set([
          '2026-09-28',
          '2026-09-29',
          '2026-09-30',
          '2026-10-01',
          '2026-10-02',
          '2026-10-03',
        ]),
        7,
      ),
    ).toEqual(['2026-10-04']);
    expect(catchUpDays(now, new Set(), 1)).toEqual(['2026-10-04']);
  });

  it('S14 AS-48: catch-up never includes today or a day beyond 90 days (property)', () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date('2021-01-01T00:00:00Z'),
          max: new Date('2040-01-01T00:00:00Z'),
          noInvalidDate: true,
        }),
        fc.integer({ min: 1, max: 30 }),
        (n, days) => {
          const list = catchUpDays(n, new Set(), days);
          const today = n.toISOString().slice(0, 10);
          return (
            list.length === days &&
            !list.includes(today) &&
            [...list].sort().join() === list.join()
          );
        },
      ),
    );
  });
});

describe('Job retry bounds of the daily run', () => {
  it('S14 AS-45: at most three attempts', () => {
    expect(RECONCILIATION_MAX_ATTEMPTS).toBe(3);
  });

  it('S14 AS-45: the delay after attempt n is a full-jitter value inside 0..min(15 min, 1 s x 2^n)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10 }),
        fc.double({ min: 0, max: 0.999999, noNaN: true }),
        (attempts, r) => {
          const d = retryDelayMs(attempts, () => r);
          return d >= 0 && d <= retryCeilingMs(attempts);
        },
      ),
    );
    expect(retryCeilingMs(1)).toBe(2_000);
    expect(retryCeilingMs(2)).toBe(4_000);
    expect(retryCeilingMs(30)).toBe(15 * 60_000);
  });
});
