import { nextRunAt, periodStartOf, validatePeriod } from './period';

const at = (iso: string) => new Date(iso);

describe('payout period (S15 AS-13)', () => {
  it.each([
    ['2026-10-07T10:00:00Z', '2026-10-05'],
    ['2026-10-04T23:59:59Z', '2026-09-28'],
    ['2026-10-05T00:00:00Z', '2026-10-05'],
    ['2026-10-05T00:00:00.001Z', '2026-10-05'],
    ['2026-11-01T12:00:00Z', '2026-10-26'], // Sunday, month end week
    ['2027-01-01T08:00:00Z', '2026-12-28'], // year end
    ['2028-02-29T12:00:00Z', '2028-02-28'], // leap day (a Tuesday)
    ['2028-03-01T00:00:00Z', '2028-02-28'],
  ])('S15 AS-13: %s belongs to the week of %s', (now, monday) => {
    expect(periodStartOf(at(now))).toBe(monday);
  });

  const now = at('2026-10-07T10:00:00Z');

  it('S15 AS-13: a Monday this week, last week and exactly 52 weeks back is accepted', () => {
    expect(validatePeriod('2026-10-05', now)).toEqual({
      ok: true,
      periodStart: '2026-10-05',
    });
    expect(validatePeriod('2026-09-28', now)).toEqual({
      ok: true,
      periodStart: '2026-09-28',
    });
    expect(validatePeriod('2025-10-06', now)).toEqual({
      ok: true,
      periodStart: '2025-10-06',
    });
  });

  it.each([
    ['not a Monday', '2026-10-06'],
    ['a future Monday', '2026-10-12'],
    ['53 weeks back', '2025-09-29'],
    ['malformed text', 'next-monday'],
    ['a calendar date that does not exist', '2026-02-30'],
    ['a non-Monday that does not exist as a date', '2026-13-01'],
    ['a timestamp', '2026-10-05T00:00:00Z'],
    ['an empty string', ''],
    ['a number', 20261005],
    ['null', null],
    ['an object', {}],
  ])('S15 AS-13: %s is refused', (_label, input) => {
    expect(validatePeriod(input, now)).toEqual({ ok: false });
  });

  it('S15 AS-13: on the Monday itself the current week is not yet future', () => {
    expect(validatePeriod('2026-10-05', at('2026-10-05T00:00:00Z'))).toEqual({
      ok: true,
      periodStart: '2026-10-05',
    });
    expect(validatePeriod('2026-10-12', at('2026-10-11T23:59:59Z'))).toEqual({
      ok: false,
    });
  });
});

describe('next run (S15 AS-35, AS-14)', () => {
  it('S15 AS-35: Wednesday 2026-10-07 10:00Z -> Monday 06:00 Warsaw (CEST) = 04:00Z', () => {
    expect(nextRunAt(at('2026-10-07T10:00:00Z')).toISOString()).toBe(
      '2026-10-12T04:00:00.000Z',
    );
  });

  it('S15 AS-14: before Monday 06:00 Warsaw the same day is next, at exactly 06:00 the following week', () => {
    expect(nextRunAt(at('2026-10-12T03:59:59Z')).toISOString()).toBe(
      '2026-10-12T04:00:00.000Z',
    );
    expect(nextRunAt(at('2026-10-12T04:00:00Z')).toISOString()).toBe(
      '2026-10-19T04:00:00.000Z',
    );
  });

  it('S15 AS-14: across the autumn change (2026-10-25) the UTC hour moves from 04 to 05', () => {
    expect(nextRunAt(at('2026-10-20T00:00:00Z')).toISOString()).toBe(
      '2026-10-26T05:00:00.000Z',
    );
    expect(nextRunAt(at('2026-10-19T04:00:01Z')).toISOString()).toBe(
      '2026-10-26T05:00:00.000Z',
    );
  });

  it('S15 AS-14: across the spring change (2027-03-28) the UTC hour moves from 05 to 04', () => {
    expect(nextRunAt(at('2027-03-22T05:00:00Z')).toISOString()).toBe(
      '2027-03-29T04:00:00.000Z',
    );
    expect(nextRunAt(at('2027-03-15T05:00:01Z')).toISOString()).toBe(
      '2027-03-22T05:00:00.000Z',
    );
  });
});
