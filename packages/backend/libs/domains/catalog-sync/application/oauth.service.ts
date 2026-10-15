import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { IntegrationInstallResponse } from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { syncProblem } from '../domain/catalog-sync-errors';
import { validateShopifyDomain } from '../domain/store-address';
import {
  INSTALL_REPOSITORY,
  PROVIDER_SESSIONS,
  SYNC_CLOCK,
  type Clock,
  type InstallRepository,
  type ProviderSessions,
} from '../domain/ports';
import { ConnectService } from './connect.service';

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

/** Where the browser lands after the callback: the web app's integrations page. */
export interface CallbackRedirect {
  location: string;
}

/**
 * Shopify OAuth install flow (FR-001, AS-01 - AS-05). The `state` is 128 random bits, bound to shop, member and domain,
 * kept only as a SHA-256 digest, valid 10 minutes and consumed by one conditional update, so a replay or a race has
 * exactly one winner. Every verification failure is the same `400`; the cause is only logged.
 */
@Injectable()
export class OAuthService {
  private readonly logger = new Logger(OAuthService.name);

  constructor(
    private readonly config: ApiConfigService,
    private readonly connect: ConnectService,
    @Inject(INSTALL_REPOSITORY) private readonly installs: InstallRepository,
    @Inject(PROVIDER_SESSIONS) private readonly sessions: ProviderSessions,
    @Inject(SYNC_CLOCK) private readonly clock: Clock,
  ) {}

  async startInstall(
    shopId: string,
    userId: string,
    shopDomainInput: string,
  ): Promise<IntegrationInstallResponse> {
    const domain = validateShopifyDomain(shopDomainInput);
    if (!domain.ok) throw syncProblem('invalid_store_url');
    const state = randomBytes(24).toString('base64url');
    const now = this.clock.now();
    const install = await this.installs.create(
      { shopId, userId, shopDomain: domain.domain, stateDigest: sha256(state) },
      now,
    );
    const authorizeUrl = this.sessions.provider('shopify').buildAuthorizeUrl!({
      shopDomain: domain.domain,
      state,
      redirectUri: `${this.base()}/api/integrations/shopify/callback`,
    });
    return { authorizeUrl, expiresAt: install.expiresAt.toISOString() };
  }

  async handleCallback(
    rawQuery: Record<string, unknown>,
  ): Promise<CallbackRedirect> {
    const reject = (cause: string): never => {
      this.logger.warn({
        action: 'catalog-sync.oauth_callback_refused',
        reason: cause,
      });
      throw syncProblem('invalid_oauth_callback');
    };
    const now = this.clock.now();

    const query: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawQuery)) {
      if (typeof value !== 'string') return reject('non_string_parameter');
      query[key] = value;
    }
    const verified = this.sessions.provider('shopify').verifyCallback!(
      query,
      now,
    );
    if (!verified) return reject('signature_or_timestamp');

    const install = await this.installs.consume(sha256(verified.state), now);
    if (!install) return reject('state_unknown_expired_or_used');
    if (install.shopDomain !== verified.shop)
      return reject('shop_differs_from_install');

    const result = await this.connect.completeShopify({
      shopId: install.shopId,
      userId: install.userId,
      shopDomain: verified.shop,
      code: verified.code,
    });
    return {
      location:
        result.kind === 'connected'
          ? this.integrationsPage(
              `connected=${encodeURIComponent(result.integrationId)}`,
            )
          : this.integrationsPage(`error=${result.error}`),
    };
  }

  private integrationsPage(query: string): string {
    return `${this.config.get('front_host').replace(/\/+$/, '')}/dashboard/integrations?${query}`;
  }

  private base(): string {
    return this.config.get('backend_host').replace(/\/+$/, '');
  }
}
