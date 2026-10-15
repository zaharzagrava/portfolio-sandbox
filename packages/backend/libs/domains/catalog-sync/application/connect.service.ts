import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type {
  Integration,
  WooConnectRequest,
} from '@marketplace-sandbox/contracts';
import { ApiConfigService, PlatformSettings } from '@app/common/config';
import { TransactionRunner } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { syncProblem } from '../domain/catalog-sync-errors';
import {
  serialiseCredentials,
  type StoredCredentials,
} from '../domain/credentials';
import type { ProviderName } from '../domain/normalise';
import { validateStoreUrl } from '../domain/store-address';
import {
  CREDENTIAL_VAULT,
  CURSOR_REPOSITORY,
  INTEGRATION_BACKFILL_QUEUE,
  INTEGRATION_REPOSITORY,
  PROVIDER_SESSIONS,
  ProviderCallError,
  SYNC_CLOCK,
  SYNC_QUEUE,
  type Clock,
  type ConnectionFacts,
  type CredentialVault,
  type CursorRepository,
  type IntegrationRecord,
  type IntegrationRepository,
  type ProviderSessions,
  type StoreTarget,
  type SyncQueue,
} from '../domain/ports';
import {
  IntegrationConnected,
  IntegrationStatusChanged,
} from './events/integration-events';
import {
  IntegrationViewService,
  PRODUCT_ENTITY,
} from './integration-view.service';

/** At most this many non-DISCONNECTED integrations per shop (FR-006). */
export const MAX_INTEGRATIONS_PER_SHOP = 5;

export type ShopifyConnectError =
  | 'oauth_exchange_failed'
  | 'currency_mismatch'
  | 'store_already_connected'
  | 'integration_limit_reached';

export type ShopifyConnectResult =
  | { kind: 'connected'; integrationId: string }
  | { kind: 'error'; error: ShopifyConnectError };

type Persisted =
  | { kind: 'ok'; integration: IntegrationRecord; created: boolean }
  | { kind: 'store_already_connected' }
  | { kind: 'limit_reached' }
  | { kind: 'webhooks_failed' };

/**
 * Connects a store (FR-001, FR-002, FR-004 - FR-006, AS-03, AS-06 - AS-11). No provider call is made inside a database
 * transaction (FR-091): the credential is verified and the webhooks are registered first, then one transaction writes the
 * row, its history and the event, then the first backfill is queued.
 */
@Injectable()
export class ConnectService {
  private readonly logger = new Logger(ConnectService.name);
  private readonly platformCurrency: string;

  constructor(
    private readonly config: ApiConfigService,
    private readonly transactions: TransactionRunner,
    private readonly outbox: OutboxService,
    private readonly view: IntegrationViewService,
    @Inject(INTEGRATION_REPOSITORY)
    private readonly integrations: IntegrationRepository,
    @Inject(CURSOR_REPOSITORY) private readonly cursors: CursorRepository,
    @Inject(CREDENTIAL_VAULT) private readonly vault: CredentialVault,
    @Inject(PROVIDER_SESSIONS) private readonly sessions: ProviderSessions,
    @Inject(SYNC_QUEUE) private readonly queue: SyncQueue,
    @Inject(SYNC_CLOCK) private readonly clock: Clock,
  ) {
    this.platformCurrency = new PlatformSettings(config).currency;
  }

  // ---- Shopify (the OAuth callback hands over a one-time code) ---------------------------------------------------------

  async completeShopify(input: {
    shopId: string;
    userId: string;
    shopDomain: string;
    code: string;
  }): Promise<ShopifyConnectResult> {
    const fail = (error: ShopifyConnectError): ShopifyConnectResult => ({
      kind: 'error',
      error,
    });
    const provider = this.sessions.provider('shopify');
    const target: StoreTarget = {
      provider: 'shopify',
      shopDomain: input.shopDomain,
    };
    const existing = await this.integrations.findByShopAndStore(
      input.shopId,
      'shopify',
      input.shopDomain,
    );
    const integrationId = existing?.id ?? uuidv7();

    let credentials: StoredCredentials;
    let facts: ConnectionFacts;
    try {
      const exchange = this.sessions.forCredentials({
        target,
        credentialId: integrationId,
        credentials: null,
      });
      const tokens = await provider.exchangeCode!(exchange, {
        shopDomain: input.shopDomain,
        code: input.code,
      });
      credentials = {
        provider: 'shopify',
        accessToken: tokens.accessToken,
        scope: tokens.scope,
        ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
        ...(tokens.expiresAt
          ? { expiresAt: tokens.expiresAt.toISOString() }
          : {}),
      };
      const checked = this.sessions.forCredentials({
        target,
        credentialId: integrationId,
        credentials,
      });
      facts = await provider.verifyCredentials(checked);
    } catch (error) {
      if (!(error instanceof ProviderCallError)) throw error;
      this.logger.warn({
        action: 'catalog-sync.connect_refused',
        integrationId,
        shopId: input.shopId,
        provider: 'shopify',
        reason: error.kind,
      });
      return fail('oauth_exchange_failed');
    }
    // The token is not stored or used again unless the store passes every rule below (AS-08).
    if (facts.currency !== this.platformCurrency)
      return fail('currency_mismatch');

    const outcome = await this.establish({
      shopId: input.shopId,
      userId: input.userId,
      provider: 'shopify',
      externalShop: input.shopDomain,
      credentials,
      facts,
      existing,
      integrationId,
    });
    switch (outcome.kind) {
      case 'ok':
        return { kind: 'connected', integrationId: outcome.integration.id };
      case 'store_already_connected':
        return fail('store_already_connected');
      case 'limit_reached':
        return fail('integration_limit_reached');
      case 'webhooks_failed':
        return fail('oauth_exchange_failed');
    }
  }

  // ---- WooCommerce (API keys) -------------------------------------------------------------------------------------------

  async connectWoo(
    shopId: string,
    userId: string,
    body: WooConnectRequest,
  ): Promise<{ integration: Integration; created: boolean }> {
    const url = validateStoreUrl(body.storeUrl);
    if (!url.ok) throw syncProblem('invalid_store_url');
    if (!(await this.sessions.isStoreAddressAllowed(url.baseUrl)))
      throw syncProblem('invalid_store_url');

    const target: StoreTarget = {
      provider: 'woocommerce',
      storeUrl: url.baseUrl,
    };
    const existing = await this.integrations.findByShopAndStore(
      shopId,
      'woocommerce',
      url.baseUrl,
    );
    const integrationId = existing?.id ?? uuidv7();
    const credentials: StoredCredentials = {
      provider: 'woocommerce',
      consumerKey: body.consumerKey,
      consumerSecret: body.consumerSecret,
      webhookSecret: randomBytes(32).toString('hex'),
    };

    let facts: ConnectionFacts;
    try {
      const session = this.sessions.forCredentials({
        target,
        credentialId: integrationId,
        credentials,
      });
      facts = await this.sessions
        .provider('woocommerce')
        .verifyCredentials(session);
    } catch (error) {
      throw this.wooFailure(error);
    }
    if (facts.currency !== this.platformCurrency)
      throw syncProblem('currency_mismatch');

    const outcome = await this.establish({
      shopId,
      userId,
      provider: 'woocommerce',
      externalShop: url.baseUrl,
      credentials,
      facts,
      existing,
      integrationId,
    });
    switch (outcome.kind) {
      case 'ok':
        return {
          integration: await this.view.toDto(outcome.integration),
          created: outcome.created,
        };
      case 'store_already_connected':
        throw syncProblem('store_already_connected');
      case 'limit_reached':
        throw syncProblem('integration_limit_reached');
      case 'webhooks_failed':
        throw syncProblem('provider_unavailable');
    }
  }

  private wooFailure(error: unknown): Error {
    if (!(error instanceof ProviderCallError)) return error as Error;
    switch (error.kind) {
      case 'blocked_address':
      case 'gone':
        return syncProblem('invalid_store_url');
      case 'auth_failed':
      case 'forbidden':
      case 'rejected':
        return syncProblem('provider_credentials_rejected');
      case 'rate_limiter_unavailable':
      case 'paused':
      case 'rate_limited':
      case 'breaker_open':
      case 'unavailable':
      case 'timeout':
      case 'network':
      case 'schema_invalid':
        return syncProblem('provider_unavailable');
    }
  }

  // ---- shared -----------------------------------------------------------------------------------------------------------

  private async establish(a: {
    shopId: string;
    userId: string;
    provider: ProviderName;
    externalShop: string;
    credentials: StoredCredentials;
    facts: ConnectionFacts;
    existing: IntegrationRecord | null;
    integrationId: string;
  }): Promise<Persisted> {
    const { existing, integrationId } = a;
    const counted = existing !== null && existing.status !== 'DISCONNECTED';

    // Cheap early refusals so a refused connect leaves nothing at the provider; the store enforces both again below.
    const holder = await this.integrations.findLiveByStore(
      a.provider,
      a.externalShop,
    );
    if (holder && holder.shopId !== a.shopId)
      return { kind: 'store_already_connected' };
    if (
      !counted &&
      (await this.integrations.countActiveForShop(a.shopId)) >=
        MAX_INTEGRATIONS_PER_SHOP
    )
      return { kind: 'limit_reached' };

    // Webhooks first (needs no row, only the id): a failure here stores nothing.
    const target: StoreTarget =
      a.provider === 'shopify'
        ? { provider: 'shopify', shopDomain: a.externalShop }
        : { provider: 'woocommerce', storeUrl: a.externalShop };
    const session = this.sessions.forCredentials({
      target,
      credentialId: integrationId,
      credentials: a.credentials,
    });
    let registered;
    try {
      registered = await this.sessions
        .provider(a.provider)
        .registerWebhooks(session, {
          callbackUrl: `${this.config.get('backend_host').replace(/\/+$/, '')}/api/integrations/${integrationId}/webhooks`,
          ...(a.credentials.provider === 'woocommerce'
            ? { secret: a.credentials.webhookSecret }
            : {}),
        });
    } catch (error) {
      if (!(error instanceof ProviderCallError)) throw error;
      this.logger.warn({
        action: 'catalog-sync.webhook_registration_refused',
        integrationId,
        shopId: a.shopId,
        provider: a.provider,
        reason: error.kind,
      });
      return { kind: 'webhooks_failed' };
    }

    const now = this.clock.now();
    const sealed = this.vault.seal(
      integrationId,
      serialiseCredentials(a.credentials),
    );
    let persisted: Persisted;
    try {
      persisted = await this.transactions.run(async () => {
        if (!existing) {
          const inserted = await this.integrations.insertConnected({
            id: integrationId,
            shopId: a.shopId,
            provider: a.provider,
            externalShop: a.externalShop,
            credentialsSealed: sealed,
            locationId: a.facts.locationId,
            connectedBy: a.userId,
            now,
            maxPerShop: MAX_INTEGRATIONS_PER_SHOP,
          });
          if (inserted.kind === 'store_already_connected')
            return { kind: 'store_already_connected' } as const;
          if (inserted.kind === 'limit_reached')
            return { kind: 'limit_reached' } as const;
          await this.outbox.append(
            IntegrationConnected.create(
              integrationId,
              0,
              {
                integrationId,
                shopId: a.shopId,
                provider: a.provider,
                externalShop: a.externalShop,
                connectedBy: a.userId,
              },
              now,
            ),
          );
          return {
            kind: 'ok',
            integration: inserted.integration,
            created: true,
          } as const;
        }

        if (existing.status === 'ACTIVE') {
          // A repeat connect of a live store: new credentials, nothing else changes (AS-06).
          await this.integrations.updateCredentials(integrationId, sealed);
          const current = await this.integrations.findById(integrationId);
          return {
            kind: 'ok',
            integration: current ?? existing,
            created: false,
          } as const;
        }

        if (existing.status === 'DISCONNECTED') {
          await this.integrations.lockShopLimit(a.shopId);
          if (
            (await this.integrations.countActiveForShop(a.shopId)) >=
            MAX_INTEGRATIONS_PER_SHOP
          )
            return { kind: 'limit_reached' } as const;
        }
        const moved = await this.integrations.transition(
          integrationId,
          existing.status,
          'ACTIVE',
          {
            reason: 'reconnect',
            actorId: a.userId,
            now,
            credentialsSealed: sealed,
            locationId: a.facts.locationId,
          },
        );
        if (!moved) throw syncProblem('invalid_integration_transition');
        await this.outbox.append(
          IntegrationStatusChanged.create(
            integrationId,
            0,
            {
              integrationId,
              shopId: a.shopId,
              from: existing.status,
              to: 'ACTIVE',
              reason: 'reconnected',
            },
            now,
          ),
        );
        return { kind: 'ok', integration: moved, created: false } as const;
      });
    } catch (error) {
      await this.discardWebhooks(
        a.provider,
        session,
        registered.subscriptions,
        existing === null,
      );
      if (
        (error as { name?: string })?.name === 'SequelizeUniqueConstraintError'
      )
        return { kind: 'store_already_connected' };
      throw error;
    }

    if (persisted.kind !== 'ok') {
      await this.discardWebhooks(
        a.provider,
        session,
        registered.subscriptions,
        existing === null,
      );
      return persisted;
    }

    // A reconnect starts from the beginning but keeps its links, so nothing is duplicated (AS-09).
    const reconnected = existing !== null && existing.status !== 'ACTIVE';
    if (reconnected) await this.cursors.reset(integrationId, PRODUCT_ENTITY);
    if (persisted.created || reconnected) {
      try {
        await this.queue.enqueue(INTEGRATION_BACKFILL_QUEUE, {
          integrationId,
          kind: 'backfill',
        });
      } catch (error) {
        // The row is due for a pull at once (`nextSyncAt`), so the scheduled job starts the import if this queue is down.
        this.logger.error({
          action: 'catalog-sync.backfill_not_queued',
          integrationId,
          shopId: a.shopId,
          error: (error as Error)?.name,
        });
      }
    }
    return persisted;
  }

  private async discardWebhooks(
    provider: ProviderName,
    session: ReturnType<ProviderSessions['forCredentials']>,
    subscriptions: Array<{ topic: string; id: string }>,
    ownedByThisAttempt: boolean,
  ): Promise<void> {
    if (!ownedByThisAttempt) return;
    try {
      await this.sessions
        .provider(provider)
        .deregisterWebhooks(session, subscriptions);
    } catch (error) {
      this.logger.warn({
        action: 'catalog-sync.webhook_cleanup_failed',
        provider,
        error: (error as Error)?.name,
      });
    }
  }
}
