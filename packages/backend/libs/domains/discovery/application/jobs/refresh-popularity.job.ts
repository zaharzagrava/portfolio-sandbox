import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { InvalidScheduleError, JobsService } from '@app/infrastructure/jobs';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { popularityBucket } from '../../domain/popularity-bucket';
import { popularityMutation } from '../../domain/index-document';
import { PRODUCT_INDEX, type ProductIndexPort } from '../../domain/ports';
import { SearchSettings } from '../../infra/search-settings';
import '../../infra/search.jobs';

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 30;
const PAGE = 1_000;

/**
 * Every 15 minutes: the damped popularity bucket of each product's result clicks over the last 30 days (FR-027). Only
 * documents whose bucket changed are written (and only the popularity fields, under their own `popularityAt` guard),
 * so a refresh never alters a product field or `productVersion`. A product whose clicks all aged out falls back to 0.
 * One run in the fleet (S49 `fleetConcurrency: 1`).
 */
@Injectable()
export class RefreshPopularityJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(RefreshPopularityJob.name);

  constructor(
    private readonly jobs: JobsService,
    @Inject(PRODUCT_INDEX) private readonly index: ProductIndexPort,
    private readonly clickhouse: ClickHouseService,
    private readonly settings: SearchSettings,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.jobs.upsertSchedule({
        name: 'search.refresh-popularity',
        cron: '0 */15 * * * *',
        jobType: 'search.refresh-popularity',
        payload: {},
      });
    } catch (error) {
      if (!(error instanceof InvalidScheduleError)) throw error;
      this.logger.error(`schedule not registered: ${error.message}`);
    }
  }

  @JobHandler('search.refresh-popularity', {
    concurrency: 1,
    fleetConcurrency: 1,
    leaseMs: 300_000,
  })
  async refresh(): Promise<{ examined: number; changed: number }> {
    const now = this.clock.now();
    const since = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
    const weights = this.settings.boostWeights;
    const buckets = new Map<string, number>();

    for (let offset = 0; ; offset += PAGE) {
      const rows = await this.clickhouse.query<{
        product_id: string;
        clicks: string;
      }>(
        `SELECT product_id, uniqExact(event_id) AS clicks FROM search_clicks
         WHERE ts >= {since:DateTime64(3, 'UTC')} AND ts <= {until:DateTime64(3, 'UTC')}
         GROUP BY product_id ORDER BY product_id LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
        {
          since: toClickHouseTime(since),
          until: toClickHouseTime(now),
          limit: PAGE,
          offset,
        },
      );
      for (const r of rows) buckets.set(r.product_id, popularityBucket(Number(r.clicks)));
      if (rows.length < PAGE) break;
    }

    // products that had a bucket and lost every click in the window decay to 0
    for (let after: string | null = null; ; ) {
      const ids = await this.index.popularProductIds(after, PAGE);
      for (const id of ids) if (!buckets.has(id)) buckets.set(id, 0);
      if (ids.length < PAGE) break;
      after = ids[ids.length - 1];
    }

    let changed = 0;
    const ids = [...buckets.keys()];
    for (let i = 0; i < ids.length; i += 500) {
      const outcomes = await this.index.mutate(
        ids.slice(i, i + 500).map((id) => ({
          id,
          mutation: popularityMutation({
            productId: id,
            bucket: buckets.get(id)!,
            at: now,
            weights,
          }),
        })),
      );
      for (const outcome of outcomes.values()) if (outcome === 'applied') changed++;
    }
    this.logger.log({ action: 'search.popularity_refreshed', examined: ids.length, changed });
    return { examined: ids.length, changed };
  }
}

const toClickHouseTime = (date: Date): string =>
  date.toISOString().replace('T', ' ').replace('Z', '');
