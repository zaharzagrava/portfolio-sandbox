import {
  FUTURE_TOLERANCE_MS,
  STALE_AFTER_MS,
  classifyPoint,
  partitionPoints,
} from './location-window';

const NOW = 1_800_000_000_000;

describe('location time window', () => {
  it.each([
    ['exactly 300 000 ms in the past', -300_000, 'ok'],
    ['300 001 ms in the past', -300_001, 'stale'],
    ['exactly 10 000 ms ahead', 10_000, 'ok'],
    ['10 001 ms ahead', 10_001, 'future'],
    ['now', 0, 'ok'],
    ['an hour ago', -3_600_000, 'stale'],
    ['a day ahead', 86_400_000, 'future'],
  ] as const)('S20 AS-05: %s is %s', (_name, offset, expected) => {
    expect(classifyPoint(NOW + offset, NOW)).toBe(expected);
  });

  it('S20 AS-05: the limits are 5 minutes back and 10 seconds ahead', () => {
    expect(STALE_AFTER_MS).toBe(300_000);
    expect(FUTURE_TOLERANCE_MS).toBe(10_000);
  });

  it('S20 AS-05: a batch splits into accepted points and counted drops', () => {
    const points = [
      { ts: NOW - 300_000 },
      { ts: NOW + 10_000 },
      { ts: NOW - 300_001 },
      { ts: NOW + 10_001 },
      { ts: NOW + 10_002 },
    ];
    const { accepted, dropped } = partitionPoints(points, NOW);
    expect(accepted).toEqual([points[0], points[1]]);
    expect(dropped).toEqual({ stale: 1, future: 2 });
  });

  it('S20 AS-05: a batch of only dropped points accepts nothing', () => {
    const { accepted, dropped } = partitionPoints(
      [{ ts: NOW - 400_000 }, { ts: NOW + 20_000 }],
      NOW,
    );
    expect(accepted).toEqual([]);
    expect(dropped).toEqual({ stale: 1, future: 1 });
  });
});
