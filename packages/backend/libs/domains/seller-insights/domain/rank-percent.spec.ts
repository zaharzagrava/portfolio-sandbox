import { topPercent } from './rank-percent';

describe('S40 AS-29: percentile', () => {
  it.each([
    [1, 1, 100],
    [1, 600_000, 1],
    [18_342, 600_000, 4],
    [2, 3, 67],
    [100, 101, 100],
    [600_000, 600_000, 100],
  ])('S40 AS-29: rank %d of %d is the top %d%%', (rank, of, expected) => {
    expect(topPercent(rank, of)).toBe(expected);
  });
});
