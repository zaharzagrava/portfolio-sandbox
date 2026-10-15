import fc from 'fast-check';
import { formatMinor, parseMinor } from './money';

describe('S08 money parsing', () => {
  it.each([
    ['19.99', 1999],
    ['19', 1900],
    ['0.5', 50],
    ['0.50', 50],
    [' 12.99 ', 1299],
    ['1234567.89', 123456789],
    ['99999999999.99', 9999999999999],
  ])('S08 AS-15: %j -> %d minor units (2 decimals)', (input, minor) => {
    expect(parseMinor(input)).toEqual({ ok: true, minor });
  });

  it.each([
    '12.999',
    '-1',
    '1e3',
    '1E3',
    '1,99',
    '',
    '   ',
    'abc',
    '0',
    '0.00',
    '123456789012',
    '123456789012.00',
    '+5',
    '.5',
    '5.',
    '1_000',
    '0x10',
    'Infinity',
    'NaN',
  ])('S08 AS-15: %j is rejected with invalid_price', (input) => {
    expect(parseMinor(input)).toEqual({ ok: false, code: 'invalid_price' });
  });

  it.each([19.99, 19, 0, null, undefined, {}, [], true])(
    'S08 AS-15: non-string %j (JSON number etc.) is rejected with invalid_price',
    (input) => {
      expect(parseMinor(input)).toEqual({ ok: false, code: 'invalid_price' });
    },
  );

  it('S08 AS-15: the exponent of the currency decides (0 and 3 decimals)', () => {
    expect(parseMinor('1999', 0)).toEqual({ ok: true, minor: 1999 });
    expect(parseMinor('19.9', 0)).toEqual({ ok: false, code: 'invalid_price' });
    expect(parseMinor('1.500', 3)).toEqual({ ok: true, minor: 1500 });
    expect(parseMinor('1.5', 3)).toEqual({ ok: true, minor: 1500 });
    expect(parseMinor('1.5001', 3)).toEqual({
      ok: false,
      code: 'invalid_price',
    });
  });

  it('S08 AS-15: parse(format(n)) = n for every representable positive amount', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 9_999_999_999_999 }),
        fc.constantFrom(0, 2),
        (n, exponent) => {
          const value = exponent === 0 ? Math.min(n, 99_999_999_999) : n;
          expect(parseMinor(formatMinor(value, exponent), exponent)).toEqual({
            ok: true,
            minor: value,
          });
        },
      ),
    );
  });

  it('S08 AS-15: formatMinor renders fixed decimals', () => {
    expect(formatMinor(1999)).toBe('19.99');
    expect(formatMinor(5)).toBe('0.05');
    expect(formatMinor(1900)).toBe('19.00');
    expect(formatMinor(1999, 0)).toBe('1999');
    expect(formatMinor(1500, 3)).toBe('1.500');
  });

  it('S08 AS-15: every successful result is a safe positive integer', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const r = parseMinor(s);
        if (r.ok) {
          expect(Number.isSafeInteger(r.minor)).toBe(true);
          expect(r.minor).toBeGreaterThan(0);
        }
      }),
    );
  });
});
