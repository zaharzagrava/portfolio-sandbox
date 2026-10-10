import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { PermanentError } from '@app/infrastructure/projections/errors';
import type {
  Projector,
  SinkCounts,
} from '@app/infrastructure/projections/projector';
import { SHOP_REPOSITORY, type ShopRepository } from '../domain/ports';
import { ShopPlanChanged, SubscriptionPlanChanged } from '../domain/events';
import { ShopTransactionRunner } from './shop-transaction';

/**
 * `billing.subscription_plan_changed` → `Shop.plan` (AS-73). The per-shop `version` is the guard: an older or equal
 * version changes nothing, so a duplicate or an out-of-order delivery is harmless. Lowering a plan removes nobody;
 * seats are only checked when a member or invite is added (FR-006).
 */
@Injectable()
export class ShopPlanConsumer implements Projector {
  readonly name = 'tenancy-shop-plan';
  readonly topics = [SubscriptionPlanChanged.topic];
  readonly idempotency = 'versionGuard' as const;
  readonly handles = [{ event: SubscriptionPlanChanged }];

  constructor(
    @Inject(SHOP_REPOSITORY) private readonly shops: ShopRepository,
    private readonly shopTx: ShopTransactionRunner,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly outbox: OutboxService,
  ) {}

  async project(events: EventEnvelope[]): Promise<SinkCounts> {
    const counts: SinkCounts = { applied: 0, duplicate: 0, stale: 0 };
    for (const raw of events) {
      let event: ReturnType<typeof SubscriptionPlanChanged.match>;
      try {
        event = SubscriptionPlanChanged.match(raw);
      } catch (error) {
        throw new PermanentError(
          `invalid ${raw.type} payload: ${(error as Error).message}`,
        );
      }
      if (!event) continue;
      const { shopId, plan, version } = event.payload;
      const changed = await this.shopTx.inShop(shopId, async () => {
        const shop = await this.shops.applyPlan(
          shopId,
          plan,
          version,
          this.clock.now(),
        );
        if (!shop) return false;
        await this.outbox.append([
          ShopPlanChanged.create(shopId, shop.shopVersion, {
            shopId,
            plan: shop.plan,
            shopVersion: shop.shopVersion,
          }),
        ]);
        return true;
      });
      if (changed) counts.applied++;
      else counts.stale++;
    }
    return counts;
  }
}
