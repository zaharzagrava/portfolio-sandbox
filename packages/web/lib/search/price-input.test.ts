import { describe, expect, it } from 'vitest';
import { bandFields, bandLabel, minorToField, parsePriceInput, PRICE_MESSAGES } from './price-input';

describe('parsePriceInput', () => {
  it('W02 AS-16: major units become minor units', () => {
    expect(parsePriceInput('10', '500', 'USD')).toEqual({ ok: true, minPriceMinor: 1000, maxPriceMinor: 50000 });
  });

  it('W02 AS-16: up to two decimals are accepted and converted exactly', () => {
    expect(parsePriceInput('25.50', '99.9', 'USD')).toEqual({ ok: true, minPriceMinor: 2550, maxPriceMinor: 9990 });
    expect(parsePriceInput('0.07', '', 'USD')).toEqual({ ok: true, minPriceMinor: 7 });
    expect(parsePriceInput('19.99', '', 'USD')).toEqual({ ok: true, minPriceMinor: 1999 });
  });

  it('W02 AS-16: the response currency decides the minor unit', () => {
    expect(parsePriceInput('500', '', 'JPY')).toEqual({ ok: true, minPriceMinor: 500 });
    expect(parsePriceInput('1.5', '', 'KWD')).toEqual({ ok: true, minPriceMinor: 1500 });
  });

  it('W02 AS-16: an empty field removes that bound', () => {
    expect(parsePriceInput('', '', 'USD')).toEqual({ ok: true });
    expect(parsePriceInput('  ', '40', 'USD')).toEqual({ ok: true, maxPriceMinor: 4000 });
    expect(parsePriceInput('40', '', 'USD')).toEqual({ ok: true, minPriceMinor: 4000 });
  });

  it('W02 AS-16: a minimum above the maximum shows the range message and sends nothing', () => {
    expect(parsePriceInput('50', '10', 'USD')).toEqual({ ok: false, errors: { range: PRICE_MESSAGES.range } });
    expect(PRICE_MESSAGES.range).toBe("The minimum price can't be higher than the maximum.");
  });

  it('W02 AS-16: equal bounds are accepted', () => {
    expect(parsePriceInput('10', '10', 'USD')).toEqual({ ok: true, minPriceMinor: 1000, maxPriceMinor: 1000 });
  });

  it.each(['abc', '-5', '1e3', '1,5', '12.345', '.5', '5.', '$5', '1 0', '0x10', '+5'])('W02 AS-16: "%s" is rejected with the format message', (text) => {
    expect(parsePriceInput(text, '', 'USD')).toEqual({ ok: false, errors: { min: PRICE_MESSAGES.format } });
    expect(parsePriceInput('', text, 'USD')).toEqual({ ok: false, errors: { max: PRICE_MESSAGES.format } });
  });

  it('W02 AS-16: both fields can fail at once; the format message wins over the range message', () => {
    expect(parsePriceInput('x', 'y', 'USD')).toEqual({ ok: false, errors: { min: PRICE_MESSAGES.format, max: PRICE_MESSAGES.format } });
    expect(PRICE_MESSAGES.format).toBe('Enter a price like 25 or 25.50.');
  });

  it('W02 AS-16: decimals a currency cannot hold are rejected (JPY has no fraction)', () => {
    expect(parsePriceInput('5.50', '', 'JPY')).toEqual({ ok: false, errors: { min: PRICE_MESSAGES.format } });
  });

  it('W02 AS-16: absurdly long numbers are rejected rather than losing precision', () => {
    expect(parsePriceInput('9'.repeat(20), '', 'USD')).toEqual({ ok: false, errors: { min: PRICE_MESSAGES.format } });
  });

  it('W02 AS-16: a band fills both fields in major units', () => {
    expect(bandFields('under_25')).toEqual({ min: '', max: '25' });
    expect(bandFields('25_to_50')).toEqual({ min: '25', max: '50' });
    expect(bandFields('50_to_100')).toEqual({ min: '50', max: '100' });
    expect(bandFields('over_100')).toEqual({ min: '100', max: '' });
  });

  it('W02 AS-14: band labels follow the currency', () => {
    expect(bandLabel('under_25', 'USD')).toBe('Under $25');
    expect(bandLabel('25_to_50', 'USD')).toBe('$25 to $50');
    expect(bandLabel('over_100', 'USD')).toBe('Over $100');
    expect(bandLabel('50_to_100', 'EUR')).toBe('€50 to €100');
  });

  it('W02 AS-16: minor units are shown back as the text a shopper would type', () => {
    expect(minorToField(1000, 'USD')).toBe('10');
    expect(minorToField(2550, 'USD')).toBe('25.50');
    expect(minorToField(7, 'USD')).toBe('0.07');
    expect(minorToField(500, 'JPY')).toBe('500');
    expect(minorToField(undefined, 'USD')).toBe('');
  });
});
