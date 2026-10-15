import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { z } from 'zod';
import {
  InvalidScheduleError,
  JobsService,
  declareJobType,
} from '@app/infrastructure/jobs';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { nextDueAt } from '../domain/schedule';
import { LagMonitorService } from '../application/lag-monitor.service';
import {
  RetentionService,
  type RetentionResult,
} from '../application/retention.service';
import {
  INTEGRATION_BACKFILL_QUEUE,
  INTEGRATION_REPOSITORY,
  INTEGRATION_SYNC_QUEUE,
  SHOP_STATUS_GATEWAY,
  SYNC_CLOCK,
  SYNC_QUEUE,
  type Clock,
  type IntegrationRepository,
  type ShopStatusGateway,
  type SyncQueue,
} from '../domain/ports';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'catalog-sync.sync-all': Record<string, never>;
    'catalog-sync.reconcile-all': Record<string, never>;
    'catalog-sync.purge-integration-data': Record<string, never>;
  }
}

for (const name of [
  'catalog-sync.sync-all',
  'catalog-sync.reconcile-all',
  'catalog-sync.purge-integration-data',
] as const)
  declareJobType({ name, contract: z.object({}).strict() });

/** Integrations examined per pass; the rest is picked up by the next pass (every 5 minutes). */
export const DUE_BATCH = 500;

/** Schedules of the old names, replaced by the `catalog-sync.*` ones (S49 follow-up). */
const RENAMED_SCHEDULES = [
  'integrations.sync-all',
  'integrations.reconcile-all',
] as const;

/**
 * The recurring jobs of the capability (run in apps/worker). `JobsService.cancel` is deliberately never called: a pull
 * is cancelled by the integration leaving `ACTIVE` (the engine acknowledges the message and does nothing), not by
 * cancelling queued work.
 */
@Injectable()
export class IntegrationsJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(IntegrationsJobs.name);

  constructor(
    private readonly jobs: JobsService,
    @Inject(INTEGRATION_REPOSITORY)
    private readonly integrations: IntegrationRepository,
    @Inject(SHOP_STATUS_GATEWAY) private readonly shops: ShopStatusGateway,
    @Inject(SYNC_QUEUE) private readonly queue: SyncQueue,
    @Inject(SYNC_CLOCK) private readonly clock: Clock,
    private readonly lag: LagMonitorService,
    private readonly retention: RetentionService,
  ) {}

  /**
   * An invalid schedule is a programming error: it is not swallowed, so the worker fails to start (fail fast) instead of
   * running without the guarantee that webhooks are only an optimisation.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.jobs.upsertSchedule({
        name: 'catalog-sync.sync-all',
        cron: '0 */5 * * * *',
        jobType: 'catalog-sync.sync-all',
        payload: {},
      });
      await this.jobs.upsertSchedule({
        name: 'catalog-sync.reconcile-all',
        cron: '0 40 3 * * *',
        jobType: 'catalog-sync.reconcile-all',
        payload: {},
      });
      await this.jobs.upsertSchedule({
        name: 'catalog-sync.purge-integration-data',
        cron: '0 20 4 * * *',
        jobType: 'catalog-sync.purge-integration-data',
        payload: {},
      });
    } catch (error) {
      if (error instanceof InvalidScheduleError)
        throw new Error(`catalog-sync schedule is invalid: ${error.message}`, {
          cause: error,
        });
      throw error;
    }
    for (const old of RENAMED_SCHEDULES) await this.jobs.removeSchedule(old);
  }

  /**
   * Enqueues an incremental pull for every due, `ACTIVE` integration of an `ACTIVE` shop whose breaker is not open, and
   * moves its next-due time by 5 minutes plus its jitter. The next-due move is the dedupe: a second pass at the same
   * instant finds nothing due. The message goes first, so a failed enqueue leaves the integration due for the next pass.
   */
  @JobHandler('catalog-sync.sync-all', { concurrency: 1, fleetConcurrency: 1 })
  async syncAll(): Promise<{ enqueued: number; skipped: number }> {
    // The lag check rides on this pass (every 5 minutes); its failure never blocks the pulls.
    await this.lag.evaluate().catch((error) =>
      this.logger.warn({
        action: 'catalog-sync.lag_evaluation_failed',
        error: error instanceof Error ? error.name : 'error',
      }),
    );
    const now = this.clock.now();
    const due = await this.integrations.dueForSync(now, DUE_BATCH);
    if (due.length === 0) return { enqueued: 0, skipped: 0 };
    const shopStatuses = await this.shops.getStatuses([
      ...new Set(due.map((d) => d.shopId)),
    ]);
    let enqueued = 0;
    let skipped = 0;
    for (const item of due) {
      const shop = shopStatuses.get(item.shopId);
      const breakerOpen =
        item.breakerOpenUntil !== null && item.breakerOpenUntil > now;
      if (!shop || shop.status !== 'ACTIVE' || breakerOpen) {
        skipped++;
        continue;
      }
      try {
        await this.queue.enqueue(INTEGRATION_SYNC_QUEUE, {
          integrationId: item.id,
          kind: 'incremental',
        });
        await this.integrations.setNextSync(item.id, nextDueAt(now, item.id));
        enqueued++;
      } catch (error) {
        skipped++;
        this.logger.warn({
          action: 'catalog-sync.enqueue_failed',
          integrationId: item.id,
          shopId: item.shopId,
          error: error instanceof Error ? error.name : 'error',
        });
      }
    }
    this.logger.log({ action: 'catalog-sync.sync_all', enqueued, skipped });
    return { enqueued, skipped };
  }

  /**
   * Nightly: one `reconcile` message on the backfill queue for every ACTIVE integration of an ACTIVE shop (A36: no
   * inline work for all stores in one job, so one slow store blocks nobody). The message is idempotent: a second pass
   * that day just runs another comparison.
   */
  @JobHandler('catalog-sync.reconcile-all', {
    concurrency: 1,
    fleetConcurrency: 1,
  })
  async reconcileAll(): Promise<{ enqueued: number }> {
    let enqueued = 0;
    let after: string | null = null;
    for (;;) {
      const page = await this.integrations.listActive(after, DUE_BATCH);
      if (page.length === 0) break;
      after = page[page.length - 1].id;
      const shopStatuses = await this.shops.getStatuses([
        ...new Set(page.map((p) => p.shopId)),
      ]);
      for (const item of page) {
        if (shopStatuses.get(item.shopId)?.status !== 'ACTIVE') continue;
        try {
          await this.queue.enqueue(INTEGRATION_BACKFILL_QUEUE, {
            integrationId: item.id,
            kind: 'reconcile',
          });
          enqueued++;
        } catch (error) {
          this.logger.warn({
            action: 'catalog-sync.enqueue_failed',
            integrationId: item.id,
            shopId: item.shopId,
            error: error instanceof Error ? error.name : 'error',
          });
        }
      }
    }
    this.logger.log({ action: 'catalog-sync.reconcile_all', enqueued });
    return { enqueued };
  }

  /** Retention of operational data (receipts, runs, closed items, installs, reports; AS-76). */
  @JobHandler('catalog-sync.purge-integration-data', {
    concurrency: 1,
    fleetConcurrency: 1,
  })
  purgeIntegrationData(): Promise<RetentionResult> {
    return this.retention.run();
  }
}
