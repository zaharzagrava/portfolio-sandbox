import { isIP } from 'node:net';

/**
 * Syntactic part of the outbound-address guard (AS-07, FR-004). Pure: no DNS. The resolved-address part is
 * `isBlockedAddress`, applied by the safe HTTP layer on every call, redirect and `Link` target (DNS rebinding).
 */
export type StoreUrlResult =
  { ok: true; baseUrl: string } | { ok: false; code: 'invalid_store_url' };

const INVALID: StoreUrlResult = { ok: false, code: 'invalid_store_url' };
const MAX_URL = 2048;
const MAX_HOST = 253;
const MAX_LABEL = 63;

/** https only, port 443, no user-info, no IP literal (any notation), no `localhost`, a dotted public-looking name. */
export function validateStoreUrl(input: string): StoreUrlResult {
  if (typeof input !== 'string') return INVALID;
  const text = input.trim();
  if (text.length === 0 || text.length > MAX_URL) return INVALID;
  if (!/^https:\/\//i.test(text)) return INVALID;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return INVALID;
  }
  if (url.protocol !== 'https:') return INVALID;
  if (url.username !== '' || url.password !== '') return INVALID;
  if (url.port !== '' && url.port !== '443') return INVALID;

  const host = url.hostname.replace(/\.$/, '');
  if (host === '' || host.length > MAX_HOST) return INVALID;
  if (host.startsWith('[') || isIP(host) !== 0) return INVALID;
  if (host === 'localhost' || host.endsWith('.localhost')) return INVALID;
  const labels = host.split('.');
  if (labels.length < 2) return INVALID;
  if (labels.some((l) => l === '' || l.length > MAX_LABEL)) return INVALID;
  // `127.1`, `0x7f.1`, `2130706433` are numeric forms the URL parser already turned into IPv4; stay defensive.
  if (/^(0x[0-9a-f]+|\d+)$/i.test(labels[labels.length - 1])) return INVALID;

  const path = url.pathname.replace(/\/+$/, '');
  return { ok: true, baseUrl: `https://${host}${path}` };
}

/** The `host:port` list of the local-profile setting `ALLOWED_PROVIDER_HOSTS` (empty outside the local profile). */
export function parseAllowedProviderHosts(raw: unknown): string[] {
  return typeof raw === 'string'
    ? raw
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    : [];
}

export type ShopifyDomainResult =
  { ok: true; domain: string } | { ok: false; code: 'invalid_shop_domain' };

/** `^[a-z0-9][a-z0-9-]*\.myshopify\.com$`, <= 255, lower-cased; no scheme, port or path. */
export function validateShopifyDomain(
  input: string,
  allowedHosts: readonly string[] = [],
): ShopifyDomainResult {
  if (typeof input !== 'string')
    return { ok: false, code: 'invalid_shop_domain' };
  const domain = input.trim().toLowerCase();
  // J04 local profile: a listed `host:port` stands in for a myshopify.com store (never set in production).
  if (allowedHosts.some((h) => h.toLowerCase() === domain))
    return { ok: true, domain };
  if (
    domain.length > 255 ||
    !/^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/.test(domain)
  )
    return { ok: false, code: 'invalid_shop_domain' };
  return { ok: true, domain };
}

function blockedV4(o: readonly number[]): boolean {
  const [a, b, c] = o;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 || // multicast, reserved, broadcast
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function parseV4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return nums.some((n) => Number.isNaN(n) || n > 255) ? null : nums;
}

function parseV6(ip: string): number[] | null {
  let text = ip.split('%')[0];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const o = parseV4(v4[1]);
    if (!o) return null;
    text =
      text.slice(0, -v4[1].length) +
      `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' ? [] : halves[0].split(':');
  const tail =
    halves.length === 2 && halves[1] !== '' ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 0 : missing !== 0) return null;
  const groups = [
    ...head,
    ...Array<string>(halves.length === 2 ? missing : 0).fill('0'),
    ...tail,
  ];
  const nums = groups.map((g) =>
    /^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN,
  );
  return nums.length === 8 && !nums.some(Number.isNaN) ? nums : null;
}

const embeddedV4 = (hi: number, lo: number): number[] => [
  hi >> 8,
  hi & 255,
  lo >> 8,
  lo & 255,
];

/** `true` for anything that must never be called: non-public, special-use or unparseable addresses. */
export function isBlockedAddress(ip: string): boolean {
  if (typeof ip !== 'string') return true;
  const kind = isIP(ip);
  if (kind === 4) {
    const o = parseV4(ip);
    return o === null || blockedV4(o);
  }
  if (kind !== 6) return true;
  const g = parseV6(ip);
  if (g === null) return true;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff)
    return blockedV4(embeddedV4(g[6], g[7])); // ::ffff:a.b.c.d
  if (g.slice(0, 6).every((x) => x === 0))
    return blockedV4(embeddedV4(g[6], g[7])); // ::a.b.c.d (deprecated)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0))
    return blockedV4(embeddedV4(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return blockedV4(embeddedV4(g[1], g[2])); // 6to4
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // site-local
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique-local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return true; // discard
  return false;
}
