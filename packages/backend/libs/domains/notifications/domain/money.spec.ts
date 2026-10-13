import fc from 'fast-check';
import { currencyExponent, formatMoney } from './money';

/** Intl puts no-break and narrow spaces between a currency code and the number; compare on plain spaces. */
const SPACES = new RegExp(`[${String.fromCharCode(0xa0, 0x202f)}]`, 'g');
const plain = (s: string) => s.replace(SPACES, String.fromCharCode(32));

describe('S28 AS-81: money in minor units, per currency and recipient locale (pure)', () => {
  it.each([
    ['USD', 2],
    ['EUR', 2],
    ['JPY', 0],
    ['KWD', 3],
    ['usd', 2],
  ])('the exponent of %s is %i', (currency, exponent) => {
    expect(currencyExponent(currency)).toBe(exponent);
  });

  it.each([
    [129900, 'USD', 'en-US', '$1,299.00'],
    [1500, 'JPY', 'en-US', '¥1,500'],
    [1500, 'KWD', 'en-US', 'KWD 1.500'],
    [0, 'EUR', 'en-US', '€0.00'],
    [5, 'USD', 'en-US', '$0.05'],
    [-2550, 'USD', 'en-US', '-$25.50'],
  ])('%i %s in %s is %s', (minor, currency, locale, expected) => {
    expect(plain(formatMoney(minor, currency, locale))).toBe(expected);
  });

  it('the uk locale uses the uk currency format of the same amount', () => {
    const expected = new Intl.NumberFormat('uk', {
      style: 'currency',
      currency: 'USD',
    }).format(1299);
    expect(formatMoney(129900, 'USD', 'uk')).toBe(expected);
    expect(formatMoney(129900, 'USD', 'uk')).not.toBe(
      formatMoney(129900, 'USD', 'en-US'),
    );
  });

  it('accepts a bigint and a digit string of minor units', () => {
    expect(plain(formatMoney(129900n, 'USD', 'en-US'))).toBe('$1,299.00');
    expect(plain(formatMoney('129900', 'USD', 'en-US'))).toBe('$1,299.00');
  });

  it.each([
    ['a fraction', 12.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['an unsafe integer', Number.MAX_SAFE_INTEGER + 2],
    ['a non-digit string', '12.50'],
    ['an empty string', ''],
  ])('rejects %s', (_, value) => {
    expect(() => formatMoney(value as number, 'USD', 'en-US')).toThrow(
      /minor units/,
    );
  });

  it('rejects a currency code that is not three letters', () => {
    expect(() => formatMoney(100, 'DOLLARS', 'en-US')).toThrow();
    expect(() => formatMoney(100, '', 'en-US')).toThrow();
  });

  it('property: the amount is exact, never computed by floating-point division', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
        fc.constantFrom('USD', 'JPY', 'KWD'),
        (minor, currency) => {
          const digits = currencyExponent(currency);
          const text = formatMoney(minor, currency, 'en-US').replace(/\D/g, '');
          // Every digit of the minor amount appears in order (padded to the exponent), nothing rounded away.
          expect(text.replace(/^0+(?=\d)/, '')).toBe(
            String(minor)
              .padStart(digits + 1, '0')
              .replace(/^0+(?=\d)/, ''),
          );
        },
      ),
    );
  });
});
