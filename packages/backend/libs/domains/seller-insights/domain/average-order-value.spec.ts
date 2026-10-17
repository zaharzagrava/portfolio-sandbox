import { averageOrderValue } from './average-order-value';

describe('S40 AS-56: average order value', () => {
  it.each([
    [0, 0, 0],
    [9000, 3, 3000],
    [10, 4, 3],
    [10, 3, 3],
    [11, 3, 4],
  ])('S40 AS-56: %d over %d orders is %d', (revenue, orders, expected) => {
    expect(averageOrderValue(revenue, orders)).toBe(expected);
  });
});
