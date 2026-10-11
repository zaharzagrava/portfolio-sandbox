import { describe, expect, it } from 'vitest';
import { formatMoney } from './utils';

describe('formatMoney', () => {
  it('W02 U-money: USD shows two fraction digits from integer cents', () => {
    expect(formatMoney(89999, 'USD')).toBe('$899.99');
    expect(formatMoney(5, 'USD')).toBe('$0.05');
  });

  it('W02 U-money: JPY has no fraction digits, so the minor amount is the whole amount', () => {
    expect(formatMoney(1500, 'JPY')).toBe('¥1,500');
  });

  it('W02 U-money: KWD has three fraction digits', () => {
    expect(formatMoney(12345, 'KWD').replace(/\s/g, ' ')).toBe('KWD 12.345');
  });

  it('W02 U-money: EUR with another locale formats with that locale', () => {
    expect(formatMoney(1999, 'EUR', 'de-DE').replace(/\s/g, ' ')).toBe('19,99 €');
  });

  it('W02 U-money: bigint amounts are accepted', () => {
    expect(formatMoney(BigInt(100000), 'USD')).toBe('$1,000.00');
  });

  it('W02 U-money: the currency is required by the type', () => {
    // @ts-expect-error currency is required
    expect(() => formatMoney(100)).toThrow();
  });
});
