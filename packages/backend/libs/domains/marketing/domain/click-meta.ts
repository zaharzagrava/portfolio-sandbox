const REFERER_MAX = 300;

/** Two upper-case letters, never Cloudflare's `XX` (unknown) or `T1` (Tor); anything else is "" (FR-061, G15). */
export function cleanCountry(raw: string | undefined): string {
  return raw !== undefined && /^[A-Z]{2}$/.test(raw) && raw !== 'XX' ? raw : '';
}

/** Origin (scheme, host, port) of the Referer, at most 300 characters; never path, query or credentials. */
export function refererOrigin(raw: string | undefined): string {
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    const origin = url.origin;
    return origin.length <= REFERER_MAX ? origin : '';
  } catch {
    return '';
  }
}
