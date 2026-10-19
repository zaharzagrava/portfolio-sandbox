import { parseAllowedProviderHosts } from '../domain/store-address';
import type { HostResolver } from '@app/infrastructure/net/ssrf-guard';
import type { StoreTarget } from '../domain/ports';
import type { ProviderCallEvent, UnsafeTestNetwork } from './provider-http';

export const PROVIDER_NETWORK = Symbol('PROVIDER_NETWORK');

/**
 * Network seams of the provider call stack. Production wiring binds `{}`: real DNS, real HTTPS, port 443. Only test
 * wiring (an `overrideProvider(PROVIDER_NETWORK)`) fills the rest in: a stub resolver, the loopback escape hatch of
 * `safeRequest` and a map from a store to the HTTP fake that stands in for it. `ProviderHttp` and the session factory
 * both refuse these when `NODE_ENV=production`.
 */
export interface ProviderNetwork {
  resolver?: HostResolver;
  /** TEST ONLY. */
  unsafeTestNetwork?: UnsafeTestNetwork;
  /** TEST ONLY: origin (`http://127.0.0.1:port`) of the fake that stands in for this store; `undefined` = the real one. */
  originFor?: (target: StoreTarget) => string | undefined;
  /** Waits between retries (tests use virtual time). */
  sleep?: (ms: number) => Promise<void>;
  onCall?: (event: ProviderCallEvent) => void;
  /** TEST ONLY: per-attempt timeout shorter than the real 15 s, so a silent provider can be aborted in a test. */
  timeoutMs?: number;
}

/** The `host:port` list of `ALLOWED_PROVIDER_HOSTS` (empty outside the local profile). */
export function allowedProviderHosts(config: {
  get(key: 'allowed_provider_hosts'): string | undefined;
}): string[] {
  return parseAllowedProviderHosts(config.get('allowed_provider_hosts'));
}

/**
 * Local profile (J04, `ALLOWED_PROVIDER_HOSTS`): lets the call stack reach the listed `host:port` stand-ins over HTTPS (a
 * self-signed certificate is accepted for them). The listed host names are the only exception to the SSRF guard; which
 * port a store may use is decided by the store-domain check, which accepts exactly the listed `host:port`. Empty list =
 * production wiring (`{}`). The configuration refuses a non-empty list when `NODE_ENV=production`.
 */
export function providerNetworkFromAllowList(
  hostPorts: readonly string[],
): ProviderNetwork {
  const hosts = [
    ...new Set(hostPorts.map((entry) => entry.split(':')[0].toLowerCase())),
  ].filter(Boolean);
  if (hosts.length === 0) return {};
  return {
    unsafeTestNetwork: {
      allowPrivateHosts: hosts,
      allowSelfSignedHosts: hosts,
    },
  };
}
