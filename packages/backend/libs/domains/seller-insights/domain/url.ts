const TRACKING = /^(utm_[a-z]+|gclid|fbclid|msclkid|mc_[a-z]+|ref|ref_|_ga|yclid|igshid|spm|tag)$/i;

/**
 * Canonical form so `HTTPS://Shop.com:443/p/1?utm_source=x&b=2&a=1#reviews`
 * and `https://shop.com/p/1?a=1&b=2` are ONE crawl target (shared by every
 * shop watching it): lowercase host, default port dropped, fragment and
 * tracking params removed, remaining params sorted.
 */
export function normalizeUrl(raw: string): string {
  const url = new URL(raw.trim());
  url.hostname = url.hostname.toLowerCase();
  url.hash = '';
  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
  const params = [...url.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b));
  url.search = new URLSearchParams(params).toString();
  if (url.pathname !== '/' && url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1);
  return url.toString();
}
