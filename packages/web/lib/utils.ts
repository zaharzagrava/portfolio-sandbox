export { cn } from "cn";

/**
 * Format an amount in minor units (integers, never floats) as a currency string. The currency is required and decides
 * the number of fraction digits: JPY 0, USD 2, KWD 3 (W02 U-money).
 */
export function formatMoney(
  minor: number | bigint,
  currency: string,
  locale = "en-US",
): string {
  let formatter: Intl.NumberFormat;
  try {
    formatter = new Intl.NumberFormat(locale, { style: "currency", currency });
  } catch (error) {
    if (!(error instanceof RangeError)) throw error; // a missing currency is a programming error and stays loud
    // A currency code the browser rejects must not take the page down: show the amount with the code as sent.
    return `${currency} ${minor.toString()}`;
  }
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  if (typeof minor === "number" && !Number.isInteger(minor)) return formatter.format(minor / 10 ** digits);
  // Exact decimal text from the integer, so amounts near 2^53 keep their last digit (a float division would not).
  const big = BigInt(minor);
  const negative = big < BigInt(0);
  const padded = (negative ? -big : big).toString().padStart(digits + 1, "0");
  const decimal = digits === 0 ? padded : `${padded.slice(0, -digits)}.${padded.slice(-digits)}`;
  return formatter.format(`${negative ? "-" : ""}${decimal}` as unknown as number);
}

/**
 * Format a relative time string (e.g., "2 hours ago", "in 3 days").
 */
export function formatRelativeTime(date: Date | string): string {
  const now = new Date();
  const target = typeof date === "string" ? new Date(date) : date;
  const diffMs = target.getTime() - now.getTime();
  const diffSeconds = Math.round(diffMs / 1000);
  const diffMinutes = Math.round(diffSeconds / 60);
  const diffHours = Math.round(diffMinutes / 60);
  const diffDays = Math.round(diffHours / 24);

  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

  if (Math.abs(diffSeconds) < 60) return rtf.format(diffSeconds, "second");
  if (Math.abs(diffMinutes) < 60) return rtf.format(diffMinutes, "minute");
  if (Math.abs(diffHours) < 24) return rtf.format(diffHours, "hour");
  return rtf.format(diffDays, "day");
}

/**
 * Truncate a string to a maximum length, adding ellipsis.
 */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 1) + "…";
}
