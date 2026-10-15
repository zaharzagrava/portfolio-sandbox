import type { HostResolver } from '@app/infrastructure/net/ssrf-guard';

type Address = Awaited<ReturnType<HostResolver>>[number];

/** Addresses used across the SSRF cases (AS-07). */
export const PUBLIC_ADDRESS = '93.184.216.34';
export const PRIVATE_ADDRESSES = {
  loopback: '127.0.0.1',
  loopbackV6: '::1',
  private10: '10.0.0.5',
  private172: '172.16.0.9',
  private192: '192.168.1.10',
  linkLocalMetadata: '169.254.169.254',
  uniqueLocalV6: 'fd00::1',
} as const;

export interface StubResolver {
  /** Use as `resolver` in `safeRequest` options / adapters. */
  resolve: HostResolver;
  /** Hosts looked up so far, in order (one entry per call, so "once per hop" is observable). */
  readonly calls: string[];
  /** Maps `host` to addresses for every following lookup. */
  set(host: string, ...addresses: string[]): void;
  /** Answers `first` for the first lookup of `host`, then `then` (DNS rebinding public-then-private). */
  rebind(host: string, first: string, then: string): void;
  /** Makes lookups of `host` fail (NXDOMAIN). */
  fail(host: string): void;
  reset(): void;
}

const toAddress = (address: string): Address => ({
  address,
  family: address.includes(':') ? 6 : 4,
});

/**
 * Deterministic DNS for the SSRF tests: unknown hosts resolve to a public address (`PUBLIC_ADDRESS`), so a test only
 * declares the hostile ones. Never touches the network.
 */
export function createStubResolver(
  defaults: Record<string, string[]> = {},
): StubResolver {
  const table = new Map<string, string[]>(Object.entries(defaults));
  const sequences = new Map<string, string[][]>();
  const failing = new Set<string>();
  const calls: string[] = [];

  // eslint-disable-next-line @typescript-eslint/require-await -- resolver contract is async; throws must reject
  const resolve: HostResolver = async (hostname) => {
    const host = hostname.toLowerCase();
    calls.push(host);
    if (failing.has(host)) {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), {
        code: 'ENOTFOUND',
      });
    }
    const queued = sequences.get(host);
    if (queued?.length) {
      const next = queued.length > 1 ? queued.shift()! : queued[0];
      return next.map(toAddress);
    }
    return (table.get(host) ?? [PUBLIC_ADDRESS]).map(toAddress);
  };

  return {
    resolve,
    calls,
    set: (host, ...addresses) => {
      table.set(host.toLowerCase(), addresses);
      sequences.delete(host.toLowerCase());
    },
    rebind: (host, first, then) =>
      sequences.set(host.toLowerCase(), [[first], [then]]),
    fail: (host) => failing.add(host.toLowerCase()),
    reset: () => {
      table.clear();
      sequences.clear();
      failing.clear();
      calls.length = 0;
    },
  };
}
