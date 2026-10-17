import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { z } from 'zod';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';
import { InvalidScheduleError } from '@app/infrastructure/jobs/job-errors';
import { CrawlRetentionService } from '../application/crawl-retention.service';
import { CrawlSchedulerService } from '../application/crawl-scheduler.service';
import { SHUTDOWN_GRACE_MS } from '../application/crawl.constants';
import { CrawlService } from '../application/crawl.service';
import { CrawlerConfig } from '../application/crawler.config';
import { PAGE_ARCHIVE, FRONTIER } from '../domain/crawler-ports';
import type { FrontierPort, PageArchive } from '../domain/crawler-ports';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'crawler.schedule-due': Record<string, never>;
    'crawler.purge-targets': Record<string, never>;
  }
}

declareJobType({ name: 'crawler.schedule-due', contract: z.object({}) });
declareJobType({ name: 'crawler.purge-targets', contract: z.object({}) });

const IDLE_MS = 500;

/** `autoStart: false` leaves the fetch loops to the caller (a spec that drives the crawl by hand); `loops` overrides the configured count. */
export const CRAWLER_WORKER_OPTIONS = Symbol('S41_CRAWLER_WORKER_OPTIONS');
export interface CrawlerWorkerOptions {
  autoStart?: boolean;
  loops?: number;
}

/**
 * Fetch loops, the scheduler job and the purge job (apps/worker). N loops per instance run concurrently across
 * DIFFERENT hosts: the frontier leases a host to one loop at a time, fleet-wide. Stopping takes no new target, waits for
 * the in-flight ones up to 30 s, then abandons them and gives their hosts back (S41 FR-020).
 */
@Injectable()
export class CrawlerWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CrawlerWorker.name);
  private running = false;
  private loops: Promise<void>[] = [];
  private readonly inFlight = new Set<string>();
  constructor(
    private readonly crawl: CrawlService,
    private readonly scheduler: CrawlSchedulerService,
    private readonly retention: CrawlRetentionService,
    private readonly jobs: JobsService,
    private readonly config: CrawlerConfig,
    @Inject(PAGE_ARCHIVE) private readonly archive: PageArchive,
    @Inject(FRONTIER) private readonly frontier: FrontierPort,
    @Optional()
    @Inject(CRAWLER_WORKER_OPTIONS)
    private readonly options: CrawlerWorkerOptions = {},
  ) {}

  async onApplicationBootstrap() {
    try {
      await this.jobs.upsertSchedule({
        name: 'crawler.schedule-due',
        cron: '* * * * *',
        jobType: 'crawler.schedule-due',
        payload: {},
      });
      await this.jobs.upsertSchedule({
        name: 'crawler.purge-targets',
        cron: '30 3 * * *',
        jobType: 'crawler.purge-targets',
        payload: {},
      });
    } catch (error) {
      if (error instanceof InvalidScheduleError)
        this.logger.error(
          JSON.stringify({
            event: 'crawler_schedule_invalid',
            field: error.field,
          }),
        );
      throw error;
    }
    await this.archive.ensureLifecycle();
    if (this.options.autoStart !== false) this.start();
  }

  start() {
    if (this.running) return;
    this.running = true;
    const count = this.options.loops ?? this.config.settings.fetchLoops;
    this.loops = Array.from({ length: count }, () => this.loop());
  }

  /** Stops taking work; resolves when the loops ended or, after 30 s, when what is left was abandoned. */
  async stop(graceMs = SHUTDOWN_GRACE_MS) {
    this.running = false;
    let timer: NodeJS.Timeout | undefined;
    const done = Promise.all(this.loops).then(() => true);
    const expired = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), graceMs);
    });
    const finished = await Promise.race([done, expired]);
    clearTimeout(timer);
    if (!finished)
      for (const host of this.inFlight)
        await this.frontier
          .release(host, this.config.settings.minGapMs)
          .catch(() => undefined);
    this.loops = [];
  }

  onModuleDestroy() {
    return this.stop();
  }

  @JobHandler('crawler.schedule-due', { concurrency: 1 })
  scheduleDue() {
    return this.scheduler.scheduleDue();
  }

  @JobHandler('crawler.purge-targets', { concurrency: 1 })
  purge() {
    return this.retention.purge();
  }

  private async loop() {
    while (this.running) {
      let worked = false;
      try {
        worked = await this.crawl.crawlNext((host) => {
          this.inFlight.add(host);
          return () => this.inFlight.delete(host);
        });
      } catch (error) {
        this.logger.warn(
          JSON.stringify({
            event: 'fetch_loop_error',
            error: (error as Error).name,
          }),
        );
      }
      if (!worked) await new Promise((r) => setTimeout(r, IDLE_MS));
    }
  }
}
