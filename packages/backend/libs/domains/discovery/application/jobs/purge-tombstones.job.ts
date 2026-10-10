import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { InvalidScheduleError, JobsService } from '@app/infrastructure/jobs';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import {
  PRODUCT_INDEX,
  SHOP_SEARCH_REPOSITORY,
  type ProductIndexPort,
  type ShopSearchRepository,
} from '../../domain/ports';
import { SearchSettings } from '../../infra/search-settings';
import '../../infra/search.jobs';

const DAY_MS = 86_400_000;

/**
 * Daily: a delete is remembered for 30 days (FR-020) so a late older event cannot bring a product back; after that the
 * tombstone goes, in the public index and in the shop table. An event arriving then would be a new product.
 */
@Injectable()
export class PurgeTombstonesJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(PurgeTombstonesJob.name);

  constructor(
    private readonly jobs: JobsService,
    @Inject(PRODUCT_INDEX) private readonly index: ProductIndexPort,
    @Inject(SHOP_SEARCH_REPOSITORY)
    private readonly shopSearch: ShopSearchRepository,
    private readonly settings: SearchSettings,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.jobs.upsertSchedule({
        name: 'search.purge-tombstones',
        cron: '0 30 3 * * *',
        jobType: 'search.purge-tombstones',
        payload: {},
      });
    } catch (error) {
      if (!(error instanceof InvalidScheduleError)) throw error;
      this.logger.error(`schedule not registered: ${error.message}`);
    }
  }

  @JobHandler('search.purge-tombstones', {
    concurrency: 1,
    fleetConcurrency: 1,
  })
  async purge(): Promise<{ index: number; shopTable: number }> {
    const before = new Date(
      this.clock.now().getTime() -
        this.settings.tombstoneRetentionDays * DAY_MS,
    );
    const index = await this.index.purgeTombstones(before);
    const shopTable = await this.shopSearch.purgeTombstones(before);
    this.logger.log({ action: 'search.tombstones_purged', index, shopTable });
    return { index, shopTable };
  }
}
