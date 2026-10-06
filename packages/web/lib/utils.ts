export { cn } from "cn";

/**
 * Format cents (integer minor units) to a human-readable currency string.
 * All money in the system is stored as integer cents (BIGINT) — never floats.
 */
export function formatMoney(
  cents: number | bigint,
  currency = "USD",
  locale = "en-US",
): string {
  const amount = Number(cents) / 100;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
  }).format(amount);
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
