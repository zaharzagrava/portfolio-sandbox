import {
  bookingMonth,
  canTransition,
  isMonthAvailable,
  monthBounds,
  monthOf,
  nextMonth,
  parseMonth,
  previousMonth,
  type PeriodStatus,
} from './period';

describe('S16 AS-55 UTC month assignment', () => {
  it.each([
    ['2026-03-31T23:59:59.999Z', '2026-03'],
    ['2026-04-01T00:00:00.000Z', '2026-04'],
    ['2026-04-01T01:30:00+02:00', '2026-03'],
    ['2026-01-01T00:00:00-05:00', '2026-01'],
    ['2025-12-31T23:30:00-05:00', '2026-01'],
    ['2024-02-29T12:00:00Z', '2024-02'],
  ])('S16 AS-55: paidAt %s belongs to %s', (paidAt, month) => {
    expect(monthOf(new Date(paidAt))).toBe(month);
  });

  it('S16 AS-55: month bounds are half-open UTC instants', () => {
    const { start, end } = monthBounds('2026-03');
    expect(start.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(monthBounds('2026-12').end.toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });

  it.each([
    ['2026-03', true],
    ['2026-13', false],
    ['2026-00', false],
    ['2026-3', false],
    ['202603', false],
    ['2026-03-01', false],
    ['abc', false],
  ])('S16 AS-21: %s is a month: %s', (value, ok) => {
    expect(parseMonth(value) !== null).toBe(ok);
  });

  it('S16 AS-21: months outside 2020-01..current are not available', () => {
    const now = new Date('2026-04-15T10:00:00Z');
    expect(isMonthAvailable('2020-01', now)).toBe(true);
    expect(isMonthAvailable('2019-12', now)).toBe(false);
    expect(isMonthAvailable('2026-04', now)).toBe(true);
    expect(isMonthAvailable('2026-05', now)).toBe(false);
  });

  it('S16 AS-33: previous and next month cross the year', () => {
    expect(previousMonth('2026-01')).toBe('2025-12');
    expect(nextMonth('2025-12')).toBe('2026-01');
  });
});

describe('S16 AS-34 period transitions', () => {
  const states: PeriodStatus[] = ['OPEN', 'CLOSING', 'CLOSED'];
  const allowed = new Set(['OPEN>CLOSING', 'CLOSING>CLOSED', 'CLOSING>OPEN']);

  it.each(states.flatMap((from) => states.map((to) => [from, to] as const)))(
    'S16 AS-34: %s -> %s',
    (from, to) => {
      expect(canTransition(from, to)).toBe(allowed.has(`${from}>${to}`));
    },
  );
});

describe('S16 AS-49 booking month', () => {
  const none = new Map<string, PeriodStatus>();

  it.each([
    ['2026-04-30T23:59:59Z', '2026-04'],
    ['2026-05-01T00:00:00Z', '2026-05'],
    ['2026-12-31T23:59:59Z', '2026-12'],
  ])(
    'S16 AS-49: instant %s books in %s when that month is open',
    (at, month) => {
      expect(bookingMonth(new Date(at), none)).toBe(month);
    },
  );

  it.each<[PeriodStatus, string]>([
    ['CLOSING', '2026-05'],
    ['CLOSED', '2026-05'],
  ])(
    'S16 AS-49: a %s calendar month moves the booking to the earliest open month after it (%s)',
    (status, expected) => {
      const states = new Map<string, PeriodStatus>([['2026-04', status]]);
      expect(bookingMonth(new Date('2026-04-30T23:59:59Z'), states)).toBe(
        expected,
      );
    },
  );

  it('S16 AS-49: skips every month that is not open', () => {
    const states = new Map<string, PeriodStatus>([
      ['2026-04', 'CLOSED'],
      ['2026-05', 'CLOSING'],
      ['2026-06', 'CLOSED'],
    ]);
    expect(bookingMonth(new Date('2026-04-10T00:00:00Z'), states)).toBe(
      '2026-07',
    );
  });
});
