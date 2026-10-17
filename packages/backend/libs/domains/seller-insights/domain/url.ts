export type UrlRefusal =
  'too_long' | 'invalid' | 'credentials' | 'scheme' | 'port';

export class UrlRefused extends Error {
  constructor(readonly reason: UrlRefusal) {
    super(`url refused: ${reason}`);
    this.name = 'UrlRefused';
  }
}

const MAX_URL_LENGTH = 2048;

const TRACKING =
  /^(utm_.*|gclid|gclsrc|dclid|fbclid|msclkid|yclid|igshid|mc_cid|mc_eid|_ga|_gl|ref|ref_|spm)$/i;

const upperEscapes = (s: string): string =>
  s.replace(/%[0-9a-fA-F]{2}/g, (m) => m.toUpperCase());

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Canonical form of a competitor page, the identity of a crawl target shared
 * by every shop watching it. Throws `UrlRefused` for anything we never crawl.
 * Idempotent: `normalizeUrl(normalizeUrl(x)) === normalizeUrl(x)`.
 */
export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length > MAX_URL_LENGTH) throw new UrlRefused('too_long');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new UrlRefused('invalid');
  }
  if (url.protocol !== 'https:') throw new UrlRefused('scheme');
  if (url.username || url.password) throw new UrlRefused('credentials');
  if (url.port && url.port !== '443') throw new UrlRefused('port');

  const path = upperEscapes(url.pathname).replace(/\/+$/, '') || '/';
  const pairs = upperEscapes(url.search)
    .slice(1)
    .split('&')
    .filter(Boolean)
    .map((p): [string, string | null] => {
      const i = p.indexOf('=');
      return i < 0 ? [p, null] : [p.slice(0, i), p.slice(i + 1)];
    })
    .filter(([name]) => !TRACKING.test(name))
    .sort(
      ([an, av], [bn, bv]) => compare(an, bn) || compare(av ?? '', bv ?? ''),
    )
    .map(([n, v]) => (v === null ? n : `${n}=${v}`));
  const query = pairs.length ? `?${pairs.join('&')}` : '';
  return `https://${url.host}${path}${query}`;
}
