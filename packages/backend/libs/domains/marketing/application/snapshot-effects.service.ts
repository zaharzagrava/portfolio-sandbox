import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import {
  CAMPAIGN_STORE,
  PRODUCT_SNAPSHOT_STORE,
  SHOP_SNAPSHOT_STORE,
  type CampaignRecord,
  type CampaignStore,
  type ProductSnapshot,
  type ProductSnapshotStore,
  type ShopSnapshot,
  type ShopSnapshotStore,
} from '../domain/ads-ports';
import { COMMAND_TX } from './campaign-command.service';
import { CampaignLifecycleService } from './campaign-lifecycle.service';

/**
 * What a product or shop event does here (US9, FR-060 to FR-062, R-5). Each call is ONE transaction: the version-guarded
 * snapshot upsert, the effect on the campaigns it names and the outbox rows of those transitions commit together. A
 * duplicate or older event changes nothing (no snapshot write, no effect). Archive pauses an active campaign, restore never
 * resumes one, delete ends the product's campaigns, an out-of-stock product only stops being served; a deleted shop ends
 * all its campaigns (billing runs and adjustments stay as financial records). Returns `true` when the event was applied.
 */
@Injectable()
export class SnapshotEffectsService {
  constructor(
    @Inject(CAMPAIGN_STORE) private readonly campaigns: CampaignStore,
    @Inject(PRODUCT_SNAPSHOT_STORE)
    private readonly productSnapshots: ProductSnapshotStore,
    @Inject(SHOP_SNAPSHOT_STORE)
    private readonly shopSnapshots: ShopSnapshotStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly transactions: TransactionRunner,
    private readonly lifecycle: CampaignLifecycleService,
  ) {}

  applyProduct(snapshot: ProductSnapshot): Promise<boolean> {
    return this.transactions.run(async () => {
      if (
        !(await this.productSnapshots.upsertIfNewer(snapshot, this.clock.now()))
      )
        return false;
      if (snapshot.status === 'ARCHIVED')
        await this.pauseActive(snapshot.productId);
      if (snapshot.status === 'DELETED')
        await this.endAll(
          await this.campaigns.openByProduct(snapshot.productId),
          'product_deleted',
          'product_unavailable',
        );
      return true;
    }, COMMAND_TX);
  }

  applyProductDeleted(input: {
    productId: string;
    shopId: string;
    productVersion: number;
  }): Promise<boolean> {
    return this.transactions.run(async () => {
      const existing = await this.productSnapshots.find(input.productId);
      const applied = await this.productSnapshots.upsertIfNewer(
        {
          productId: input.productId,
          shopId: input.shopId,
          title: existing?.title ?? '',
          category: existing?.category ?? '',
          priceMinor: existing?.priceMinor ?? 0,
          currency: existing?.currency ?? 'EUR',
          inStock: false,
          status: 'DELETED',
          isSandbox: existing?.isSandbox ?? false,
          productVersion: input.productVersion,
        },
        this.clock.now(),
      );
      if (!applied) return false;
      await this.endAll(
        await this.campaigns.openByProduct(input.productId),
        'product_deleted',
        'product_unavailable',
      );
      return true;
    }, COMMAND_TX);
  }

  applyShop(snapshot: ShopSnapshot): Promise<boolean> {
    return this.transactions.run(async () => {
      if (!(await this.shopSnapshots.upsertIfNewer(snapshot, this.clock.now())))
        return false;
      if (snapshot.deleted)
        await this.endAll(
          await this.campaigns.openByShop(snapshot.shopId),
          'shop_deleted',
          'seller',
        );
      return true;
    }, COMMAND_TX);
  }

  private async pauseActive(productId: string): Promise<void> {
    for (const campaign of await this.campaigns.openByProduct(productId))
      if (campaign.status === 'ACTIVE')
        await this.lifecycle.apply(campaign, 'pause', {
          actorId: null,
          reason: 'product_archived',
          statusReason: 'product_unavailable',
        });
  }

  private async endAll(
    open: CampaignRecord[],
    reason: string,
    statusReason: 'seller' | 'product_unavailable',
  ): Promise<void> {
    for (const campaign of open)
      await this.lifecycle.apply(campaign, 'end', {
        actorId: null,
        reason,
        statusReason,
      });
  }
}
