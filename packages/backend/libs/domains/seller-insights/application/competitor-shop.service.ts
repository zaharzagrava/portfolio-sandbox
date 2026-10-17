import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import {
  COMPETITOR_SHOP_REPOSITORY,
  TARGET_REPOSITORY,
  WATCH_REPOSITORY,
  type CompetitorShopRepository,
  type TargetRepository,
  type WatchRepository,
} from '../domain/crawler-ports';

export type ShopApplyOutcome = 'applied' | 'stale';

/**
 * The shop read model and what follows from it (S41 FR-029 to FR-031, research D-09): plan and status copied from
 * tenancy events under a version guard, watches paused while the shop is not `ACTIVE`, watches erased with the shop or
 * the product. Every method is one transaction and safe to repeat.
 */
@Injectable()
export class CompetitorShopService {
  constructor(
    @Inject(COMPETITOR_SHOP_REPOSITORY)
    private readonly shops: CompetitorShopRepository,
    @Inject(WATCH_REPOSITORY) private readonly watches: WatchRepository,
    @Inject(TARGET_REPOSITORY) private readonly targets: TargetRepository,
    private readonly transactions: TransactionRunner,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  shopCreated(input: { shopId: string; plan: string; shopVersion: number }) {
    return this.apply(input.shopId, input.shopVersion, {
      plan: input.plan,
      status: 'ACTIVE',
    });
  }

  planChanged(input: { shopId: string; plan: string; shopVersion: number }) {
    return this.apply(input.shopId, input.shopVersion, { plan: input.plan });
  }

  statusChanged(input: { shopId: string; to: string; shopVersion: number }) {
    return this.apply(input.shopId, input.shopVersion, { status: input.to });
  }

  /** Erases the shop's watches and read-model row and retires the targets nobody watches any more. */
  shopDeleted(shopId: string): Promise<void> {
    return this.transactions.run(async () => {
      const targetIds = await this.watches.deleteByShop(shopId);
      await this.targets.retireUnwatched(targetIds, this.clock.now());
      await this.shops.remove(shopId);
    });
  }

  /** Deletes the watches of a deleted product; a product nobody watched is acknowledged without effect. */
  productDeleted(productId: string): Promise<number> {
    return this.transactions.run(async () => {
      const targetIds = await this.watches.deleteByProduct(productId);
      await this.targets.retireUnwatched(targetIds, this.clock.now());
      return targetIds.length;
    });
  }

  private apply(
    shopId: string,
    version: number,
    change: { plan?: string; status?: string },
  ): Promise<ShopApplyOutcome> {
    return this.transactions.run(async () => {
      const now = this.clock.now();
      const current = await this.shops.find(shopId, true);
      if (!current) {
        await this.shops.upsert(
          {
            shopId,
            plan: change.plan ?? null,
            status: change.status ?? 'ACTIVE',
            version,
          },
          now,
        );
        await this.syncWatches(shopId, change.status ?? 'ACTIVE');
        return 'applied';
      }
      if (version > current.version) {
        const status = change.status ?? current.status;
        await this.shops.upsert(
          { shopId, plan: change.plan ?? current.plan, status, version },
          now,
        );
        if (status !== current.status) await this.syncWatches(shopId, status);
        return 'applied';
      }
      // an older or repeated version changes nothing, except that it may be the first word on the plan
      if (current.plan === null && change.plan !== undefined) {
        await this.shops.upsert({ ...current, plan: change.plan }, now);
        return 'applied';
      }
      return 'stale';
    });
  }

  private async syncWatches(shopId: string, status: string): Promise<void> {
    await this.watches.setStatusForShop(
      shopId,
      status === 'ACTIVE' ? 'ACTIVE' : 'PAUSED',
    );
  }
}
