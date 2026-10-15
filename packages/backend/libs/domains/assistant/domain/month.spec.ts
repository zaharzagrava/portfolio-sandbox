import { monthKey, monthResetsAt, retryAfterSeconds } from './month';

const at = (iso: string) => ({
  now: () => new Date(iso),
  nowMs: () => new Date(iso).getTime(),
});

describe('S46 AS-34: UTC month key and reset instant', () => {
  it.each([
    ['2026-10-31T23:59:59.000Z', '202610', '2026-11-01T00:00:00.000Z'],
    ['2026-11-01T00:00:00.000Z', '202611', '2026-12-01T00:00:00.000Z'],
    ['2026-12-31T23:59:59.999Z', '202612', '2027-01-01T00:00:00.000Z'],
    ['2027-01-01T00:00:00.000Z', '202701', '2027-02-01T00:00:00.000Z'],
    ['2028-02-29T12:00:00.000Z', '202802', '2028-03-01T00:00:00.000Z'],
    ['2027-02-28T23:59:59.000Z', '202702', '2027-03-01T00:00:00.000Z'],
    ['2026-01-15T08:30:00.000Z', '202601', '2026-02-01T00:00:00.000Z'],
    ['2026-06-30T23:00:00.000Z', '202606', '2026-07-01T00:00:00.000Z'],
    ['2026-10-31T23:30:00-05:00', '202611', '2026-12-01T00:00:00.000Z'], // 04:30Z next day: UTC, not local
  ])('S46 AS-34: %s -> %s resets %s', (instant, key, resets) => {
    const clock = at(instant);
    expect(monthKey(clock)).toBe(key);
    expect(monthResetsAt(clock).toISOString()).toBe(resets);
  });

  it('S46 AS-34: Retry-After is 1 one second before the boundary and never below 1', () => {
    expect(retryAfterSeconds(at('2026-10-31T23:59:59.000Z'))).toBe(1);
    expect(retryAfterSeconds(at('2026-10-31T23:59:59.999Z'))).toBe(1);
    expect(retryAfterSeconds(at('2026-10-31T23:59:00.000Z'))).toBe(60);
    expect(retryAfterSeconds(at('2026-10-31T00:00:00.000Z'))).toBe(86_400);
  });
});
