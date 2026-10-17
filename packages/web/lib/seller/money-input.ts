export type MoneyInputFailure = 'empty' | 'negative' | 'format' | 'too_many_decimals' | 'too_large';
export type MoneyInputResult = { ok: true; minor: number } | { ok: false; reason: MoneyInputFailure };

/**
 * A typed price in major units to integer minor units by string parsing (W04 FR-007, AS-35): digits, one optional decimal
 * mark (point or comma), at most `fractionDigits` decimals. No floating-point arithmetic touches the amount.
 */
export function parseMoneyInput(text: string, fractionDigits: number): MoneyInputResult {
  const value = text.trim();
  if (value === '') return { ok: false, reason: 'empty' };
  if (/^-\s*\d/.test(value)) return { ok: false, reason: 'negative' };
  const match = /^([0-9]+)(?:[.,]([0-9]+))?$/.exec(value);
  if (!match) return { ok: false, reason: 'format' };
  const whole = match[1] ?? '';
  const fraction = match[2] ?? '';
  if (fraction.length > fractionDigits) return { ok: false, reason: 'too_many_decimals' };
  const digits = (whole + fraction.padEnd(fractionDigits, '0')).replace(/^0+(?=\d)/, '');
  if (digits.length > 16) return { ok: false, reason: 'too_large' };
  const minor = Number(digits);
  if (!Number.isSafeInteger(minor)) return { ok: false, reason: 'too_large' };
  return { ok: true, minor };
}

/** Fraction digits of a currency (2 for EUR, 0 for JPY, 3 for KWD) from `Intl`; 2 when the code is unknown. */
export function fractionDigitsOf(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}
