import fc from 'fast-check';
import {
  MAX_REVENUE_MINOR,
  RevenueLimitExceededError,
  SLOT_LIMIT,
  rankingKey,
  revenueOfKey,
  slotOf,
} from './ranking-key';
import { periodOf } from './periods';

const week = periodOf('week', new Date('2026-10-06T12:00:00Z'));
const month = periodOf('month', new Date('2026-10-06T12:00:00Z'));

describe('S40 AS-14: ranking key arithmetic', () => {
  it('S40 AS-14: higher revenue outranks any instant', () => {
    expect(rankingKey(101, SLOT_LIMIT - 1)).toBeGreaterThan(rankingKey(100, 0));
  });

  it('S40 AS-14: equal revenue, earlier instant ranks higher', () => {
    expect(rankingKey(100, 10)).toBeGreaterThan(rankingKey(100, 11));
  });

  it('S40 AS-14: equal revenue and same unit give equal keys', () => {
    expect(rankingKey(100, 10)).toBe(rankingKey(100, 10));
  });

  it.each([
    [0, 0],
    [0, SLOT_LIMIT - 1],
    [MAX_REVENUE_MINOR, 0],
    [MAX_REVENUE_MINOR, SLOT_LIMIT - 1],
    [1, 0],
    [8_589_934_000, 123_456],
  ])(
    'S40 AS-14: revenue %d at slot %d is recovered exactly',
    (revenue, slot) => {
      const key = rankingKey(revenue, slot);
      expect(Number.isSafeInteger(key)).toBe(true);
      expect(revenueOfKey(key)).toBe(revenue);
    },
  );

  it('S40 AS-14: the largest key is exact in a double', () => {
    expect(rankingKey(MAX_REVENUE_MINOR, 0)).toBe(2 ** 53 - 1);
  });

  it('S40 AS-14: revenue of 2^33 or more is refused', () => {
    expect(() => rankingKey(MAX_REVENUE_MINOR + 1, 0)).toThrow(
      RevenueLimitExceededError,
    );
    expect(() => rankingKey(-1, 0)).toThrow(RangeError);
    expect(() => rankingKey(1.5, 0)).toThrow(RangeError);
  });

  it('S40 AS-14: a slot outside [0, 2^20 - 1] is clamped', () => {
    expect(rankingKey(5, -10)).toBe(rankingKey(5, 0));
    expect(rankingKey(5, SLOT_LIMIT + 50)).toBe(rankingKey(5, SLOT_LIMIT - 1));
  });

  it.each([
    ['week start', week, week.start, 0],
    ['week end - 1 s', week, new Date(week.end.getTime() - 1_000), 604_799],
    ['week after end', week, new Date(week.end.getTime() + 5_000), 604_805],
    ['month start', month, month.start, 0],
    [
      'month end - 1 min',
      month,
      new Date(month.end.getTime() - 60_000),
      44_639,
    ],
    [
      'before start clamps to 0',
      week,
      new Date(week.start.getTime() - 9_000),
      0,
    ],
  ])('S40 AS-14: slot at %s', (_label, period, at, slot) => {
    expect(slotOf(period, at)).toBe(slot);
  });

  it('S40 AS-14: a week and a month always fit in 20 bits', () => {
    expect(604_800).toBeLessThan(SLOT_LIMIT);
    expect(44_640).toBeLessThan(SLOT_LIMIT);
  });

  it('S40 AS-14 (property): the order of two keys is the order of (revenue desc, slot asc)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: MAX_REVENUE_MINOR }),
        fc.integer({ min: 0, max: SLOT_LIMIT - 1 }),
        fc.integer({ min: 0, max: MAX_REVENUE_MINOR }),
        fc.integer({ min: 0, max: SLOT_LIMIT - 1 }),
        (r1, s1, r2, s2) => {
          const k1 = rankingKey(r1, s1);
          const k2 = rankingKey(r2, s2);
          const expected = r1 !== r2 ? Math.sign(r1 - r2) : Math.sign(s2 - s1);
          expect(Math.sign(k1 - k2)).toBe(expected);
        },
      ),
    );
  });
});
