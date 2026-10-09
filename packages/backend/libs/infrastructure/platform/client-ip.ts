import { BlockList, isIP } from 'node:net';

/** Parsed `trusted_proxies`: `none` trusts no forwarding header; otherwise a list of addresses and CIDR ranges. */
export type TrustedProxies = { none: true } | { none: false; list: BlockList };

/** `::ffff:1.2.3.4` is the same peer as `1.2.3.4`. */
function normalise(address: string): string | undefined {
  const trimmed = address.trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);
  const candidate = mapped ? mapped[1] : trimmed;
  return isIP(candidate) ? candidate : undefined;
}

export function parseTrustedProxies(value: string): TrustedProxies {
  const raw = value.trim();
  if (raw.toLowerCase() === 'none') return { none: true };
  const list = new BlockList();
  for (const entry of raw.split(',').map((e) => e.trim())) {
    const [address, prefix, extra] = entry.split('/');
    const normalised = address ? normalise(address) : undefined;
    if (!normalised || extra !== undefined)
      throw new Error(
        'trusted_proxies must be "none" or a comma-separated list of addresses and CIDR ranges',
      );
    const family = isIP(normalised) === 4 ? 'ipv4' : 'ipv6';
    if (prefix === undefined) {
      list.addAddress(normalised, family);
      continue;
    }
    const bits = Number(prefix);
    if (!/^\d+$/.test(prefix) || bits > (family === 'ipv4' ? 32 : 128))
      throw new Error('trusted_proxies has an invalid CIDR prefix');
    list.addSubnet(normalised, bits, family);
  }
  return { none: false, list };
}

const isTrusted = (proxies: TrustedProxies, address: string): boolean =>
  !proxies.none &&
  proxies.list.check(address, isIP(address) === 4 ? 'ipv4' : 'ipv6');

/**
 * The client address (FR-072): the TCP peer, unless the peer is a trusted proxy - then the first untrusted address
 * walking the `X-Forwarded-For` list from the right. A forged leftmost value is never believed; a malformed list
 * falls back to the peer.
 */
export function resolveClientIp({
  peer,
  forwardedFor,
  trustedProxies,
}: {
  peer: string;
  forwardedFor: string | string[] | undefined;
  trustedProxies: TrustedProxies;
}): string {
  const peerAddress = normalise(peer) ?? peer;
  if (
    trustedProxies.none ||
    !isTrusted(trustedProxies, peerAddress) ||
    forwardedFor === undefined
  )
    return peerAddress;

  const hops = (
    Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor
  )
    .split(',')
    .map(normalise);
  if (hops.some((hop) => hop === undefined)) return peerAddress;
  const addresses = hops as string[];
  for (let i = addresses.length - 1; i >= 0; i--) {
    if (!isTrusted(trustedProxies, addresses[i])) return addresses[i];
  }
  return addresses[0];
}
