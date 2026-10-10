import { toBasket } from './basket';

const ids = (n: number) =>
  Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
const BOUNDS = { min: 2, max: 30 };

describe('order basket', () => {
  it.each([
    [1, 'too_small'],
    [2, null],
    [30, null],
    [31, 'too_large'],
  ])('S34 AS-33: %i distinct products → %s', (count, reason) => {
    const result = toBasket(ids(count), BOUNDS);
    if (reason === null) expect(result).toEqual({ ok: true, products: ids(count) });
    else expect(result).toEqual({ ok: false, reason });
  });

  it('S34 AS-33: repeated lines count once, and the basket is sorted', () => {
    const [a, b, c] = ids(3);
    expect(toBasket([c, a, a, b, c, c], BOUNDS)).toEqual({
      ok: true,
      products: [a, b, c],
    });
  });

  it('S34 AS-33: ten lines of one product are a basket of one', () => {
    const [a] = ids(1);
    expect(toBasket(Array(10).fill(a), BOUNDS)).toEqual({
      ok: false,
      reason: 'too_small',
    });
  });

  it('S34 AS-33: 35 lines with 30 distinct products are accepted', () => {
    const thirty = ids(30);
    expect(toBasket([...thirty, ...thirty.slice(0, 5)], BOUNDS)).toEqual({
      ok: true,
      products: thirty,
    });
  });
});
