import { Module } from '@nestjs/common';
import { ProductQueryModule } from '@app/domains/catalog';
import { TenancyModule } from '@app/domains/tenancy';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { CrawlRetentionService } from './application/crawl-retention.service';
import { CrawlSchedulerService } from './application/crawl-scheduler.service';
import { CrawlService } from './application/crawl.service';
import { CompetitorEvaluationModule } from './competitor-evaluation.module';
import { CompetitorStoresModule } from './competitor-stores.module';
import { CRAWLER_WORKER_OPTIONS, CrawlerWorker } from './infra/crawler.worker';

/**
 * Scheduler, fetch loops and purge (apps/worker, S41 D-01). N fetchers per instance run concurrently across DIFFERENT
 * hosts; politeness holds fleet-wide because the host lease lives in Redis. The worker loads the catalog and tenancy
 * services (R1) that the evaluation of an observation needs (FR-028).
 */
@Module({
  imports: [
    ClockModule,
    JobsModule,
    CompetitorStoresModule,
    CompetitorEvaluationModule,
    ProductQueryModule,
    TenancyModule,
  ],
  providers: [
    CrawlService,
    CrawlSchedulerService,
    CrawlRetentionService,
    { provide: CRAWLER_WORKER_OPTIONS, useValue: {} },
    CrawlerWorker,
  ],
})
export class CrawlerWorkerModule {}
