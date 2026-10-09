import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import ShopSsoConfig from '../infra/models/shop-sso-config.model';
import { SecretBox, OidcService } from '@app/domains/identity';
import { ShopTransactionRunner } from '../infra/shop-transaction';

/**
 * Enterprise SSO per shop (lesson 10/04 #2): a shop's staff log in through
 * their company IdP via `/api/auth/oidc/shop:<shopId>/start`. Configs are
 * loaded lazily into OidcService the first time a provider name is used.
 */
@Injectable()
export class ShopSsoService implements OnModuleInit {
  constructor(
    @InjectModel(ShopSsoConfig) private readonly ssoModel: typeof ShopSsoConfig,
    private readonly box: SecretBox,
    private readonly oidc: OidcService,
    private readonly shopTx: ShopTransactionRunner,
  ) {}

  onModuleInit() {
    this.oidc.setResolver(async (provider) => {
      const match = /^shop:([0-9a-f-]{36})$/.exec(provider);
      if (!match) return undefined;
      const config = await this.shopTx.inShop(match[1], () =>
        this.ssoModel.findByPk(match[1]),
      );
      if (!config?.enabled) return undefined;
      return {
        issuer: config.issuer,
        clientId: config.clientId,
        clientSecret: this.box.open(config.clientSecretEnc),
      };
    });
  }

  async configure(
    shopId: string,
    issuer: string,
    clientId: string,
    clientSecret: string,
  ) {
    await this.shopTx.inShop(shopId, () =>
      this.ssoModel.upsert({
        shopId,
        issuer,
        clientId,
        clientSecretEnc: this.box.seal(clientSecret),
        enabled: true,
      }),
    );
    // Drop any cached discovery so the next login uses the new settings.
    this.oidc.register(`shop:${shopId}`, { issuer, clientId, clientSecret });
    return { loginUrl: `/api/auth/oidc/shop:${shopId}/start` };
  }
}
