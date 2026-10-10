import { Module } from '@nestjs/common';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { ClickHouseModule } from '@app/infrastructure/clickhouse/clickhouse.module';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { BackfillEmbeddingsJob } from './application/jobs/backfill-embeddings.job';
import { BackfillShopStateJob } from './application/jobs/backfill-shop-state.job';
import { ReindexJob } from './application/jobs/reindex.job';
import { RetirePreviousIndexJob } from './application/jobs/retire-previous-index.job';
import { HistoryReplayService } from './application/reindex/history-replay.service';
import { RunExecutorService } from './application/reindex/run-executor.service';
import { ProductProjectionService } from './application/projection/product-projection.service';
import { PurgeTombstonesJob } from './application/jobs/purge-tombstones.job';
import { RefreshPopularityJob } from './application/jobs/refresh-popularity.job';
import { SearchIndexModule } from './search-index.module';

/** The search jobs, hosted by `apps/worker` (replaces the reindex worker module; S32 US4, US5). */
@Module({
  imports: [
    SearchIndexModule,
    JobsModule,
    ClickHouseModule,
    EventsModule.forAggregates([
      { aggregateType: 'search', retention: 'full-history' },
    ]),
  ],
  providers: [
    ProductProjectionService,
    HistoryReplayService,
    RunExecutorService,
    ReindexJob,
    RetirePreviousIndexJob,
    PurgeTombstonesJob,
    RefreshPopularityJob,
    BackfillShopStateJob,
    BackfillEmbeddingsJob,
  ],
  exports: [
    RunExecutorService,
    ReindexJob,
    RetirePreviousIndexJob,
    PurgeTombstonesJob,
    RefreshPopularityJob,
    BackfillShopStateJob,
    BackfillEmbeddingsJob,
  ],
})
export class SearchWorkerModule {}
