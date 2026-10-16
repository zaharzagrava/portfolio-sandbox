import { checkSchedule, isDue } from './schedule-rules';

const NOW = new Date('2026-10-16T12:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const HORIZON = 365;

describe('S27 schedule rules', () => {
  it('S27 AS-40: one hour ahead is accepted', () => {
    const at = '2026-10-16T13:00:00.000Z';
    expect(checkSchedule(at, NOW, HORIZON)).toEqual({
      ok: true,
      at: new Date(at),
    });
  });

  it('S27 AS-40: an offset is honoured', () => {
    const parsed = checkSchedule('2026-10-16T15:00:00+02:00', NOW, HORIZON);
    expect(parsed).toEqual({ ok: true, at: new Date('2026-10-16T13:00:00Z') });
  });

  it.each([
    ['in the past', '2026-10-16T11:59:59.999Z'],
    ['equal to now', '2026-10-16T12:00:00.000Z'],
    ['a year ago', '2025-10-16T12:00:00.000Z'],
  ])('S27 AS-43: %s is schedule_in_past', (_name, at) => {
    expect(checkSchedule(at, NOW, HORIZON)).toEqual({
      ok: false,
      code: 'schedule_in_past',
    });
  });

  it('S27 AS-43: 365 days ahead is the last accepted time', () => {
    const edge = new Date(NOW.getTime() + 365 * DAY).toISOString();
    expect(checkSchedule(edge, NOW, HORIZON).ok).toBe(true);
    const over = new Date(NOW.getTime() + 365 * DAY + 1).toISOString();
    expect(checkSchedule(over, NOW, HORIZON)).toEqual({
      ok: false,
      code: 'schedule_too_far',
    });
  });

  it.each([
    ['no offset', '2026-10-17T12:00:00'],
    ['date only', '2026-10-17'],
    ['words', 'tomorrow'],
    ['empty', ''],
    ['month 13', '2026-13-17T12:00:00Z'],
  ])('S27 AS-43: %s is an invalid format', (_name, at) => {
    expect(checkSchedule(at, NOW, HORIZON)).toEqual({
      ok: false,
      code: 'invalid_format',
    });
  });

  it('S27 AS-41: a job is due at its time and not a millisecond before', () => {
    const at = new Date('2026-10-16T13:00:00.000Z');
    expect(isDue(at, new Date(at.getTime() - 1))).toBe(false);
    expect(isDue(at, at)).toBe(true);
    expect(isDue(at, new Date(at.getTime() + 5 * HOUR))).toBe(true);
  });

  it('S27 AS-41: no schedule is never due', () => {
    expect(isDue(null, NOW)).toBe(false);
  });
});
