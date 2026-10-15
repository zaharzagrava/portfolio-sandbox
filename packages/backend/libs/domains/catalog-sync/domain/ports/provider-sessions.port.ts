import type { StoredCredentials } from '../credentials';
import type { ProviderName } from '../normalise';
import type {
  CommerceProvider,
  ProviderSession,
  SyncSession,
} from './commerce-provider.port';
import type { IntegrationRecord } from './records';

export const PROVIDER_SESSIONS = Symbol('PROVIDER_SESSIONS');

/** The store a credential belongs to: the Shopify shop domain or the validated WooCommerce store URL. */
export type StoreTarget =
  | { provider: 'shopify'; shopDomain: string }
  | { provider: 'woocommerce'; storeUrl: string };

/**
 * Builds provider call stacks (limiter -> breaker -> SSRF-safe HTTP) for the application layer, which must not import
 * `infra/` (D-6). One session = one credential.
 */
export interface ProviderSessions {
  provider(name: ProviderName): CommerceProvider;
  /** A credential that is not stored yet (OAuth exchange, API-key check). `credentials: null` = no authentication. */
  forCredentials(input: {
    target: StoreTarget;
    /** Bucket subject of the limiter: the id the integration will get. */
    credentialId: string;
    credentials: StoredCredentials | null;
  }): ProviderSession;
  /** The stored credential of an integration (opened with its own context), breaker kept on the row. */
  forIntegration(integration: IntegrationRecord): SyncSession;
  /**
   * Resolves the store's host now and applies the address rules (AS-07). `false` = not allowed (private, loopback,
   * link-local, unresolvable ...). Syntax is checked by `validateStoreUrl` first.
   */
  isStoreAddressAllowed(storeUrl: string): Promise<boolean>;
}
