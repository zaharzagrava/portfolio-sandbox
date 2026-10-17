import { checkoutConversion } from './conversion';

describe('S40 AS-40: checkout conversion', () => {
  it.each([
    [0, 0, null],
    [0, 3, null],
    [4, 1, 0.25],
    [3, 1, 0.333],
    [3, 2, 0.667],
    [1, 2, 2],
  ])(
    'S40 AS-40: %d checkouts and %d orders give %p',
    (checkouts, orders, expected) => {
      expect(checkoutConversion(checkouts, orders)).toBe(expected);
    },
  );
});
