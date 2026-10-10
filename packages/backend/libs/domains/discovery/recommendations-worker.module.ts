import { Module } from '@nestjs/common';
import { ApiConfigModule } from '@app/common/config';
import { ClickHouseModule } from '@app/infrastructure/clickhouse/clickhouse.module';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { CoOccurrenceBuildService } from './application/co-occurrence-build.service';
import {
  BASKET_STORE,
  BUILD_LOCK,
  NEIGHBOUR_LIST_WRITER,
  RECOMMENDATIONS_CLOCK,
} from './domain/recommendation-ports';
import { ClickhouseBasketStoreAdapter } from './infra/clickhouse-basket-store.adapter';
import { CoOccurrenceJobs } from './infra/co-occurrence.jobs';
import { RedisBuildLockAdapter } from './infra/redis-build-lock.adapter';
import { RedisNeighbourListsAdapter } from './infra/redis-neighbour-lists.adapter';
import { RecommendationsSettings } from './infra/recommendations-config';
import { SystemRecommendationsClock } from './infra/recommendations-clock';

/** S34 nightly build (apps/worker). Exports nothing: the job handler is discovered by the job worker. */
@Module({
  imports: [ApiConfigModule, ClickHouseModule, ClockModule, JobsModule],
  providers: [
    RecommendationsSettings,
    CoOccurrenceBuildService,
    CoOccurrenceJobs,
    { provide: BASKET_STORE, useClass: ClickhouseBasketStoreAdapter },
    { provide: NEIGHBOUR_LIST_WRITER, useClass: RedisNeighbourListsAdapter },
    { provide: BUILD_LOCK, useClass: RedisBuildLockAdapter },
    { provide: RECOMMENDATIONS_CLOCK, useClass: SystemRecommendationsClock },
  ],
})
export class RecommendationsWorkerModule {}
