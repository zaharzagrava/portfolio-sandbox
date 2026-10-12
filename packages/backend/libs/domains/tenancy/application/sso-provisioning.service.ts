import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import {
  INVITE_REPOSITORY,
  MEMBERSHIP_REPOSITORY,
  SHOP_REPOSITORY,
  SSO_CONFIG_REPOSITORY,
  TENANT_TRANSACTIONS,
  type InviteRepository,
  type MembershipRepository,
  type ShopRepository,
  type SsoConfigRepository,
  type TenantTransactions,
} from '../domain/ports';
import { MemberAdded } from '../domain/events';
import { hasFreeSeat } from '../domain/seat-policy';
import { provisionedCounter } from '../domain/tenancy-metrics';
import { ShopAccessService } from './shop-access.service';

const SHOP_PROVIDER =
  /^shop:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export type ProvisionOutcome =
  'provisioned' | 'existing' | 'ignored' | 'denied';

/**
 * Membership for a user who signed in through a shop's company provider (FR-042): added once, with the provider's
 * default role and `source: 'sso'`. Anything else (another provider, SSO off, shop not active, no free seat) changes
 * nothing and is counted by reason. A member who exists keeps their role; a removed member is not re-added by a
 * redelivery because the inbox remembers the event (AS-49).
 */
@Injectable()
export class SsoProvisioningService {
  constructor(
    @Inject(SHOP_REPOSITORY) private readonly shops: ShopRepository,
    @Inject(MEMBERSHIP_REPOSITORY)
    private readonly members: MembershipRepository,
    @Inject(INVITE_REPOSITORY) private readonly invites: InviteRepository,
    @Inject(SSO_CONFIG_REPOSITORY)
    private readonly configs: SsoConfigRepository,
    @Inject(TENANT_TRANSACTIONS) private readonly shopTx: TenantTransactions,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly outbox: OutboxService,
    private readonly access: ShopAccessService,
  ) {}

  async provision(userId: string, provider: string): Promise<ProvisionOutcome> {
    const shopId = SHOP_PROVIDER.exec(provider)?.[1];
    if (!shopId) return this.count('sso_ignored', 'ignored');

    return this.shopTx.crossTenant('sso.provision', async () => {
      // The shop row serialises seat counting with invites and other provisioning.
      const shop = await this.shops.lockById(shopId);
      if (!shop || shop.sandboxOf) return this.count('sso_ignored', 'ignored');
      const config = await this.configs.find(shopId);
      if (!config?.enabled)
        return this.count('sso_denied_not_enabled', 'denied');
      if (shop.status !== 'ACTIVE')
        return this.count('sso_denied_status', 'denied');
      if (await this.members.find(shopId, userId))
        return this.count('sso_existing', 'existing');

      const now = this.clock.now();
      const seatsUsed = await this.members.count(shopId);
      const seatsHeld = await this.invites.countPending(shopId, now);
      if (!hasFreeSeat(shop.plan, seatsUsed, seatsHeld))
        return this.count('sso_denied_seats', 'denied');

      const inserted = await this.members.insert({
        shopId,
        userId,
        role: config.defaultRole,
        source: 'sso',
        now,
      });
      if (!inserted) return this.count('sso_existing', 'existing');
      await this.outbox.append(
        MemberAdded.create(shopId, shop.shopVersion, {
          shopId,
          userId,
          role: config.defaultRole,
          source: 'sso',
        }),
      );
      this.access.invalidateAfterCommit(shopId, userId);
      return this.count('sso_provisioned', 'provisioned');
    });
  }

  private count(outcome: string, result: ProvisionOutcome): ProvisionOutcome {
    provisionedCounter.add(1, { outcome });
    return result;
  }
}
