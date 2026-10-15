/** ISO 4217 minor-unit exponent of the currencies whose exponent is not 2 (pure; used by the price parser). */
const ZERO_DECIMALS = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'ISK',
  'JPY',
  'KMF',
  'KRW',
  'PYG',
  'RWF',
  'UGX',
  'UYI',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
]);
const THREE_DECIMALS = new Set([
  'BHD',
  'IQD',
  'JOD',
  'KWD',
  'LYD',
  'OMR',
  'TND',
]);

export function currencyExponent(currency: string): number {
  const code = currency.toUpperCase();
  if (ZERO_DECIMALS.has(code)) return 0;
  if (THREE_DECIMALS.has(code)) return 3;
  return 2;
}
