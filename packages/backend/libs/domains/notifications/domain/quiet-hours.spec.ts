import { quietHoursEnd } from './quiet-hours';

/** Shared by the notification router and the scheduled-send path; pure, so a plain unit spec. */
describe('quietHoursEnd', () => {
  const kyiv = { timezone: 'Europe/Kyiv', start: '22:00', end: '07:30' };

  it('outside the window → send now', () => {
    expect(quietHoursEnd(new Date('2026-06-10T09:00:00Z'), kyiv)).toBeNull(); // 12:00 Kyiv
  });

  it('late evening → next morning, local wall clock', () => {
    // 23:30 Kyiv (UTC+3 in summer) → 07:30 Kyiv next day = 04:30Z
    expect(quietHoursEnd(new Date('2026-06-10T20:30:00Z'), kyiv)?.toISOString()).toBe('2026-06-11T04:30:00.000Z');
  });

  it('after midnight → same morning', () => {
    expect(quietHoursEnd(new Date('2026-06-11T00:00:00Z'), kyiv)?.toISOString()).toBe('2026-06-11T04:30:00.000Z'); // 03:00 Kyiv
  });

  it('DST change night keeps 07:30 on the wall clock', () => {
    // Night of 2026-10-25 Kyiv goes UTC+3 → UTC+2. 23:00 local on the 24th = 20:00Z; wake-up 07:30 local = 05:30Z.
    expect(quietHoursEnd(new Date('2026-10-24T20:00:00Z'), kyiv)?.toISOString()).toBe('2026-10-25T05:30:00.000Z');
  });

  it('same-day window and disabled / invalid settings', () => {
    const lunch = { timezone: 'UTC', start: '12:00', end: '13:00' };
    expect(quietHoursEnd(new Date('2026-06-10T12:15:00Z'), lunch)?.toISOString()).toBe('2026-06-10T13:00:00.000Z');
    expect(quietHoursEnd(new Date('2026-06-10T13:00:00Z'), lunch)).toBeNull();
    expect(quietHoursEnd(new Date('2026-06-10T23:00:00Z'), { timezone: 'UTC', start: null, end: null })).toBeNull();
    expect(quietHoursEnd(new Date('2026-06-10T12:15:00Z'), { ...lunch, timezone: 'Not/AZone' })?.toISOString()).toBe('2026-06-10T13:00:00.000Z');
  });
});
