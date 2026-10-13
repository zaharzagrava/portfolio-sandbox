import { evaluateAnomaly } from './anomaly';

const T0 = Date.UTC(2026, 9, 13, 12, 0, 0);
const MIN = 60_000;
const votes = (n: number, spacingMs = 1000, start = T0) =>
  Array.from({ length: n }, (_, i) => start + i * spacingMs);

describe('S25 FR-053 vote anomaly signal', () => {
  it.each([
    ['9 zero-weight votes in the window', votes(9), T0 + 10_000, null, false],
    ['10 zero-weight votes in the window', votes(10), T0 + 10_000, null, true],
    ['15 zero-weight votes in the window', votes(15), T0 + 20_000, null, true],
    [
      '10 votes spread over 12 minutes (only 9 in the last 10)',
      votes(10, 80_000),
      T0 + 12 * MIN,
      null,
      false,
    ],
    [
      '10 votes inside exactly 10 minutes',
      votes(10, 60_000),
      T0 + 9 * MIN,
      null,
      true,
    ],
    [
      'signal sent 30 minutes ago',
      votes(10),
      T0 + 10_000,
      T0 - 30 * MIN,
      false,
    ],
    [
      'signal sent 59 minutes ago',
      votes(10),
      T0 + 10_000,
      T0 - 59 * MIN,
      false,
    ],
    [
      'signal sent exactly one hour ago',
      votes(10),
      T0 + 10_000,
      T0 + 10_000 - 60 * MIN,
      true,
    ],
    ['signal sent 2 hours ago', votes(10), T0 + 10_000, T0 - 120 * MIN, true],
  ])('S25 AS-48: %s', (_name, timestamps, now, lastSentAt, fire) => {
    expect(evaluateAnomaly({ timestamps, now, lastSentAt }).fire).toBe(fire);
  });

  it('S25 AS-48: reports how many zero-weight votes were inside the window', () => {
    const result = evaluateAnomaly({
      timestamps: [...votes(10), T0 - 20 * MIN],
      now: T0 + 10_000,
      lastSentAt: null,
    });
    expect(result).toMatchObject({ fire: true, count: 10, windowSeconds: 600 });
  });

  it('S25 AS-48: threshold and window are configurable', () => {
    expect(
      evaluateAnomaly({
        timestamps: votes(3),
        now: T0 + 5000,
        lastSentAt: null,
        threshold: 3,
      }).fire,
    ).toBe(true);
    expect(
      evaluateAnomaly({
        timestamps: votes(3, 20_000),
        now: T0 + 60_000,
        lastSentAt: null,
        threshold: 3,
        windowSeconds: 30,
      }).fire,
    ).toBe(false);
  });
});
