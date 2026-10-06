import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local - includes 169.254.169.254 (cloud metadata / IMDS)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

const v4ToInt = (ip: string) => ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;

function v4Blocked(ip: string): boolean {
  const n = v4ToInt(ip);
  return V4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (v4ToInt(base) & mask);
  });
}

function v6Blocked(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower); // IPv4-mapped: judge the embedded v4
  if (mapped) return v4Blocked(mapped[1]);
  const first = parseInt(lower.split(':')[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00 /* fc00::/7 unique local */ || (first & 0xffc0) === 0xfe80 /* fe80::/10 link-local */ || (first & 0xff00) === 0xff00 /* multicast */ || lower.startsWith('64:ff9b:');
}

export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !v4Blocked(ip);
  if (family === 6) return !v6Blocked(ip);
  return false;
}

export interface ResolvedTarget {
  url: URL;
  /** The validated address to CONNECT to (pinned - no second DNS lookup an attacker could rebind). */
  address: string;
  family: 4 | 6;
}

/**
 * SSRF guard for server-side requests to user-supplied URLs (webhooks, SD-35
 * crawler, integrations) - lesson 05/01 §6:
 *  - https only (plus explicitly allowed hosts in local/test),
 *  - resolve DNS ONCE, require EVERY returned address to be public
 *    (one private A record among public ones is enough to reject),
 *  - the caller connects to the returned `address` (pinned) - re-resolving at
 *    connect time is exactly what DNS rebinding exploits,
 *  - redirects are the caller's job: never follow them automatically.
 */
export async function resolvePublicTarget(rawUrl: string, options: { allowHttpHosts?: string[]; allowPrivateHosts?: string[] } = {}): Promise<ResolvedTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError('invalid URL');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.username || url.password) throw new SsrfBlockedError('credentials in URL are not allowed');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && options.allowHttpHosts?.includes(host))) throw new SsrfBlockedError('only https URLs are allowed');
  if (url.port && !['443', '8443'].includes(url.port) && !options.allowPrivateHosts?.includes(host)) throw new SsrfBlockedError(`port ${url.port} is not allowed`);

  const addresses = isIP(host) ? [{ address: host, family: isIP(host) as 4 | 6 }] : await lookup(host, { all: true, verbatim: true }).catch(() => []);
  if (addresses.length === 0) throw new SsrfBlockedError(`cannot resolve ${host}`);
  if (!options.allowPrivateHosts?.includes(host)) {
    const bad = addresses.find((a) => !isPublicAddress(a.address));
    if (bad) throw new SsrfBlockedError(`${host} resolves to a non-public address (${bad.address})`);
  }
  return { url, address: addresses[0].address, family: addresses[0].family as 4 | 6 };
}
