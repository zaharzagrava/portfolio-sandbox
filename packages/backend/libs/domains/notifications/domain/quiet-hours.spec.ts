import * as fc from 'fast-check';
import { DateTime } from 'luxon';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { quietHoursEnd, type QuietHours } from './quiet-hours';

const endOf = (now: string, quiet: QuietHours) =>
  quietHoursEnd(new Date(now), quiet)?.toISOString() ?? null;

describe('S28 AS-33: quiet-hours window arithmetic across zones and daylight saving', () => {
  it.each([
    // [case, zone, start, end, now, expected end or null]
    [
      'overnight window, now exactly at start',
      'Europe/Kyiv',
      '22:00',
      '07:30',
      '2026-06-10T19:00:00Z',
      '2026-06-11T04:30:00.000Z',
    ],
    [
      'now one second before start',
      'Europe/Kyiv',
      '22:00',
      '07:30',
      '2026-06-10T18:59:59Z',
      null,
    ],
    [
      'now exactly at end',
      'Europe/Kyiv',
      '22:00',
      '07:30',
      '2026-06-11T04:30:00Z',
      null,
    ],
    [
      'now one second before end',
      'Europe/Kyiv',
      '22:00',
      '07:30',
      '2026-06-11T04:29:59Z',
      '2026-06-11T04:30:00.000Z',
    ],
    [
      'window within one day',
      'Europe/Kyiv',
      '13:00',
      '15:00',
      '2026-06-10T11:00:00Z',
      '2026-06-10T12:00:00.000Z',
    ],
    [
      'start equals end means no window',
      'Europe/Kyiv',
      '22:00',
      '22:00',
      '2026-06-10T19:30:00Z',
      null,
    ],
    [
      'America/New_York (EDT)',
      'America/New_York',
      '22:00',
      '07:00',
      '2026-07-01T03:00:00Z',
      '2026-07-01T11:00:00.000Z',
    ],
    [
      'Asia/Kolkata (+05:30)',
      'Asia/Kolkata',
      '23:00',
      '06:15',
      '2026-01-10T18:00:00Z',
      '2026-01-11T00:45:00.000Z',
    ],
    [
      'Pacific/Auckland (NZDT, +13)',
      'Pacific/Auckland',
      '21:00',
      '07:00',
      '2026-01-10T08:30:00Z',
      '2026-01-10T18:00:00.000Z',
    ],
    [
      'spring-forward night keeps the wall-clock end',
      'Europe/Kyiv',
      '22:00',
      '07:30',
      '2026-03-28T20:30:00Z',
      '2026-03-29T04:30:00.000Z',
    ],
    [
      'end inside the skipped hour is the first valid instant after the gap',
      'Europe/Kyiv',
      '23:00',
      '03:30',
      '2026-03-28T22:00:00Z',
      '2026-03-29T01:00:00.000Z',
    ],
    [
      'ambiguous end: first occurrence',
      'Europe/Kyiv',
      '23:00',
      '03:30',
      '2026-10-24T21:00:00Z',
      '2026-10-25T00:30:00.000Z',
    ],
    [
      'ambiguous hour, second pass: the second occurrence of the end',
      'Europe/Kyiv',
      '23:00',
      '03:30',
      '2026-10-25T01:10:00Z',
      '2026-10-25T01:30:00.000Z',
    ],
    [
      'autumn night keeps the wall-clock end',
      'Europe/Kyiv',
      '22:00',
      '07:30',
      '2026-10-24T19:00:00Z',
      '2026-10-25T05:30:00.000Z',
    ],
  ])('%s', (_name, timezone, start, end, now, expected) => {
    expect(endOf(now, { timezone, start, end })).toBe(expected);
  });

  it('an unknown zone behaves as UTC and is counted', () => {
    const counted = () =>
      MetricsRegistry.value('notifications_timezone_fallback_total', {}) ?? 0;
    const before = counted();
    expect(
      endOf('2026-06-10T23:00:00Z', {
        timezone: 'Not/AZone',
        start: '22:00',
        end: '07:30',
      }),
    ).toBe('2026-06-11T07:30:00.000Z');
    expect(counted()).toBe(before + 1);
  });

  // The oracle: the wall clock of the zone at an instant judged against the window, independent of the implementation.
  const insideAt = (t: Date, q: QuietHours): boolean => {
    const local = DateTime.fromJSDate(t, { zone: q.timezone });
    const minutes = local.hour * 60 + local.minute;
    const [sh, sm] = q.start!.split(':').map(Number);
    const [eh, em] = q.end!.split(':').map(Number);
    const start = sh * 60 + sm;
    const end = eh * 60 + em;
    return start > end
      ? minutes >= start || minutes < end
      : minutes >= start && minutes < end;
  };
  const holds = (now: Date, q: QuietHours): boolean => {
    const result = quietHoursEnd(now, q);
    if (!insideAt(now, q)) return result === null;
    return (
      result !== null &&
      result.getTime() > now.getTime() && // never earlier than now
      !insideAt(result, q) && // never inside the window
      insideAt(new Date(result.getTime() - 1_000), q) // the first instant outside it
    );
  };

  const hhmm = fc
    .tuple(fc.integer({ min: 0, max: 23 }), fc.constantFrom(0, 15, 30, 45))
    .map(
      ([h, m]) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
    );
  const YEAR_START = Date.parse('2026-01-01T00:00:00Z');
  const YEAR_S = 365 * 86_400;

  it('property: the result is never inside the window, never earlier than now and the first instant outside it', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          'Europe/Kyiv',
          'America/New_York',
          'Asia/Kolkata',
          'Pacific/Auckland',
          'UTC',
        ),
        hhmm,
        hhmm,
        fc.integer({ min: 0, max: YEAR_S }),
        (timezone, start, end, second) => {
          fc.pre(start !== end);
          return holds(new Date(YEAR_START + second * 1_000), {
            timezone,
            start,
            end,
          });
        },
      ),
      { numRuns: 2_000 },
    );
  });

  it('SC-012: a simulated full year in Kyiv, every 17 minutes, and both transition nights second by minute', () => {
    // its end falls in the skipped hour and in the repeated hour
    const q = { timezone: 'Europe/Kyiv', start: '23:00', end: '03:30' };
    const instants: number[] = [];
    for (let s = 0; s <= YEAR_S; s += 17 * 60)
      instants.push(YEAR_START + s * 1_000);
    for (const transition of ['2026-03-29T01:00:00Z', '2026-10-25T01:00:00Z'])
      for (let d = -7_300; d <= 7_300; d += 60)
        instants.push(Date.parse(transition) + d * 1_000);
    for (const ms of instants) expect(holds(new Date(ms), q)).toBe(true);
  });
});

/** Shared by the notification router and the scheduled-send path; pure, so a plain unit spec. */
describe('quietHoursEnd', () => {
  const kyiv = { timezone: 'Europe/Kyiv', start: '22:00', end: '07:30' };

  it('outside the window → send now', () => {
    expect(quietHoursEnd(new Date('2026-06-10T09:00:00Z'), kyiv)).toBeNull(); // 12:00 Kyiv
  });

  it('late evening → next morning, local wall clock', () => {
    // 23:30 Kyiv (UTC+3 in summer) → 07:30 Kyiv next day = 04:30Z
    expect(
      quietHoursEnd(new Date('2026-06-10T20:30:00Z'), kyiv)?.toISOString(),
    ).toBe('2026-06-11T04:30:00.000Z');
  });

  it('after midnight → same morning', () => {
    expect(
      quietHoursEnd(new Date('2026-06-11T00:00:00Z'), kyiv)?.toISOString(),
    ).toBe('2026-06-11T04:30:00.000Z'); // 03:00 Kyiv
  });

  it('DST change night keeps 07:30 on the wall clock', () => {
    // Night of 2026-10-25 Kyiv goes UTC+3 → UTC+2. 23:00 local on the 24th = 20:00Z; wake-up 07:30 local = 05:30Z.
    expect(
      quietHoursEnd(new Date('2026-10-24T20:00:00Z'), kyiv)?.toISOString(),
    ).toBe('2026-10-25T05:30:00.000Z');
  });

  it('same-day window and disabled / invalid settings', () => {
    const lunch = { timezone: 'UTC', start: '12:00', end: '13:00' };
    expect(
      quietHoursEnd(new Date('2026-06-10T12:15:00Z'), lunch)?.toISOString(),
    ).toBe('2026-06-10T13:00:00.000Z');
    expect(quietHoursEnd(new Date('2026-06-10T13:00:00Z'), lunch)).toBeNull();
    expect(
      quietHoursEnd(new Date('2026-06-10T23:00:00Z'), {
        timezone: 'UTC',
        start: null,
        end: null,
      }),
    ).toBeNull();
    expect(
      quietHoursEnd(new Date('2026-06-10T12:15:00Z'), {
        ...lunch,
        timezone: 'Not/AZone',
      })?.toISOString(),
    ).toBe('2026-06-10T13:00:00.000Z');
  });
});
