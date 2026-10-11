/** Price fields of the filter panel (W02 AS-16, FR-029): major units in, minor units out, validated before any request. */

export const PRICE_MESSAGES = {
  format: 'Enter a price like 25 or 25.50.',
  range: "The minimum price can't be higher than the maximum.",
} as const;

export type PriceInputResult =
  | { ok: true; minPriceMinor?: number; maxPriceMinor?: number }
  | { ok: false; errors: { min?: string; max?: string; range?: string } };

const FORMAT = /^(\d{1,12})(?:\.(\d{1,2}))?$/;

/** Fraction digits of a currency (JPY 0, USD 2, KWD 3). */
export function currencyDigits(currency: string): number {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** `undefined` for an empty field, `null` for an invalid one, otherwise the amount in minor units. */
function toMinor(text: string, digits: number): number | null | undefined {
  const value = text.trim();
  if (value === '') return undefined;
  const match = FORMAT.exec(value);
  if (!match) return null;
  const fraction = match[2] ?? '';
  if (fraction.length > digits) return null;
  const minor = Number(match[1]) * 10 ** digits + Number(fraction.padEnd(digits, '0') || '0');
  return Number.isSafeInteger(minor) ? minor : null;
}

export function parsePriceInput(minText: string, maxText: string, currency: string): PriceInputResult {
  const digits = currencyDigits(currency);
  const min = toMinor(minText, digits);
  const max = toMinor(maxText, digits);
  const errors: { min?: string; max?: string; range?: string } = {};
  if (min === null) errors.min = PRICE_MESSAGES.format;
  if (max === null) errors.max = PRICE_MESSAGES.format;
  if (min === null || max === null) return { ok: false, errors };
  if (min !== undefined && max !== undefined && min > max) return { ok: false, errors: { range: PRICE_MESSAGES.range } };
  return {
    ok: true,
    ...(min !== undefined ? { minPriceMinor: min } : {}),
    ...(max !== undefined ? { maxPriceMinor: max } : {}),
  };
}

/** The text a shopper would type for an amount in minor units ("25", "25.50"). */
export function minorToField(minor: number | undefined, currency: string): string {
  if (minor === undefined) return '';
  const digits = currencyDigits(currency);
  if (digits === 0) return String(minor);
  const whole = Math.floor(minor / 10 ** digits);
  const fraction = String(minor % 10 ** digits).padStart(digits, '0');
  const shown = fraction.length > 2 ? fraction.replace(/0+$/, '').padEnd(2, '0') : fraction;
  return /^0+$/.test(shown) ? String(whole) : `${whole}.${shown}`;
}

export type PriceBandKey = 'under_25' | '25_to_50' | '50_to_100' | 'over_100';

const BANDS: Record<PriceBandKey, { min?: number; max?: number }> = {
  under_25: { max: 25 },
  '25_to_50': { min: 25, max: 50 },
  '50_to_100': { min: 50, max: 100 },
  over_100: { min: 100 },
};

/** A band fills both fields (major units). */
export function bandFields(key: PriceBandKey): { min: string; max: string } {
  const band = BANDS[key];
  return { min: band.min === undefined ? '' : String(band.min), max: band.max === undefined ? '' : String(band.max) };
}

/** "Under $25", "$25 to $50", "Over $100" in the response currency. */
export function bandLabel(key: PriceBandKey, currency: string): string {
  const money = (amount: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);
  const band = BANDS[key];
  if (band.min === undefined) return `Under ${money(band.max!)}`;
  if (band.max === undefined) return `Over ${money(band.min)}`;
  return `${money(band.min)} to ${money(band.max)}`;
}
