/**
 * Money in notifications: events carry integer minor units next to an ISO 4217 code (constitution III.8); the text a
 * person reads shows the currency's own number of decimals in the recipient's locale (USD 2, JPY 0, KWD 3). The amount
 * is turned into a decimal string by moving the point, never by dividing a float, so no cent is lost or invented.
 */

/** Decimals of the currency's minor unit, from the runtime's currency data. */
export function currencyExponent(currency: string): number {
  return new Intl.NumberFormat('en', {
    style: 'currency',
    currency: assertCurrency(currency),
  }).resolvedOptions().maximumFractionDigits!;
}

function assertCurrency(currency: string): string {
  if (!/^[A-Za-z]{3}$/.test(currency))
    throw new Error(`"${currency}" is not a currency code`);
  return currency.toUpperCase();
}

/** `minor` as a plain decimal string with `exponent` decimals ("129900", 2 -> "1299.00"; "-5", 2 -> "-0.05"). */
function toDecimal(minor: bigint, exponent: number): string {
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor)
    .toString()
    .padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = digits.slice(digits.length - exponent);
  return `${negative ? '-' : ''}${whole}${exponent ? `.${fraction}` : ''}`;
}

function toMinorBigInt(minor: number | bigint | string): bigint {
  if (typeof minor === 'bigint') return minor;
  if (typeof minor === 'string') {
    if (!/^-?\d+$/.test(minor))
      throw new Error('an amount of minor units must be an integer');
    return BigInt(minor);
  }
  if (!Number.isSafeInteger(minor))
    throw new Error('an amount of minor units must be a safe integer');
  return BigInt(minor);
}

/** Minor units -> "$1,299.00" in the user's locale. Throws for anything that is not an integer amount. */
export function formatMoney(
  minor: number | bigint | string,
  currency: string,
  locale: string,
): string {
  const code = assertCurrency(currency);
  const amount = toMinorBigInt(minor);
  const decimal = toDecimal(amount, currencyExponent(code));
  // `format` takes a decimal string exactly (no float round trip).
  return new Intl.NumberFormat(locale || 'en', {
    style: 'currency',
    currency: code,
  }).format(decimal as unknown as number);
}
