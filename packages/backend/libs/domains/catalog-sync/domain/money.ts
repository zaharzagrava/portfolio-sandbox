/**
 * Decimal string -> integer minor units, without any floating-point step (AS-15, FR-022).
 * Only JSON strings are accepted: a JSON number may already have lost precision.
 */
export type MoneyResult =
  { ok: true; minor: number } | { ok: false; code: 'invalid_price' };

/** Whole part limit: 11 digits keeps `whole * 10^exponent + fraction` a safe integer for exponents up to 3. */
export const MAX_WHOLE_DIGITS = 11;

const INVALID: MoneyResult = { ok: false, code: 'invalid_price' };
const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

export function parseMinor(input: unknown, exponent = 2): MoneyResult {
  if (typeof input !== 'string') return INVALID;
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 3)
    return INVALID;
  const match = DECIMAL.exec(input.trim());
  if (!match) return INVALID;
  const whole = match[1];
  const fraction = match[2] ?? '';
  if (whole.length > MAX_WHOLE_DIGITS) return INVALID;
  if (fraction.length > exponent) return INVALID;
  const minor = Number(whole + fraction.padEnd(exponent, '0'));
  if (!Number.isSafeInteger(minor) || minor <= 0) return INVALID;
  return { ok: true, minor };
}

export function formatMinor(minor: number, exponent = 2): string {
  if (!Number.isSafeInteger(minor) || minor < 0)
    throw new RangeError('minor units must be a non-negative safe integer');
  if (exponent === 0) return String(minor);
  const digits = String(minor).padStart(exponent + 1, '0');
  return `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
}
