import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { JobsService } from '@app/infrastructure/jobs';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { ShopQueryService } from '@app/domains/tenancy';
import {
  PRODUCT_INDEX,
  SHOP_STATE_REPOSITORY,
  type ProductIndexPort,
  type ShopStateRepository,
} from '../../domain/ports';
import { stampOf } from '../projection/projection-support';
import '../../infra/search.jobs';

const BATCH = 500;

/**
 * Asks tenancy (R1 `getShopsByIds`, at most 500 ids per call) for the state of every shop that has documents in the
 * index, stores `{status, plan, shopVersion}` in the copy under the version guard and stamps the documents (S32 AS-38).
 * One page per run; a run enqueues the next page with the cursor, so the job is resumable and a rerun changes nothing
 * (an equal `shopVersion` is a duplicate). A shop tenancy does not know stays as it is: visible, neutral tier.
 */
@Injectable()
export class BackfillShopStateJob {
  private readonly logger = new Logger(BackfillShopStateJob.name);

  constructor(
    @Inject(PRODUCT_INDEX) private readonly index: ProductIndexPort,
    @Inject(SHOP_STATE_REPOSITORY) private readonly shops: ShopStateRepository,
    private readonly tenancy: ShopQueryService,
    private readonly jobs: JobsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @JobHandler('search.backfill-shop-state', {
    concurrency: 1,
    fleetConcurrency: 1,
    leaseMs: 120_000,
  })
  async run({ cursor }: { cursor?: string }): Promise<{ shops: number; applied: number }> {
    const shopIds = await this.index.distinctShopIds(cursor ?? null, BATCH);
    if (shopIds.length === 0) return { shops: 0, applied: 0 };
    const summaries = await this.tenancy.getShopsByIds(shopIds);
    let applied = 0;
    for (const shopId of shopIds) {
      const summary = summaries.get(shopId);
      if (!summary) continue;
      const { outcome, record } = await this.shops.apply({
        shopId,
        status: summary.status as 'ACTIVE' | 'SUSPENDED' | 'DELETING' | 'DELETED',
        plan: summary.plan as 'STARTER' | 'PRO' | 'ENTERPRISE',
        shopVersion: summary.shopVersion,
        occurredAt: this.clock.now(),
      });
      if (outcome !== 'applied') continue;
      applied++;
      if (record.status === 'DELETED') await this.index.purgeShop(shopId);
      else await this.index.stampShop(shopId, stampOf(record));
    }
    if (shopIds.length === BATCH) {
      const next = shopIds[shopIds.length - 1];
      await this.jobs.enqueue(
        'search.backfill-shop-state',
        { cursor: next },
        { idempotencyKey: `search.backfill-shop-state:${next}` },
      );
    }
    this.logger.log({ action: 'search.shop_state_backfilled', shops: shopIds.length, applied });
    return { shops: shopIds.length, applied };
  }
}
