import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { SafeRequestError } from './safe-request-error';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Injectable DNS resolver (tests); production uses the system resolver. */
export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemResolver: HostResolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((a) => ({
    address: a.address,
    family: a.family as 4 | 6,
  }));

const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local - includes 169.254.169.254 (cloud metadata / IMDS)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // deprecated 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

const v4ToInt = (ip: string) =>
  ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;

function v4Blocked(ip: string): boolean {
  const n = v4ToInt(ip);
  return V4_BLOCKED.some(([base, bits]) => {
    const mask = (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (v4ToInt(base) & mask);
  });
}

/** Eight 16-bit groups of an IPv6 address (handles `::` and an embedded dotted IPv4 tail), or undefined. */
function parseV6(ip: string): number[] | undefined {
  let text = ip.toLowerCase().split('%')[0];
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    if (isIP(tail[1]) !== 4) return undefined;
    const n = v4ToInt(tail[1]);
    text = `${text.slice(0, -tail[1].length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return undefined;
  const groups = [
    ...head,
    ...Array<string>(halves.length === 2 ? missing : 0).fill('0'),
    ...rest,
  ].map((g) => parseInt(g, 16));
  return groups.length === 8 &&
    groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff)
    ? groups
    : undefined;
}

const embeddedV4 = (hi: number, lo: number) =>
  `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

function v6Blocked(ip: string): boolean {
  const g = parseV6(ip);
  if (!g) return true; // unparseable: never trust
  const allZeroUpTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (allZeroUpTo(7) && g[7] <= 1) return true; // :: and ::1
  if (allZeroUpTo(5) && (g[5] === 0xffff || g[5] === 0))
    return g[5] === 0 || v4Blocked(embeddedV4(g[6], g[7])); // v4-mapped (judge the v4) / v4-compatible (always blocked)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0))
    return true; // NAT64: translating to an internal v4 is the classic bypass, so the whole prefix is refused
  if (g[0] === 0x2002) return v4Blocked(embeddedV4(g[1], g[2])); // 6to4: judge the embedded v4
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true; // documentation
  if (g[0] === 0x100 && g.slice(1, 4).every((x) => x === 0)) return true; // discard prefix
  return (
    (g[0] & 0xfe00) === 0xfc00 /* unique local */ ||
    (g[0] & 0xffc0) === 0xfe80 /* link-local */ ||
    (g[0] & 0xff00) === 0xff00
  ); /* multicast */
}

export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !v4Blocked(ip);
  if (family === 6) return !v6Blocked(ip);
  return false;
}

const isLocalName = (host: string) =>
  host === 'localhost' || host.endsWith('.localhost');

/**
 * Resolves `hostname` once and returns the address to connect to (pinned: the caller never resolves again, which is
 * what DNS rebinding exploits). Every returned address must be public, so one private A record among public ones is
 * enough to reject. Literal IPs (the URL parser has already normalised decimal, octal, hex and short forms) are
 * judged without a lookup; `localhost` names are refused by name.
 */
export async function resolvePublicAddress(
  hostname: string,
  {
    resolver = systemResolver,
    allowPrivateHosts,
  }: { resolver?: HostResolver; allowPrivateHosts?: string[] } = {},
): Promise<ResolvedAddress> {
  const host = hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '');
  const privateOk = !!allowPrivateHosts?.includes(host);

  if (!privateOk && isLocalName(host))
    throw new SafeRequestError('blocked_address');

  let addresses: ResolvedAddress[];
  const literal = isIP(host);
  if (literal) {
    addresses = [{ address: host, family: literal as 4 | 6 }];
  } else {
    try {
      addresses = await resolver(host);
    } catch {
      throw new SafeRequestError('unresolvable');
    }
  }
  if (addresses.length === 0) throw new SafeRequestError('unresolvable');
  if (!privateOk && addresses.some((a) => !isPublicAddress(a.address)))
    throw new SafeRequestError('blocked_address');
  return addresses[0];
}
