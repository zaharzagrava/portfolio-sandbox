import { shouldPublishProgress } from './export-progress';

describe('export progress throttle', () => {
  it.each([
    ['no previous event', 5_000, null, false, true],
    ['999 ms ago', 5_999, 5_000, false, false],
    ['exactly 1,000 ms ago', 6_000, 5_000, false, true],
    ['last batch', 5_001, 5_000, true, true],
    ['clock went backwards', 4_000, 5_000, false, true],
  ])('S12 AS-16: %s', (_name, now, last, isLast, expected) => {
    expect(shouldPublishProgress(now, last, isLast)).toBe(expected);
  });

  it('S12 AS-16: a frozen clock over 25 batches publishes exactly two events', () => {
    let last: number | null = null;
    let published = 0;
    for (let i = 1; i <= 25; i++) {
      if (shouldPublishProgress(1_000, last, i === 25)) {
        published++;
        last = 1_000;
      }
    }
    expect(published).toBe(2);
  });
});
