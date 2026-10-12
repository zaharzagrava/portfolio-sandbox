import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { afterCommit } from '@app/infrastructure/context';
import { SecretBox, OidcProviderRegistry } from '@app/domains/identity';
import {
  OIDC_DISCOVERY,
  SHOP_REPOSITORY,
  SSO_CONFIG_REPOSITORY,
  TENANT_TRANSACTIONS,
  type OidcDiscovery,
  type ShopRepository,
  type SsoConfigRecord,
  type SsoConfigRepository,
  type TenantTransactions,
} from '../domain/ports';
import {
  Domain_InvalidQueryError,
  Domain_ShopNotFoundError,
  Domain_SsoNotConfiguredError,
} from '../domain/errors';
import { TenancyAudit } from './tenancy-observability';

const UUID_PROVIDER =
  /^shop:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const context = (shopId: string) => `shop-sso:${shopId}`;

export interface SsoInput {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  defaultRole?: 'STAFF' | 'VIEWER';
}

/**
 * Enterprise SSO per shop (FR-040 to FR-043): a shop's staff sign in through their company IdP via
 * `/api/auth/oidc/shop:<shopId>/start`. This service owns the configuration and the `shop:` resolver of identity's
 * `OidcProviderRegistry`. The provider is checked (SSRF guard, discovery, issuer) before any transaction opens; the
 * secret is sealed with the shop as context and handed to the registry in plain form only at resolve time.
 */
@Injectable()
export class ShopSsoService implements OnModuleInit {
  constructor(
    @Inject(SSO_CONFIG_REPOSITORY)
    private readonly configs: SsoConfigRepository,
    @Inject(SHOP_REPOSITORY) private readonly shops: ShopRepository,
    @Inject(OIDC_DISCOVERY) private readonly discovery: OidcDiscovery,
    @Inject(TENANT_TRANSACTIONS) private readonly shopTx: TenantTransactions,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly box: SecretBox,
    private readonly registry: OidcProviderRegistry,
    private readonly audit: TenancyAudit,
  ) {}

  onModuleInit() {
    this.registry.registerResolver('shop:', async (provider) => {
      const shopId = UUID_PROVIDER.exec(provider)?.[1];
      if (!shopId) return undefined;
      const found = await this.shopTx.inShop(shopId, async () => {
        const config = await this.configs.find(shopId);
        if (!config?.enabled) return null;
        const shop = await this.shops.findById(shopId);
        if (!shop || shop.status !== 'ACTIVE' || shop.sandboxOf) return null;
        return config;
      });
      if (!found) return undefined;
      return {
        issuer: found.issuer,
        clientId: found.clientId,
        clientSecret: this.openSecret(shopId, found.clientSecretEnc),
      };
    });
  }

  /**
   * Public lookup for the sign-in page (FR-043): only `{providerId, displayName}`, and the same not-found for an
   * unknown slug, a missing or disabled configuration and a shop that is not active.
   */
  async publicLookup(slug: string) {
    const shop = await this.shops.findBySlug(slug);
    if (!shop || shop.status !== 'ACTIVE' || shop.sandboxOf)
      throw new Domain_ShopNotFoundError();
    const config = await this.shopTx.inShop(shop.id, () =>
      this.configs.find(shop.id),
    );
    if (!config?.enabled) throw new Domain_ShopNotFoundError();
    return { providerId: `shop:${shop.id}`, displayName: shop.name };
  }

  async get(shopId: string) {
    const config = await this.shopTx.inShop(shopId, () =>
      this.configs.find(shopId),
    );
    if (!config) throw new Domain_SsoNotConfiguredError();
    return this.toDto(config);
  }

  async configure(shopId: string, actorId: string, input: SsoInput) {
    // Network first, no transaction open (III.3).
    await this.discovery.verify(input.issuer);
    const record = await this.shopTx.inShop(
      shopId,
      async () => {
        const existing = await this.configs.find(shopId);
        let sealed: string;
        if (input.clientSecret !== undefined)
          sealed = this.box.seal(input.clientSecret, context(shopId));
        else if (existing)
          sealed = this.box.seal(
            this.openSecret(shopId, existing.clientSecretEnc),
            context(shopId),
          );
        else throw new Domain_InvalidQueryError('clientSecret', 'required');
        const saved = await this.configs.upsert({
          shopId,
          issuer: input.issuer,
          clientId: input.clientId,
          clientSecretEnc: sealed,
          defaultRole: input.defaultRole ?? existing?.defaultRole ?? 'VIEWER',
          now: this.clock.now(),
        });
        this.forgetAfterCommit(shopId);
        return saved;
      },
      { userId: actorId },
    );
    this.audit.record('sso.configured', { shopId, actorId });
    return this.toDto(record);
  }

  /** The row is deleted, not flagged, so no secret remains (FR-041). Repeating is a success. */
  async remove(shopId: string, actorId: string): Promise<void> {
    const removed = await this.shopTx.inShop(
      shopId,
      async () => {
        const gone = await this.configs.delete(shopId);
        if (gone) this.forgetAfterCommit(shopId);
        return gone;
      },
      { userId: actorId },
    );
    if (removed) this.audit.record('sso.removed', { shopId, actorId });
  }

  /**
   * One idempotent batch of the re-seal step (Risk 5): secrets sealed without a context are re-sealed bound to their
   * shop. Returns how many rows were changed; zero means done.
   */
  async resealLegacySecrets(batch = 200): Promise<number> {
    const legacy = await this.shopTx.crossTenant('legacy.provision', () =>
      this.configs.listLegacySealed(batch),
    );
    let changed = 0;
    for (const config of legacy) {
      const resealed = this.box.seal(
        this.box.open(config.clientSecretEnc),
        context(config.shopId),
      );
      const done = await this.shopTx.inShop(config.shopId, () =>
        this.configs.replaceSealed(
          config.shopId,
          config.clientSecretEnc,
          resealed,
        ),
      );
      if (done) changed++;
    }
    return changed;
  }

  /** Whatever the registry cached about this provider is dropped once the change is committed. */
  private forgetAfterCommit(shopId: string): void {
    afterCommit(() => this.registry.invalidate(`shop:${shopId}`));
  }

  /** Context-less values (`v1.`) are opened as before until the re-seal step has bound them to their shop. */
  private openSecret(shopId: string, sealed: string): string {
    return sealed.startsWith('v1.')
      ? this.box.open(sealed)
      : this.box.open(sealed, context(shopId));
  }

  private toDto(config: SsoConfigRecord) {
    return {
      providerId: `shop:${config.shopId}`,
      issuer: config.issuer,
      clientId: config.clientId,
      secretSet: true as const,
      defaultRole: config.defaultRole,
      enabled: config.enabled,
      updatedAt: new Date(config.updatedAt).toISOString(),
    };
  }
}
