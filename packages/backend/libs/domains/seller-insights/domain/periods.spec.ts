import {
  InvalidPeriodError,
  parsePeriod,
  periodOf,
  periodsOf,
} from './periods';

describe('S40 AS-07: UTC week and month of a paidAt', () => {
  it.each([
    [
      '2026-10-04T23:59:59Z',
      '2026-W40',
      '2026-10',
      '2026-09-28T00:00:00.000Z',
      '2026-10-05T00:00:00.000Z',
    ],
    [
      '2026-10-05T00:00:00Z',
      '2026-W41',
      '2026-10',
      '2026-10-05T00:00:00.000Z',
      '2026-10-12T00:00:00.000Z',
    ],
    [
      '2026-10-05T01:30:00+02:00',
      '2026-W40',
      '2026-10',
      '2026-09-28T00:00:00.000Z',
      '2026-10-05T00:00:00.000Z',
    ],
    [
      '2026-10-31T23:59:59Z',
      '2026-W44',
      '2026-10',
      '2026-10-26T00:00:00.000Z',
      '2026-11-02T00:00:00.000Z',
    ],
    [
      '2026-11-01T00:00:00Z',
      '2026-W44',
      '2026-11',
      '2026-10-26T00:00:00.000Z',
      '2026-11-02T00:00:00.000Z',
    ],
    [
      '2026-12-31T12:00:00Z',
      '2026-W53',
      '2026-12',
      '2026-12-28T00:00:00.000Z',
      '2027-01-04T00:00:00.000Z',
    ],
    [
      '2027-01-03T23:59:59Z',
      '2026-W53',
      '2027-01',
      '2026-12-28T00:00:00.000Z',
      '2027-01-04T00:00:00.000Z',
    ],
    [
      '2027-01-04T00:00:00Z',
      '2027-W01',
      '2027-01',
      '2027-01-04T00:00:00.000Z',
      '2027-01-11T00:00:00.000Z',
    ],
  ])(
    'S40 AS-07: %s is week %s and month %s',
    (paidAt, weekId, monthId, weekStart, weekEnd) => {
      const { week, month } = periodsOf(paidAt);
      expect(week.id).toBe(weekId);
      expect(week.kind).toBe('week');
      expect(week.start.toISOString()).toBe(weekStart);
      expect(week.end.toISOString()).toBe(weekEnd);
      expect(month.id).toBe(monthId);
      expect(month.kind).toBe('month');
      expect(month.start.getTime()).toBeLessThanOrEqual(
        new Date(paidAt).getTime(),
      );
      expect(month.end.getTime()).toBeGreaterThan(new Date(paidAt).getTime());
    },
  );

  it('S40 AS-07: the exclusive end of a month is the first instant of the next one', () => {
    const october = periodOf('month', new Date('2026-10-06T12:00:00Z'));
    expect(october.start.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(october.end.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(october.unitMs).toBe(60_000);
    expect(periodOf('week', new Date('2026-10-06T12:00:00Z')).unitMs).toBe(
      1_000,
    );
  });
});

describe('S40 AS-19: period ids', () => {
  it.each([
    ['week', '2026-W41', '2026-10-05T00:00:00.000Z'],
    ['week', '2026-W53', '2026-12-28T00:00:00.000Z'],
    ['month', '2026-02', '2026-02-01T00:00:00.000Z'],
  ] as const)('parses %s %s', (kind, id, start) => {
    const period = parsePeriod(kind, id, new Date('2026-10-06T12:00:00Z'));
    expect(period.id).toBe(id);
    expect(period.start.toISOString()).toBe(start);
  });

  it.each([
    ['week', '2026-W54'],
    ['week', '2027-W53'],
    ['week', '2026-W00'],
    ['week', '2026-W4'],
    ['week', '2026-10'],
    ['week', 'abc'],
    ['month', '2026-13'],
    ['month', '2026-00'],
    ['month', '2026-W40'],
    ['month', '2026-1'],
  ] as const)('refuses %s %s with a typed error', (kind, id) => {
    expect(() => parsePeriod(kind, id)).toThrow(InvalidPeriodError);
  });

  it('defaults to the current period', () => {
    expect(
      parsePeriod('week', undefined, new Date('2026-10-06T12:00:00Z')).id,
    ).toBe('2026-W41');
    expect(
      parsePeriod('month', undefined, new Date('2026-10-06T12:00:00Z')).id,
    ).toBe('2026-10');
  });
});
