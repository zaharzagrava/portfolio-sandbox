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
