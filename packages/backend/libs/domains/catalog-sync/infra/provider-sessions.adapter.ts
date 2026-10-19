import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ApiConfigService, PlatformSettings } from '@app/common/config';
import { resolveCatalogSyncSettings } from '@app/common/config/catalog-sync-config';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { RateLimiterService } from '@app/infrastructure/rate-limit';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { resolvePublicAddress } from '@app/infrastructure/net/ssrf-guard';
import { SafeRequestError } from '@app/infrastructure/net';
import { currencyExponent } from '../domain/currency';
import {
  parseCredentials,
  serialiseCredentials,
  type StoredCredentials,
} from '../domain/credentials';
import { BREAKER_FAILURES, type BreakerState } from '../domain/breaker';
import { IntegrationAttentionRequired } from '../application/events/integration-events';
import type { ProviderName } from '../domain/normalise';
import {
  COMMERCE_PROVIDERS,
  CREDENTIAL_VAULT,
  INTEGRATION_REPOSITORY,
  ProviderCallError,
  type BreakerPersistence,
  type BreakerStep,
  type CommerceProvider,
  type CredentialVault,
  type IntegrationRecord,
  type IntegrationRepository,
  type ProviderAuth,
  type ProviderSession,
  type ProviderSessions,
  type RefreshLock,
  type StoreTarget,
  type SyncSession,
} from '../domain/ports';
import {
  allowedProviderHosts,
  PROVIDER_NETWORK,
  type ProviderNetwork,
} from './provider-network';
import {
  breakerOpenedCounter,
  provider429Counter,
  providerCallsCounter,
} from './provider-metrics';
import {
  InMemoryBreakerPersistence,
  ProviderHttp,
  RedisRefreshLock,
} from './provider-http';
import { ShopifyAdapter } from './shopify.adapter';
import { WooCommerceAdapter, wooBasicAuth } from './woocommerce.adapter';

/** Breaker kept on the `Integration` row (survives a Redis flush, visible in the status route). */
class IntegrationBreaker implements BreakerPersistence {
  constructor(
    private readonly integrations: IntegrationRepository,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
    private readonly integration: Pick<
      IntegrationRecord,
      'id' | 'shopId' | 'provider'
    >,
  ) {}

  async load(): Promise<BreakerState> {
    const state = await this.integrations.loadBreaker(this.integration.id);
    if (!state) throw new Error('integration not found');
    return state;
  }

  /**
   * The breaker columns change under a row lock; when the breaker opens for the first time the one
   * `integration_attention_required {breaker_open}` event joins the same transaction (AS-59).
   */
  update<T>(step: (current: BreakerState) => BreakerStep<T>): Promise<T> {
    return this.integrations
      .updateBreaker(
        this.integration.id,
        (current) => {
          const out = step(current);
          return {
            state: out.state,
            result: {
              value: out.result,
              opened: !!out.opened,
              attention: !!out.raiseAttention,
            },
          };
        },
        async (outcome) => {
          if (!outcome.attention) return;
          await this.outbox.append(
            IntegrationAttentionRequired.create(
              this.integration.id,
              0,
              {
                integrationId: this.integration.id,
                shopId: this.integration.shopId,
                reason: 'breaker_open',
                detail: `The store failed ${BREAKER_FAILURES} calls in a row; syncing pauses for 5 minutes.`,
              },
              this.clock.now(),
            ),
          );
        },
      )
      .then((outcome) => {
        if (outcome.opened)
          breakerOpenedCounter.add(1, { provider: this.integration.provider });
        return outcome.value;
      });
  }
}

/**
 * Production adapter of `ProviderSessions`: one `ProviderHttp` call stack per credential (shared Redis bucket, breaker
 * on the integration row, SSRF-safe HTTP). The only test seam is `PROVIDER_NETWORK`, bound to `{}` in production.
 */
@Injectable()
export class HttpProviderSessions implements ProviderSessions {
  private readonly logger = new Logger(HttpProviderSessions.name);
  private readonly shopify: ShopifyAdapter;
  private readonly woo = new WooCommerceAdapter();
  private readonly currency: string;
  private readonly network: ProviderNetwork;

  constructor(
    config: ApiConfigService,
    private readonly limiter: RateLimiterService,
    @Inject(INTEGRATION_REPOSITORY)
    private readonly integrations: IntegrationRepository,
    @Inject(CREDENTIAL_VAULT) private readonly vault: CredentialVault,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly outbox: OutboxService,
    private readonly redis: RedisService,
    @Optional() @Inject(PROVIDER_NETWORK) network?: ProviderNetwork,
  ) {
    const settings = resolveCatalogSyncSettings((k) => config.get(k));
    this.shopify = new ShopifyAdapter({
      appKey: settings.shopifyAppKey,
      appSecret: settings.shopifyAppSecret,
      apiVersion: settings.shopifyApiVersion,
      clock,
      allowedHosts: allowedProviderHosts(config),
    });
    this.currency = new PlatformSettings(config).currency;
    this.network = network ?? {};
    if (
      process.env.NODE_ENV === 'production' &&
      (this.network.unsafeTestNetwork ||
        this.network.originFor ||
        this.network.timeoutMs)
    )
      throw new Error('test network options are not allowed in production');
  }

  /** The adapters; `COMMERCE_PROVIDERS` is bound to this list. */
  get adapters(): CommerceProvider[] {
    return [this.shopify, this.woo];
  }

  provider(name: ProviderName): CommerceProvider {
    return name === 'shopify' ? this.shopify : this.woo;
  }

  forCredentials(input: {
    target: StoreTarget;
    credentialId: string;
    credentials: StoredCredentials | null;
  }): ProviderSession {
    return {
      call: this.stack(
        input.target,
        input.credentialId,
        this.staticAuth(input.credentials),
        new InMemoryBreakerPersistence(),
      ),
    };
  }

  /**
   * Opens the sealed credentials bound to this row. A value that does not open - copied from another integration, or
   * sealed under a key that is gone (AS-79) - is a credential that no longer works: `auth_failed`, so the caller
   * moves the integration to `NEEDS_REAUTH`, and no provider call is made. Only the ids are logged.
   */
  private openCredentials(
    row: Pick<IntegrationRecord, 'id' | 'shopId' | 'credentialsSealed'>,
  ): StoredCredentials {
    try {
      return parseCredentials(
        this.vault.open(row.id, row.credentialsSealed as string),
      );
    } catch {
      this.logger.warn({
        action: 'catalog-sync.credentials_unreadable',
        integrationId: row.id,
        shopId: row.shopId,
      });
      throw new ProviderCallError('auth_failed');
    }
  }

  forIntegration(integration: IntegrationRecord): SyncSession {
    if (!integration.credentialsSealed)
      throw new Error('integration has no credentials');
    const credentials = this.openCredentials(integration);
    const target: StoreTarget =
      integration.provider === 'shopify'
        ? { provider: 'shopify', shopDomain: integration.externalShop }
        : { provider: 'woocommerce', storeUrl: integration.externalShop };
    const auth =
      credentials.provider === 'shopify'
        ? this.refreshingShopifyAuth(integration, target)
        : this.staticAuth(credentials);
    return {
      call: this.stack(
        target,
        integration.id,
        auth,
        new IntegrationBreaker(
          this.integrations,
          this.outbox,
          this.clock,
          integration,
        ),
        credentials.provider === 'shopify'
          ? new RedisRefreshLock(this.redis)
          : undefined,
      ),
      integrationId: integration.id,
      normalise: {
        integrationId: integration.id,
        currency: this.currency,
        exponent: currencyExponent(this.currency),
      },
      ...(integration.locationId ? { locationId: integration.locationId } : {}),
    };
  }

  async isStoreAddressAllowed(storeUrl: string): Promise<boolean> {
    let host: string;
    try {
      host = new URL(storeUrl).hostname;
    } catch {
      return false;
    }
    try {
      await resolvePublicAddress(host, {
        resolver: this.network.resolver,
        allowPrivateHosts: this.network.unsafeTestNetwork?.allowPrivateHosts,
      });
      return true;
    } catch (error) {
      if (error instanceof SafeRequestError) return false;
      throw error;
    }
  }

  /** A credential that does not change during the call (connect-time checks, WooCommerce keys). */
  private staticAuth(
    credentials: StoredCredentials | null,
  ): ProviderAuth | undefined {
    if (credentials === null) return undefined;
    if (credentials.provider === 'woocommerce')
      return wooBasicAuth(credentials.consumerKey, credentials.consumerSecret);
    return {
      current: () =>
        Promise.resolve({
          headers: { 'x-shopify-access-token': credentials.accessToken },
          // A fingerprint of the token, never the token.
          tokenId: credentials.accessToken.slice(-6),
        }),
    };
  }

  /**
   * The Shopify credential of a stored integration. `current` reads the row each time, so a token refreshed by another
   * worker is picked up at once; `refresh` trades the refresh token for a new pair and stores it sealed (AS-60). It
   * answers `false` when there is no refresh token or the store refuses it: the caller then needs re-authorisation.
   */
  private refreshingShopifyAuth(
    integration: IntegrationRecord,
    target: StoreTarget,
  ): ProviderAuth {
    const read = async () => {
      const row = await this.integrations.findById(integration.id);
      if (!row?.credentialsSealed) throw new ProviderCallError('auth_failed');
      const credentials = this.openCredentials(row);
      if (credentials.provider !== 'shopify')
        throw new ProviderCallError('auth_failed');
      return credentials;
    };
    return {
      current: async () => {
        const c = await read();
        return {
          headers: { 'x-shopify-access-token': c.accessToken },
          tokenId: c.accessToken.slice(-6),
        };
      },
      refresh: async () => {
        const c = await read();
        if (!c.refreshToken) return false;
        // The token endpoint is called without a credential, on a stack of its own (its failures are not the sync's).
        const session: ProviderSession = {
          call: this.stack(
            target,
            integration.id,
            undefined,
            new InMemoryBreakerPersistence(),
          ),
        };
        const tokens = await this.shopify.refreshToken(session, {
          refreshToken: c.refreshToken,
        });
        if (!tokens) return false;
        const sealed = this.vault.seal(
          integration.id,
          serialiseCredentials({
            ...c,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken ?? c.refreshToken,
            scope: tokens.scope || c.scope,
            ...(tokens.expiresAt
              ? { expiresAt: tokens.expiresAt.toISOString() }
              : {}),
          }),
        );
        return this.integrations.updateCredentials(integration.id, sealed);
      },
    };
  }

  private stack(
    target: StoreTarget,
    credentialId: string,
    auth: ProviderAuth | undefined,
    breaker: BreakerPersistence,
    refreshLock?: RefreshLock,
  ): ProviderHttp {
    const real =
      target.provider === 'shopify'
        ? this.shopify.apiTarget(target.shopDomain)
        : this.woo.apiTarget(target.storeUrl);
    const origin = this.network.originFor?.(target) ?? real.origin;
    return new ProviderHttp({
      provider: target.provider,
      policy:
        target.provider === 'shopify'
          ? 'integrations.shopify'
          : 'integrations.woocommerce',
      credentialId,
      origin,
      apiPath: real.apiPath,
      limiter: this.limiter,
      breaker,
      auth,
      refreshLock,
      clock: this.clock,
      resolver: this.network.resolver,
      sleep: this.network.sleep,
      onCall: (event) => {
        providerCallsCounter.add(1, {
          provider: event.provider,
          status: String(event.outcome),
        });
        if (event.outcome === 429)
          provider429Counter.add(1, { provider: event.provider });
        this.network.onCall?.(event);
      },
      timeoutMs: this.network.timeoutMs,
      unsafeTestNetwork: this.network.unsafeTestNetwork,
    });
  }
}

export { COMMERCE_PROVIDERS };
