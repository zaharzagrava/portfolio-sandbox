import { addPeriod, utcDayNumber, utcDaysBetween } from './periods';

const iso = (d: Date) => d.toISOString();

describe('S17 AS-30: month-end and leap-day anchors, in UTC', () => {
  const chain = (
    start: string,
    interval: 'MONTH' | 'YEAR',
    anchor: number,
    n: number,
  ) => {
    const out: string[] = [];
    let at = new Date(start);
    for (let i = 0; i < n; i++) {
      at = addPeriod(at, interval, anchor);
      out.push(iso(at));
    }
    return out;
  };

  it('S17 AS-30: a monthly subscription started on Jan 31 keeps its anchor', () => {
    expect(chain('2026-01-31T09:00:00.000Z', 'MONTH', 31, 4)).toEqual([
      '2026-02-28T09:00:00.000Z',
      '2026-03-31T09:00:00.000Z',
      '2026-04-30T09:00:00.000Z',
      '2026-05-31T09:00:00.000Z',
    ]);
  });

  it('S17 AS-30: a yearly subscription started on Feb 29 lands on Feb 28 and returns to Feb 29', () => {
    expect(chain('2028-02-29T00:00:00.000Z', 'YEAR', 29, 4)).toEqual([
      '2029-02-28T00:00:00.000Z',
      '2030-02-28T00:00:00.000Z',
      '2031-02-28T00:00:00.000Z',
      '2032-02-29T00:00:00.000Z',
    ]);
  });

  it('S17 AS-30: December rolls into the next year and keeps the time of day', () => {
    expect(
      iso(addPeriod(new Date('2026-12-15T23:59:59.999Z'), 'MONTH', 15)),
    ).toBe('2027-01-15T23:59:59.999Z');
  });

  describe.each([
    'UTC',
    'America/Los_Angeles',
    'Asia/Kolkata',
    'Pacific/Auckland',
  ])('server time zone %s', (tz) => {
    const original = process.env.TZ;
    beforeAll(() => {
      process.env.TZ = tz;
    });
    afterAll(() => {
      process.env.TZ = original;
    });

    it('S17 AS-30: gives the same instants whatever the server time zone', () => {
      expect(chain('2026-01-31T09:00:00.000Z', 'MONTH', 31, 3)).toEqual([
        '2026-02-28T09:00:00.000Z',
        '2026-03-31T09:00:00.000Z',
        '2026-04-30T09:00:00.000Z',
      ]);
      expect(
        iso(addPeriod(new Date('2026-03-31T23:30:00.000Z'), 'MONTH', 31)),
      ).toBe('2026-04-30T23:30:00.000Z');
    });
  });

  it('S17 AS-30: day counts use UTC calendar dates, not 24-hour spans', () => {
    expect(
      utcDaysBetween(
        new Date('2026-04-01T12:00:00Z'),
        new Date('2026-05-01T12:00:00Z'),
      ),
    ).toBe(30);
    expect(
      utcDaysBetween(
        new Date('2026-04-30T23:59:59Z'),
        new Date('2026-05-01T00:00:00Z'),
      ),
    ).toBe(1);
    expect(utcDayNumber(new Date('1970-01-02T00:00:00Z'))).toBe(1);
  });
});
