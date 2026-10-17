import { describe, expect, it } from 'vitest';
import { fractionDigitsOf, parseMoneyInput } from './money-input';

describe('W04 AS-35 parseMoneyInput', () => {
  it.each([
    ['24.50', 2, 2450],
    ['24,50', 2, 2450],
    ['0.10', 2, 10],
    ['0,1', 2, 10],
    ['1,5', 2, 150],
    ['1.5', 2, 150],
    ['  19.99  ', 2, 1999],
    ['\t7\n', 2, 700],
    ['0', 2, 0],
    ['1.005', 3, 1005],
    ['500', 0, 500],
    ['12.345', 3, 12345],
    ['9007199254740.99', 2, 900719925474099],
  ])('accepts %j with %i fraction digits as %i minor units', (text, digits, minor) => {
    expect(parseMoneyInput(text, digits)).toEqual({ ok: true, minor });
  });

  it('never goes through floating point (19.99 * 100 is 1998.9999999999998)', () => {
    expect(19.99 * 100).not.toBe(1999);
    expect(parseMoneyInput('19.99', 2)).toEqual({ ok: true, minor: 1999 });
    expect(parseMoneyInput('1.15', 2)).toEqual({ ok: true, minor: 115 });
    expect(parseMoneyInput('0.07', 2)).toEqual({ ok: true, minor: 7 });
  });

  it.each([
    ['1.005', 2, 'too_many_decimals'],
    ['0.001', 2, 'too_many_decimals'],
    ['5.0', 0, 'too_many_decimals'],
    ['5,5', 0, 'too_many_decimals'],
    ['1.0005', 3, 'too_many_decimals'],
    ['-1', 2, 'negative'],
    ['-0,50', 2, 'negative'],
    ['', 2, 'empty'],
    ['   ', 2, 'empty'],
    ['abc', 2, 'format'],
    ['1.2.3', 2, 'format'],
    ['1,2,3', 2, 'format'],
    ['1,234.50', 2, 'format'],
    ['.5', 2, 'format'],
    ['5.', 2, 'format'],
    ['1e3', 2, 'format'],
    ['+5', 2, 'format'],
    ['١٢', 2, 'format'],
    ['9007199254740993', 2, 'too_large'],
    ['99999999999999999999', 0, 'too_large'],
  ])('refuses %j with %i fraction digits: %s', (text, digits, reason) => {
    expect(parseMoneyInput(text, digits)).toEqual({ ok: false, reason });
  });
});

describe('W04 AS-35 fractionDigitsOf', () => {
  it.each([
    ['EUR', 2],
    ['USD', 2],
    ['JPY', 0],
    ['KWD', 3],
  ])('%s has %i fraction digits', (currency, digits) => {
    expect(fractionDigitsOf(currency)).toBe(digits);
  });

  it('falls back to 2 for a code Intl rejects', () => {
    expect(fractionDigitsOf('??')).toBe(2);
  });
});
