/** IETF structured-field RateLimit headers (AS-82). Pure: no clock, no request. */
export interface HeaderItem {
  name: string;
  limit: number;
  windowMs: number;
  remaining: number;
  resetMs: number;
}

const quote = (name: string): string =>
  `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export const formatRetryAfter = (ms: number): string =>
  String(Math.max(1, Math.ceil(ms / 1000)));

export const formatRateLimitPolicy = (
  name: string,
  limit: number,
  windowMs: number,
): string => `${quote(name)};q=${limit};w=${Math.round(windowMs / 1000)}`;

export const formatRateLimit = (
  name: string,
  remaining: number,
  resetMs: number,
): string =>
  `${quote(name)};r=${Math.max(0, Math.floor(remaining))};t=${Math.max(0, Math.ceil(resetMs / 1000))}`;

export function headersFor(items: HeaderItem[]): Record<string, string> {
  if (!items.length) return {};
  return {
    'RateLimit-Policy': items
      .map((i) => formatRateLimitPolicy(i.name, i.limit, i.windowMs))
      .join(', '),
    RateLimit: items
      .map((i) => formatRateLimit(i.name, i.remaining, i.resetMs))
      .join(', '),
  };
}
