import type { PickupOpeningHours } from '@marketplace-sandbox/contracts';
import { describe, expect, it } from 'vitest';
import { formatDistance, openingStatus, openingText } from './format';

describe('distance text', () => {
  it.each([
    [850, '850 m'],
    [854, '850 m'],
    [856, '860 m'],
    [0, '0 m'],
    [5, '10 m'],
    [994, '990 m'],
    [995, '1.0 km'],
    [1000, '1.0 km'],
    [2400, '2.4 km'],
    [2449, '2.4 km'],
    [2450, '2.5 km'],
    [12345, '12.3 km'],
  ])('W02 AS-28: %i m is "%s"', (meters, text) => {
    expect(formatDistance(meters)).toBe(text);
  });

  it('W02 AS-28: a non-finite or negative distance is shown as 0 m', () => {
    expect(formatDistance(Number.NaN)).toBe('0 m');
    expect(formatDistance(-5)).toBe('0 m');
  });
});

const weekly: PickupOpeningHours = {
  timezone: 'Europe/Berlin',
  weekly: {
    mon: [{ open: '09:00', close: '18:00' }],
    tue: [{ open: '09:00', close: '12:00' }, { open: '14:00', close: '18:00' }],
    wed: [],
    thu: [{ open: '09:00', close: '18:00' }],
    sat: [{ open: '10:00', close: '14:00' }],
  },
};

// 2026-10-12 is a Monday. Berlin is UTC+2 on that date.
const at = (iso: string) => new Date(iso);

describe('opening status', () => {
  it('W02 AS-41: empty hours are unknown', () => {
    expect(openingStatus({}, at('2026-10-12T10:00:00Z'))).toEqual({ kind: 'unknown' });
    expect(openingText({ kind: 'unknown' })).toBe('Hours not provided');
  });

  it('W02 AS-41: inside an interval the point is open until it closes', () => {
    const status = openingStatus(weekly, at('2026-10-12T08:30:00Z')); // Mon 10:30 Berlin
    expect(status).toEqual({ kind: 'open', closesAt: '18:00' });
    expect(openingText(status)).toBe('Open now · closes 18:00');
  });

  it('W02 AS-41: the opening minute is open and the closing minute is closed', () => {
    expect(openingStatus(weekly, at('2026-10-12T07:00:00Z')).kind).toBe('open'); // 09:00
    expect(openingStatus(weekly, at('2026-10-12T16:00:00Z')).kind).toBe('closed'); // 18:00
  });

  it('W02 AS-41: closed shows the next opening later the same day', () => {
    const status = openingStatus(weekly, at('2026-10-13T10:30:00Z')); // Tue 12:30 Berlin, between intervals
    expect(status).toEqual({ kind: 'closed', opensAt: { day: 'Tue', time: '14:00' } });
    expect(openingText(status)).toBe('Closed · opens Tue 14:00');
  });

  it('W02 AS-41: closed shows the next opening on a later day, skipping empty days', () => {
    const status = openingStatus(weekly, at('2026-10-13T17:00:00Z')); // Tue 19:00 Berlin
    expect(status).toEqual({ kind: 'closed', opensAt: { day: 'Thu', time: '09:00' } });
  });

  it('W02 AS-41: the next opening can wrap into the next week', () => {
    const status = openingStatus(weekly, at('2026-10-17T13:00:00Z')); // Sat 15:00 Berlin, after the last interval
    expect(status).toEqual({ kind: 'closed', opensAt: { day: 'Mon', time: '09:00' } });
  });

  it('W02 AS-41: no interval at all in the week is plain "Closed"', () => {
    const none: PickupOpeningHours = { timezone: 'UTC', weekly: { mon: [], tue: [] } };
    const status = openingStatus(none, at('2026-10-12T10:00:00Z'));
    expect(status).toEqual({ kind: 'closed' });
    expect(openingText(status)).toBe('Closed');
  });

  it("W02 AS-41: the point's own time zone decides the weekday and the clock", () => {
    // 2026-10-12T03:00Z is Monday 05:00 in Berlin (closed, opens 09:00) but Sunday 23:00 in New York.
    expect(openingStatus(weekly, at('2026-10-12T03:00:00Z'))).toEqual({ kind: 'closed', opensAt: { day: 'Mon', time: '09:00' } });
    const newYork: PickupOpeningHours = { timezone: 'America/New_York', weekly: { sun: [{ open: '20:00', close: '23:30' }], mon: [{ open: '09:00', close: '17:00' }] } };
    expect(openingStatus(newYork, at('2026-10-12T03:00:00Z'))).toEqual({ kind: 'open', closesAt: '23:30' });
  });

  it('W02 AS-41: a daylight-saving change does not shift the clock reading', () => {
    // Berlin leaves summer time on 2026-10-25 (02:00 -> 01:00). 2026-10-26 08:30Z is Monday 09:30 CET (UTC+1).
    expect(openingStatus(weekly, at('2026-10-26T08:30:00Z'))).toEqual({ kind: 'open', closesAt: '18:00' });
  });

  it('W02 AS-41: an unknown time zone is treated as unknown hours rather than throwing', () => {
    expect(openingStatus({ timezone: 'Nowhere/City', weekly: { mon: [{ open: '09:00', close: '18:00' }] } }, at('2026-10-12T10:00:00Z'))).toEqual({ kind: 'unknown' });
  });

  it('W02 AS-41: malformed hours are unknown', () => {
    expect(openingStatus(null, new Date())).toEqual({ kind: 'unknown' });
    expect(openingStatus({ timezone: 'UTC' } as never, new Date())).toEqual({ kind: 'unknown' });
  });
});
