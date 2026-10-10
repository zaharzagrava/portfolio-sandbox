import { assertValidCost, normalizeHttpCost } from './cost';
import { InvalidRateLimitCostError } from './rate-limit.errors';

describe('S50 cost', () => {
  it.each([1, 2, 5, 2_000_000])('S50 AS-07: %p is a valid cost', (cost) => {
    expect(() => assertValidCost(cost)).not.toThrow();
  });

  it.each([0, -1, 1.5, NaN, Infinity, -Infinity])(
    'S50 AS-07: %p throws InvalidRateLimitCostError',
    (cost) => {
      expect(() => assertValidCost(cost)).toThrow(InvalidRateLimitCostError);
    },
  );

  it.each([
    [0, 1],
    [-4, 1],
    [1, 1],
    [1.2, 2],
    [7, 7],
    [NaN, 1],
    [Infinity, 1],
    [-Infinity, 1],
    ['3', 1],
    [undefined, 1],
    [null, 1],
  ])('S50 AS-07: HTTP cost resolver value %p is used as %p', (value, used) => {
    expect(normalizeHttpCost(value)).toBe(used);
  });
});
